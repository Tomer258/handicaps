import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ChannelEvent, Message } from '../../core/api/models';
import { SessionService } from '../../core/auth/session.service';
import { MediaSessionService } from '../../core/media/media-session.service';
import { NotificationSignal, RealtimeService, VoicePing } from '../../core/realtime/realtime.service';
import { UserSettingsService } from '../../core/settings/user-settings.service';
import { ToastService } from '../../core/ui/toast.service';
import { ChatStore } from '../messages/chat.store';
import { previewText } from '../messages/message-text';
import { WorkspaceStore } from '../workspaces/workspace.store';

const BODY_MAX = 140;
const CHIME_GAP_MS = 400;
const RECENT_MAX = 200;

/**
 * Decides how a new message or mention reaches me (docs: notifications are client-side, from authorized state only):
 * - Do not disturb silences everything (pop-ups, toasts, chimes); badges still count.
 * - While in voice, mentions only alert when "mention alerts during voice" is on.
 * - Hangar focused → an in-app toast for mentions outside the open channel.
 * - Hangar in the background → a browser notification, if granted, per the messages preference (all / mentions / none).
 * Join/leave chimes play for other people entering or leaving my voice channel.
 */
@Injectable({ providedIn: 'root' })
export class Notifier {
  private readonly realtime = inject(RealtimeService);
  private readonly settings = inject(UserSettingsService);
  private readonly session = inject(SessionService);
  private readonly workspace = inject(WorkspaceStore);
  private readonly chat = inject(ChatStore);
  private readonly media = inject(MediaSessionService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  /** Message ids already announced (mentions arrive for edits too). */
  private readonly seen = new Set<string>();
  /** Recent messages from subscribed channels, for mention text when that channel's history is not loaded. */
  private readonly recent = new Map<string, Message>();
  private audio?: AudioContext;
  private roster = new Set<string>();
  private rosterRoom = -1;
  private lastChime = 0;
  private lastChimeJoin = false;

  constructor() {
    this.realtime.onNotification((n) => this.onMention(n));
    this.realtime.onChannelEvent((e) => this.onEvent(e));
    this.realtime.onVoicePing((p) => this.onVoicePing(p));

    this.media.onPeersChanged((peers, room) => this.diffRoster(room, new Set(peers.filter((p) => !p.isLocal).map((p) => p.userId))));

    this.session.onTeardown(() => {
      this.seen.clear();
      this.recent.clear();
      this.roster.clear();
      this.rosterRoom = -1;
    });
  }

  private get dnd(): boolean {
    return this.settings.preferredStatus() === 'doNotDisturb';
  }

  private get focused(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();
  }

  private onMention(n: NotificationSignal): void {
    if (this.seen.has(n.messageId)) return;
    this.seen.add(n.messageId);
    if (this.dnd) return;
    if (this.media.connected() && !this.settings.notifications().mentionsInVoice) return;
    const who = (n.actorUserId && this.workspace.memberById().get(n.actorUserId)?.displayName) || 'Someone';
    const ch = this.workspace.channel(n.channelId)?.name;
    const title = ch ? `${who} mentioned you in #${ch}` : 'You were mentioned in another server';
    if (this.focused) {
      if (n.channelId !== this.chat.activeChannelId()) this.toast.show(title);
      return;
    }
    if (this.settings.notifications().messages === 'none') return;
    const m = this.recent.get(n.messageId) ?? this.chat.chat(n.channelId).messages.find((x) => x.id === n.messageId);
    this.popup(title, m ? this.preview(m) : '', n.serverId, n.channelId);
  }

  /** A one-tap join link: a toast with "Join" while focused, a browser notification otherwise. DND drops it. */
  private onVoicePing(p: VoicePing): void {
    if (this.dnd || (this.media.connected() && this.media.channelId() === p.channelId)) return;
    const title = `${p.fromDisplayName} is in ${p.channelName} — come hang out`;
    const join = () => {
      void this.router.navigate(['/s', p.serverId, 'v', p.channelId]);
      void this.media.join(p.channelId);
    };
    if (this.focused || typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      this.toast.show(title, 'info', { label: 'Join', run: join });
      return;
    }
    try {
      const n = new Notification(title, { body: 'Click to join voice', tag: `hangar-ping-${p.channelId}` });
      n.onclick = () => {
        window.focus();
        n.close();
        join();
      };
    } catch {
      this.toast.show(title, 'info', { label: 'Join', run: join });
    }
  }

  /** "All messages" mode: other people's messages in subscribed channels while Hangar is in the background. */
  private onEvent(e: ChannelEvent): void {
    if (e.type !== 'message.created' && e.type !== 'message.updated') return;
    const m = e.payload as Message;
    this.recent.set(m.id, m);
    if (this.recent.size > RECENT_MAX) this.recent.delete(this.recent.keys().next().value!);
    if (e.type !== 'message.created' || this.dnd || this.focused) return;
    const me = this.session.userId();
    if (!me || m.authorUserId === me || this.seen.has(m.id)) return;
    const mentioned = m.mentions.includes(me) || m.mentionsEveryone;
    if (m.mentions.includes(me)) return; // the server's mention signal announces it
    const pref = this.settings.notifications().messages;
    if (pref === 'none' || (pref === 'mentions' && !mentioned)) return;
    if (this.media.connected() && !this.settings.notifications().mentionsInVoice) return;
    this.seen.add(m.id);
    const ch = this.workspace.channel(m.channelId);
    const who = this.workspace.memberById().get(m.authorUserId)?.displayName ?? 'Someone';
    const title = ch ? `${who} in #${ch.name}` : who;
    this.popup(title, this.preview(m), ch?.serverId ?? this.workspace.serverId() ?? '', m.channelId);
  }

  private preview(m: Message): string {
    if (m.kind === 'memberJoined') return 'Joined the hangar — say hi! 👋';
    const text = previewText(m.body, this.workspace.memberById());
    const files = m.attachments.length ? `📎 ${m.attachments.length === 1 ? m.attachments[0].name : `${m.attachments.length} files`}` : '';
    const body = [text, files].filter(Boolean).join(' · ');
    return body.length > BODY_MAX ? body.slice(0, BODY_MAX - 1) + '…' : body;
  }

  private popup(title: string, body: string, serverId: string, channelId: string): void {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      // One notification per channel: a newer message replaces the older one.
      const n = new Notification(title, { body, tag: `hangar-${channelId}`, silent: false });
      n.onclick = () => {
        window.focus();
        n.close();
        if (serverId) void this.router.navigate(['/s', serverId, 'c', channelId]);
      };
    } catch {
      // Some platforms only allow notifications from a service worker; the in-app badge still shows.
    }
  }

  private diffRoster(room: number, ids: Set<string>): void {
    if (room !== this.rosterRoom) {
      // A new connection (join or switch) takes a fresh baseline: no chime for people already there.
      this.rosterRoom = room;
      this.roster = ids;
      return;
    }
    const joined = [...ids].some((id) => !this.roster.has(id));
    const left = [...this.roster].some((id) => !ids.has(id));
    this.roster = ids;
    if (joined) this.chime(true);
    else if (left) this.chime(false);
  }

  /** Two short sine notes, rising for a join and falling for a leave. */
  private chime(join: boolean): void {
    if (this.dnd || !this.settings.notifications().chimes || this.media.deafened()) return;
    // Collapse bursts (several people arriving together) into one cue per direction.
    const now = performance.now();
    if (join === this.lastChimeJoin && now - this.lastChime < CHIME_GAP_MS) return;
    this.lastChime = now;
    this.lastChimeJoin = join;
    try {
      this.audio ??= new AudioContext();
      const ctx = this.audio;
      if (ctx.state === 'suspended') void ctx.resume();
      const notes = join ? [660, 880] : [880, 587];
      const gain = ctx.createGain();
      gain.gain.value = 0.08;
      gain.connect(ctx.destination);
      notes.forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        const t = ctx.currentTime + i * 0.11;
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(1, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
        o.connect(g).connect(gain);
        o.start(t);
        o.stop(t + 0.18);
      });
      document.dispatchEvent(new CustomEvent('hangar:chime', { detail: join ? 'join' : 'leave' }));
    } catch {
      // No audio output available.
    }
  }
}
