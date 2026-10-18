import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { ApiService } from '../../core/api/api.service';
import { ApiError } from '../../core/api/api-error';
import {
  Attachment,
  ChannelEvent,
  EventPage,
  Message,
  MessagePage,
  PinEventPayload,
  ReactionEventPayload,
  UnreadRow,
  seqCmp,
  seqMax,
  seqNext,
} from '../../core/api/models';
import { SessionService } from '../../core/auth/session.service';
import { RealtimeService } from '../../core/realtime/realtime.service';
import { ToastService } from '../../core/ui/toast.service';
import { ChannelBadges } from '../shell/channel-badges.service';
import { WorkspaceStore } from '../workspaces/workspace.store';

export type PendingState = 'sending' | 'failed';

/** A message as rendered: server-confirmed, or an optimistic send keyed by clientMessageId. */
export interface ChatMessage extends Message {
  pending?: PendingState;
}

export interface ChannelChat {
  loaded: boolean;
  hasMore: boolean;
  loadingOlder: boolean;
  messages: ChatMessage[];
  lastRead: string;
}

const PAGE = 50;
const TYPING_TTL_MS = 6000;
const EMPTY: ChannelChat = { loaded: false, hasMore: false, loadingOlder: false, messages: [], lastRead: '0' };

/**
 * Text chat state for the selected workspace. Correctness model (docs/architecture):
 * history via keyset REST; live ChannelEvents applied strictly in eventSequence order per channel;
 * duplicates dropped by cursor; gaps buffered and filled from /events?after (410 → reload).
 */
@Injectable({ providedIn: 'root' })
export class ChatStore {
  private readonly api = inject(ApiService);
  private readonly session = inject(SessionService);
  private readonly workspace = inject(WorkspaceStore);
  private readonly realtime = inject(RealtimeService);
  private readonly badges = inject(ChannelBadges);
  private readonly toast = inject(ToastService);
  /** Automatic resend attempts per clientMessageId (429/503 only). */
  private readonly autoRetries = new Map<string, number>();

  private readonly _chats = signal<Record<string, ChannelChat>>({});
  private readonly _pins = signal<Record<string, Message[] | undefined>>({});
  private readonly _typing = signal<Record<string, Record<string, number>>>({});

  /** Channel currently on screen and whether its list is scrolled to the newest message. */
  readonly activeChannelId = signal<string | null>(null);
  /** Text for that channel's composer to insert at the end of its draft ("Mention" from a profile). */
  readonly pendingInsert = signal<{ channelId: string; text: string } | null>(null);
  readonly atBottom = signal(true);
  /** Unsent composer text per channel (kept across channel switches, dropped on sign-out). */
  readonly drafts = new Map<string, string>();

  // Sync bookkeeping (not rendered): last applied event per channel, out-of-order buffer, newest counted message.
  private readonly cursors = new Map<string, string>();
  private readonly buffers = new Map<string, ChannelEvent[]>();
  private readonly resyncing = new Set<string>();
  private readonly knownLast = new Map<string, string>();
  private readonly readTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private subscribed = new Set<string>();
  private typingSweep?: ReturnType<typeof setInterval>;
  private overviewSeq = 0;

  constructor() {
    this.realtime.onChannelEvent((e) => this.receive(e));
    this.realtime.onResubscribe(() => void this.resubscribe());
    this.realtime.onTyping((t) => this.markTyping(t.channelId, t.userId));

    // Channel set changed (server switch, channel created/archived, policy reload) → (re)subscribe.
    const channelKey = computed(() => this.workspace.textChannels().map((c) => c.id).join(','));
    effect(() => {
      channelKey();
      untracked(() => void this.resubscribe());
    });
    effect(() => {
      const serverId = this.workspace.serverId();
      untracked(() => (serverId ? void this.refreshOverview(serverId) : this.badges.replace({}, {})));
    });

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        const id = this.activeChannelId();
        if (id && this.visible() && this.atBottom()) this.scheduleRead(id);
      });
    }

    this.session.onTeardown(() => {
      this._chats.set({});
      this._pins.set({});
      this._typing.set({});
      this.cursors.clear();
      this.buffers.clear();
      this.knownLast.clear();
      this.subscribed = new Set();
      this.drafts.clear();
    });
  }

  chat(channelId: string): ChannelChat {
    return this._chats()[channelId] ?? EMPTY;
  }

  pins(channelId: string): Message[] | undefined {
    return this._pins()[channelId];
  }

  /** User ids currently typing in a channel (excluding me). */
  typingIn(channelId: string): string[] {
    const me = this.session.userId();
    const now = Date.now();
    return Object.entries(this._typing()[channelId] ?? {})
      .filter(([uid, exp]) => uid !== me && exp > now)
      .map(([uid]) => uid);
  }

  // ---- loading ------------------------------------------------------------------------------

  async open(channelId: string): Promise<void> {
    if (this.chat(channelId).loaded) return;
    const page = await this.api.get<MessagePage>(`/channels/${channelId}/messages`, { limit: PAGE });
    this.patch(channelId, () => ({
      loaded: true,
      hasMore: page.hasMore,
      loadingOlder: false,
      messages: page.messages,
      lastRead: page.lastReadMessageSequence ?? '0',
    }));
    // History is a snapshot at highWater: everything at or below it is already reflected.
    const cur = this.cursors.get(channelId);
    this.cursors.set(channelId, cur ? seqMax(cur, page.highWaterEventSequence) : page.highWaterEventSequence);
    this.flush(channelId);
  }

  async loadOlder(channelId: string): Promise<void> {
    const c = this.chat(channelId);
    const oldest = c.messages.find((m) => !m.pending);
    if (!c.loaded || !c.hasMore || c.loadingOlder || !oldest) return;
    this.patch(channelId, (s) => ({ ...s, loadingOlder: true }));
    try {
      const page = await this.api.get<MessagePage>(`/channels/${channelId}/messages`, { limit: PAGE, before: oldest.messageSequence });
      this.patch(channelId, (s) => {
        const have = new Set(s.messages.map((m) => m.id));
        return { ...s, hasMore: page.hasMore, loadingOlder: false, messages: [...page.messages.filter((m) => !have.has(m.id)), ...s.messages] };
      });
    } catch (e) {
      this.patch(channelId, (s) => ({ ...s, loadingOlder: false }));
      throw e;
    }
  }

  async loadPins(channelId: string): Promise<void> {
    const pins = await this.api.get<Message[]>(`/channels/${channelId}/pins`);
    this._pins.update((p) => ({ ...p, [channelId]: pins }));
  }

  // ---- commands -----------------------------------------------------------------------------

  /** Returns false when the server permanently rejected the message (the caller may restore attachments). */
  async send(channelId: string, body: string, replyTo: Message | null, attachments: Attachment[] = []): Promise<boolean> {
    const me = this.session.userId();
    if (!me) return false;
    const pending: ChatMessage = {
      id: `pending-${crypto.randomUUID()}`,
      channelId,
      authorUserId: me,
      messageSequence: '',
      clientMessageId: crypto.randomUUID(),
      body,
      replyTo: replyTo ? { id: replyTo.id, authorUserId: replyTo.authorUserId, bodyPreview: replyTo.body.slice(0, 120), deleted: false, kind: replyTo.kind } : null,
      version: 0,
      createdAt: new Date().toISOString(),
      editedAt: null,
      deleted: false,
      pinned: false,
      mentionsEveryone: false,
      mentions: [],
      reactions: [],
      attachments,
      pending: 'sending',
    };
    this.patch(channelId, (s) => ({ ...s, messages: [...s.messages, pending] }));
    return await this.deliver(pending);
  }

  /** Retries with the same clientMessageId: the server returns the original if the first attempt committed. */
  async retry(m: ChatMessage): Promise<void> {
    this.replacePending(m.channelId, m.clientMessageId, { ...m, pending: 'sending' });
    await this.deliver(m);
  }

  discard(m: ChatMessage): void {
    this.patch(m.channelId, (s) => ({ ...s, messages: s.messages.filter((x) => x.clientMessageId !== m.clientMessageId || !x.pending) }));
  }

  async edit(m: Message, body: string): Promise<void> {
    try {
      const dto = await this.api.patch<Message>(`/messages/${m.id}`, { expectedVersion: m.version, body });
      this.upsert(dto);
    } catch (e) {
      const err = ApiError.from(e);
      this.toast.show(err.status === 409 ? 'That message changed elsewhere. Try again.' : err.message, 'danger');
      throw err;
    }
  }

  async remove(m: Message): Promise<void> {
    try {
      await this.api.delete(`/messages/${m.id}`);
      this.upsert({ ...m, deleted: true, body: '', version: m.version + 1 });
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'danger');
    }
  }

  async toggleReaction(m: Message, emoji: string): Promise<void> {
    const me = this.session.userId();
    if (!me) return;
    const mine = m.reactions.some((r) => r.emoji === emoji && r.userIds.includes(me));
    this.applyReaction(m.channelId, { messageId: m.id, emoji, userId: me, count: -1 }, !mine);
    try {
      const path = `/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`;
      await (mine ? this.api.delete(path) : this.api.put(path));
    } catch (e) {
      this.applyReaction(m.channelId, { messageId: m.id, emoji, userId: me, count: -1 }, mine);
      this.toast.show(ApiError.from(e).message, 'danger');
    }
  }

  async setPinned(m: Message, pinned: boolean): Promise<void> {
    try {
      await this.api.put(`/messages/${m.id}/pin`, { pinned });
      this.mutate(m.channelId, m.id, (x) => ({ ...x, pinned }));
      this.toast.show(pinned ? 'Message pinned' : 'Message unpinned');
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'danger');
    }
  }

  /** Called while the channel is visible and scrolled to the newest message. */
  scheduleRead(channelId: string): void {
    clearTimeout(this.readTimers.get(channelId));
    this.readTimers.set(channelId, setTimeout(() => void this.markRead(channelId), 400));
  }

  // ---- realtime -----------------------------------------------------------------------------

  private async resubscribe(): Promise<void> {
    if (!this.realtime.connected) return;
    const ids = this.workspace.textChannels().map((c) => c.id);
    const wanted = new Set(ids);
    for (const id of this.subscribed) if (!wanted.has(id)) this.forget(id);
    this.subscribed = wanted;
    let acks;
    try {
      acks = await this.realtime.subscribe(ids);
    } catch {
      return;
    }
    for (const ack of acks) {
      const cur = this.cursors.get(ack.channelId);
      if (!this.chat(ack.channelId).loaded || cur === undefined) {
        // Not rendered: badges come from the unread overview below, so just start counting from here.
        this.cursors.set(ack.channelId, ack.cursor);
        this.flush(ack.channelId);
      } else if (seqCmp(ack.cursor, cur) > 0) {
        void this.resync(ack.channelId, true);
      }
    }
    for (const id of ids) if (!acks.some((a) => a.channelId === id)) this.forget(id);
    const serverId = this.workspace.serverId();
    if (serverId) void this.refreshOverview(serverId);
  }

  private receive(e: ChannelEvent): void {
    const cur = this.cursors.get(e.channelId);
    if (cur === undefined || seqCmp(e.eventSequence, cur) <= 0) return;
    if (e.eventSequence === seqNext(cur)) {
      this.apply(e);
      this.cursors.set(e.channelId, e.eventSequence);
      this.flush(e.channelId);
    } else {
      const buf = this.buffers.get(e.channelId) ?? [];
      buf.push(e);
      this.buffers.set(e.channelId, buf);
      setTimeout(() => void this.resync(e.channelId), 250);
    }
  }

  private flush(channelId: string): void {
    const buf = this.buffers.get(channelId);
    if (!buf?.length) return;
    buf.sort((a, b) => seqCmp(a.eventSequence, b.eventSequence));
    let cur = this.cursors.get(channelId)!;
    while (buf.length && seqCmp(buf[0].eventSequence, seqNext(cur)) <= 0) {
      const e = buf.shift()!;
      if (e.eventSequence === seqNext(cur)) {
        this.apply(e);
        cur = e.eventSequence;
      }
    }
    this.cursors.set(channelId, cur);
  }

  /** Fills a gap from the durable log. `force` = the server cursor is ahead even though nothing is buffered. */
  private async resync(channelId: string, force = false): Promise<void> {
    if (this.resyncing.has(channelId)) return;
    this.flush(channelId);
    if (!force && !this.buffers.get(channelId)?.length) return;
    this.resyncing.add(channelId);
    try {
      for (;;) {
        const after = this.cursors.get(channelId);
        if (after === undefined) return;
        const page = await this.api.get<EventPage>(`/channels/${channelId}/events`, { after, limit: 200 });
        for (const e of page.events) this.receive(e);
        if (!page.hasMore) break;
      }
      this.flush(channelId);
    } catch (e) {
      const err = ApiError.from(e);
      if (err.status === 410) await this.reload(channelId);
      else if (err.status === 404) this.forget(channelId);
    } finally {
      this.resyncing.delete(channelId);
    }
  }

  /** Cursor predates retention: drop local state and rebuild from a fresh snapshot. */
  private async reload(channelId: string): Promise<void> {
    const wasLoaded = this.chat(channelId).loaded;
    this.buffers.delete(channelId);
    this._chats.update((m) => {
      const { [channelId]: _, ...rest } = m;
      return rest;
    });
    this.cursors.delete(channelId);
    if (wasLoaded) await this.open(channelId);
    const serverId = this.workspace.serverId();
    if (serverId) await this.refreshOverview(serverId);
  }

  private apply(e: ChannelEvent): void {
    switch (e.type) {
      case 'message.created': {
        const m = e.payload as Message;
        this.countUnread(m);
        this.clearTyping(m.channelId, m.authorUserId);
        if (this.chat(m.channelId).loaded) this.upsert(m);
        break;
      }
      case 'message.updated':
      case 'message.deleted':
        if (this.chat(e.channelId).loaded) this.upsert(e.payload as Message);
        break;
      case 'reaction.added':
      case 'reaction.removed':
        this.applyReaction(e.channelId, e.payload as ReactionEventPayload, e.type === 'reaction.added');
        break;
      case 'message.pinned': {
        const p = e.payload as PinEventPayload;
        this.mutate(e.channelId, p.messageId, (x) => ({ ...x, pinned: p.pinned }));
        if (this.pins(e.channelId)) void this.loadPins(e.channelId).catch(() => undefined);
        break;
      }
      case 'channel.updated':
        void this.workspace.reload().catch(() => undefined);
        break;
    }
  }

  // ---- unread -------------------------------------------------------------------------------

  private async refreshOverview(serverId: string): Promise<void> {
    const seq = ++this.overviewSeq;
    try {
      const rows = await this.api.get<UnreadRow[]>(`/servers/${serverId}/unread`);
      if (seq !== this.overviewSeq || this.workspace.serverId() !== serverId) return;
      const unread: Record<string, number> = {};
      const mentions: Record<string, number> = {};
      for (const r of rows) {
        const viewing = r.channelId === this.activeChannelId() && this.visible() && this.atBottom();
        unread[r.channelId] = viewing ? 0 : r.unread;
        mentions[r.channelId] = viewing ? 0 : r.mentions;
        this.knownLast.set(r.channelId, seqMax(this.knownLast.get(r.channelId) ?? '0', r.lastMessageSequence));
        if (viewing && r.unread > 0) this.scheduleRead(r.channelId);
      }
      this.badges.replace(unread, mentions);
    } catch {
      /* badges are best effort */
    }
  }

  private countUnread(m: Message): void {
    this.workspace.patchChannel(m.channelId, { lastMessageSequence: m.messageSequence });
    const known = this.knownLast.get(m.channelId) ?? '0';
    if (seqCmp(m.messageSequence, known) <= 0) return;
    this.knownLast.set(m.channelId, m.messageSequence);
    const me = this.session.userId();
    if (m.authorUserId === me || m.deleted) return;
    if (m.channelId === this.activeChannelId() && this.visible() && this.atBottom()) {
      this.scheduleRead(m.channelId);
      return;
    }
    this.badges.setUnread(m.channelId, this.badges.unread(m.channelId) + 1);
    if ((me && m.mentions.includes(me)) || m.mentionsEveryone) this.badges.setMentions(m.channelId, this.badges.mentions(m.channelId) + 1);
  }

  private async markRead(channelId: string): Promise<void> {
    const c = this.chat(channelId);
    const latest = [...c.messages].reverse().find((m) => !m.pending)?.messageSequence;
    this.badges.clear(channelId);
    if (!latest || seqCmp(latest, c.lastRead) <= 0) return;
    this.patch(channelId, (s) => ({ ...s, lastRead: latest }));
    try {
      await this.api.put(`/channels/${channelId}/read-position`, { messageSequence: latest });
    } catch {
      /* the next read or reload corrects it */
    }
  }

  // ---- typing -------------------------------------------------------------------------------

  private markTyping(channelId: string, userId: string): void {
    this._typing.update((t) => ({ ...t, [channelId]: { ...(t[channelId] ?? {}), [userId]: Date.now() + TYPING_TTL_MS } }));
    this.typingSweep ??= setInterval(() => {
      const now = Date.now();
      let any = false;
      const next: Record<string, Record<string, number>> = {};
      for (const [ch, users] of Object.entries(this._typing())) {
        const live = Object.fromEntries(Object.entries(users).filter(([, exp]) => exp > now));
        if (Object.keys(live).length) {
          next[ch] = live;
          any = true;
        }
      }
      this._typing.set(next);
      if (!any) {
        clearInterval(this.typingSweep);
        this.typingSweep = undefined;
      }
    }, 1000);
  }

  private clearTyping(channelId: string, userId: string): void {
    const users = this._typing()[channelId];
    if (!users?.[userId]) return;
    const { [userId]: _, ...rest } = users;
    this._typing.update((t) => ({ ...t, [channelId]: rest }));
  }

  // ---- helpers ------------------------------------------------------------------------------

  private async deliver(m: ChatMessage): Promise<boolean> {
    try {
      const dto = await this.api.post<Message>(`/channels/${m.channelId}/messages`, {
        clientMessageId: m.clientMessageId,
        body: m.body,
        replyToId: m.replyTo?.id ?? null,
        attachmentIds: m.attachments.map((a) => a.id),
      });
      this.upsert(dto);
      this.autoRetries.delete(m.clientMessageId);
      if (this.activeChannelId() === m.channelId) this.scheduleRead(m.channelId);
      return true;
    } catch (e) {
      const err = ApiError.from(e);
      if (err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
        // Permanent rejection (permission, validation, conflict): never silently retry.
        this.discard(m);
        this.toast.show(err.message, 'danger');
        return false;
      }
      this.replacePending(m.channelId, m.clientMessageId, { ...m, pending: 'failed' });
      const tries = (this.autoRetries.get(m.clientMessageId) ?? 0) + 1;
      if ((err.status === 429 || err.status === 503) && tries <= 6) {
        // Throttled or briefly unavailable: say so once and resend by itself (same clientMessageId → no duplicate).
        this.autoRetries.set(m.clientMessageId, tries);
        if (tries === 1) this.toast.show(err.message, 'warn');
        setTimeout(() => {
          const still = this._chats()[m.channelId]?.messages.some((x) => x.pending === 'failed' && x.clientMessageId === m.clientMessageId);
          if (still) void this.retry(m);
        }, err.retryAfterMs ?? (err.status === 503 ? 5000 : 2000));
      }
      return true;
    }
  }

  /** Inserts or replaces by id (newer version wins); an optimistic row is replaced by clientMessageId. */
  private upsert(m: Message): void {
    this.patch(m.channelId, (s) => {
      if (!s.loaded) return s;
      const list = s.messages.filter((x) => !(x.pending && x.clientMessageId === m.clientMessageId));
      const i = list.findIndex((x) => x.id === m.id);
      if (i >= 0) {
        if (list[i].version > m.version) return { ...s, messages: list };
        const next = list.slice();
        next[i] = m;
        return { ...s, messages: next };
      }
      // Keep confirmed messages ordered by sequence; pending rows stay at the tail.
      const confirmed = list.filter((x) => !x.pending);
      const pending = list.filter((x) => x.pending);
      let at = confirmed.length;
      while (at > 0 && seqCmp(confirmed[at - 1].messageSequence, m.messageSequence) > 0) at--;
      confirmed.splice(at, 0, m);
      return { ...s, messages: [...confirmed, ...pending] };
    });
  }

  private applyReaction(channelId: string, p: ReactionEventPayload, add: boolean): void {
    this.mutate(channelId, p.messageId, (m) => {
      const reactions = m.reactions.map((r) => ({ ...r, userIds: [...r.userIds] }));
      let r = reactions.find((x) => x.emoji === p.emoji);
      if (!r && add) reactions.push((r = { emoji: p.emoji, count: 0, userIds: [] }));
      if (!r) return m;
      const has = r.userIds.includes(p.userId);
      if (add && !has) r.userIds.push(p.userId);
      if (!add && has) r.userIds = r.userIds.filter((u) => u !== p.userId);
      r.count = p.count >= 0 ? p.count : r.userIds.length;
      return { ...m, reactions: reactions.filter((x) => x.count > 0) };
    });
  }

  private mutate(channelId: string, messageId: string, fn: (m: ChatMessage) => ChatMessage): void {
    this.patch(channelId, (s) => (s.loaded ? { ...s, messages: s.messages.map((m) => (m.id === messageId ? fn(m) : m)) } : s));
  }

  private replacePending(channelId: string, clientMessageId: string, m: ChatMessage): void {
    this.patch(channelId, (s) => ({ ...s, messages: s.messages.map((x) => (x.pending && x.clientMessageId === clientMessageId ? m : x)) }));
  }

  private patch(channelId: string, fn: (s: ChannelChat) => ChannelChat): void {
    this._chats.update((all) => ({ ...all, [channelId]: fn(all[channelId] ?? EMPTY) }));
  }

  private forget(channelId: string): void {
    this.realtime.unsubscribe(channelId);
    this.cursors.delete(channelId);
    this.buffers.delete(channelId);
    this.knownLast.delete(channelId);
    this._chats.update((m) => {
      const { [channelId]: _, ...rest } = m;
      return rest;
    });
    this.badges.clear(channelId);
  }

  private visible(): boolean {
    return typeof document === 'undefined' || document.visibilityState === 'visible';
  }
}
