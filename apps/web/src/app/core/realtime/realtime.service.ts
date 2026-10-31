import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { HubConnection, HubConnectionBuilder, HubConnectionState, LogLevel } from '@microsoft/signalr';
import { ChannelEvent } from '../api/models';
import { SessionService } from '../auth/session.service';
import { WorkspaceStore } from '../../features/workspaces/workspace.store';
import { PresenceStore } from '../../features/presence/presence.store';
import { PresenceStatus } from '../../shared/ui/avatar';

export type RealtimeState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface SubscriptionAck {
  channelId: string;
  cursor: string;
  policyVersion: string;
}

export interface TypingSignal {
  channelId: string;
  userId: string;
}

/** Someone in voice invited me to join their channel (States 02). */
export interface VoicePing {
  serverId: string;
  channelId: string;
  channelName: string;
  fromUserId: string;
  fromDisplayName: string;
}

export interface NotificationSignal {
  /** direct: a new message in a direct/group conversation I am in. */
  type: 'mention' | 'direct';
  channelId: string;
  serverId: string;
  messageId: string;
  actorUserId: string | null;
}

export interface WatchState {
  serverId: string;
  channelId: string;
  videoId: string;
  title: string | null;
  playing: boolean;
  /** Seconds at updatedAt; add the elapsed time while playing. */
  position: number;
  updatedAt: string;
  version: number;
  startedBy: string;
  controlledBy: string;
  serverNow: string;
}

export interface WatchSignal {
  serverId: string;
  channelId: string;
  state: WatchState | null;
}

export interface VoiceStateSignal {
  serverId: string;
  channelId: string;
  userId: string;
  /** Null when the user left voice. */
  state: {
    userId: string;
    channelId: string;
    muted: boolean;
    deafened: boolean;
    serverMuted: boolean;
    camera: boolean;
    screen: boolean;
    joinedAt: string;
  } | null;
}

/** Authoritative room playback state (SignalR hint; REST GET /channels/{id}/sound-plays is the source of truth). */
export interface SoundPlayback {
  playbackId: string;
  serverId: string;
  channelId: string;
  soundId: string;
  actorUserId: string;
  state: 'accepted' | 'starting' | 'playing' | 'completed' | 'stopped' | 'failed' | 'expired' | 'rejected';
  durationMs: number;
  acceptedAt: string;
  startedAt: string | null;
}

type Handler<T> = (value: T) => void;

const HEARTBEAT_MS = 25_000;
const IDLE_AFTER_MS = 5 * 60_000;

/**
 * Single SignalR connection to /hubs/realtime. Delivery is a hint: durable state always comes from REST,
 * so features resubscribe and fetch deltas after every (re)connect or policy change.
 * Owns presence heartbeats, policy reloads, member profile patches and server-side revocation.
 */
@Injectable({ providedIn: 'root' })
export class RealtimeService {
  private readonly session = inject(SessionService);
  private readonly workspace = inject(WorkspaceStore);
  private readonly presence = inject(PresenceStore);
  private readonly router = inject(Router);

  private readonly _state = signal<RealtimeState>('disconnected');
  readonly state = this._state.asReadonly();

  private conn?: HubConnection;
  private heartbeat?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private lastActivity = Date.now();
  private sentIdle = false;

  private readonly channelEventHandlers = new Set<Handler<ChannelEvent>>();
  private readonly typingHandlers = new Set<Handler<TypingSignal>>();
  private readonly notificationHandlers = new Set<Handler<NotificationSignal>>();
  private readonly resubscribeHandlers = new Set<() => void>();
  private readonly voiceHandlers = new Set<Handler<VoiceStateSignal>>();
  private readonly soundCatalogHandlers = new Set<Handler<{ serverId: string; soundId: string }>>();
  private readonly soundPlaybackHandlers = new Set<Handler<SoundPlayback>>();
  private readonly voicePingHandlers = new Set<Handler<VoicePing>>();
  private readonly watchHandlers = new Set<Handler<WatchSignal>>();

  constructor() {
    effect(() => {
      const status = this.session.status();
      untracked(() => (status === 'authenticated' ? void this.start() : void this.stop()));
    });
    this.session.onTeardown(() => this.stop());

    if (typeof document !== 'undefined') {
      const touch = () => {
        this.lastActivity = Date.now();
        if (this.sentIdle) void this.sendHeartbeat();
      };
      for (const ev of ['pointerdown', 'keydown', 'wheel', 'focus']) document.addEventListener(ev, touch, { passive: true });
    }
  }

  onChannelEvent(h: Handler<ChannelEvent>): void {
    this.channelEventHandlers.add(h);
  }

  onTyping(h: Handler<TypingSignal>): void {
    this.typingHandlers.add(h);
  }

  onNotification(h: Handler<NotificationSignal>): void {
    this.notificationHandlers.add(h);
  }

  onVoicePing(h: Handler<VoicePing>): void {
    this.voicePingHandlers.add(h);
  }

  /** Watch together: the player of a voice channel changed (state null = stopped). */
  onWatch(h: Handler<WatchSignal>): void {
    this.watchHandlers.add(h);
  }

  /** Fires after every (re)connect and after a policy change cleared server-side subscriptions. */
  onResubscribe(h: () => void): void {
    this.resubscribeHandlers.add(h);
  }

  get connected(): boolean {
    return this.conn?.state === HubConnectionState.Connected;
  }

  async subscribe(channelIds: string[]): Promise<SubscriptionAck[]> {
    if (!this.connected || channelIds.length === 0) return [];
    return this.conn!.invoke<SubscriptionAck[]>('SubscribeChannels', channelIds);
  }

  unsubscribe(channelId: string): void {
    if (this.connected) void this.conn!.invoke('UnsubscribeChannel', channelId).catch(() => undefined);
  }

  typing(channelId: string): void {
    if (this.connected) void this.conn!.invoke('Typing', channelId).catch(() => undefined);
  }

  updateVoiceState(leaseId: string, muted: boolean, deafened: boolean): void {
    if (this.connected) void this.conn!.invoke('UpdateVoiceState', leaseId, muted, deafened).catch(() => undefined);
  }

  onVoiceState(h: Handler<VoiceStateSignal>): void {
    this.voiceHandlers.add(h);
  }

  onSoundCatalog(h: Handler<{ serverId: string; soundId: string }>): void {
    this.soundCatalogHandlers.add(h);
  }

  onSoundPlayback(h: Handler<SoundPlayback>): void {
    this.soundPlaybackHandlers.add(h);
  }

  private async start(): Promise<void> {
    if (this.conn) return;
    const conn = new HubConnectionBuilder()
      .withUrl('/hubs/realtime', { withCredentials: true })
      .withAutomaticReconnect({
        // Never give up while signed in; jitter avoids a thundering herd after an API restart.
        nextRetryDelayInMilliseconds: (ctx) => Math.min(30_000, 1000 * 2 ** Math.min(ctx.previousRetryCount, 5)) + Math.random() * 1000,
      })
      .configureLogging(LogLevel.Warning)
      .build();
    this.conn = conn;

    conn.on('channelEvent', (e: ChannelEvent) => {
      // A message from someone the roster doesn't know yet (e.g. they just joined): fetch the roster again.
      if (e.actorUserId && !this.workspace.memberById().has(e.actorUserId)) this.workspace.refreshMembersSoon();
      this.channelEventHandlers.forEach((h) => h(e));
    });
    conn.on('typingChanged', (t: TypingSignal) => this.typingHandlers.forEach((h) => h(t)));
    conn.on('notificationCreated', (n: NotificationSignal) => this.notificationHandlers.forEach((h) => h(n)));
    conn.on('voiceStateChanged', (v: VoiceStateSignal) => this.voiceHandlers.forEach((h) => h(v)));
    conn.on('soundCatalogChanged', (c: { serverId: string; soundId: string }) => this.soundCatalogHandlers.forEach((h) => h(c)));
    conn.on('soundPlaybackChanged', (p: SoundPlayback) => this.soundPlaybackHandlers.forEach((h) => h(p)));
    conn.on('voicePing', (p: VoicePing) => this.voicePingHandlers.forEach((h) => h(p)));
    conn.on('watchChanged', (w: WatchSignal) => this.watchHandlers.forEach((h) => h(w)));
    conn.on('presenceChanged', (p: { userId: string; status: PresenceStatus }) => this.presence.set(p.userId, p.status));
    conn.on('memberUpdated', (m: { userId: string; displayName: string; avatarHue: number; avatarAssetId: string | null }) => {
      this.workspace.patchMember(m.userId, { displayName: m.displayName, avatarHue: m.avatarHue, avatarAssetId: m.avatarAssetId });
      const me = this.session.user();
      if (me && me.id === m.userId) this.session.updateProfile({ ...me, displayName: m.displayName, avatarHue: m.avatarHue, avatarAssetId: m.avatarAssetId });
    });
    conn.on('membersChanged', (p: { serverId: string }) => {
      if (p.serverId === this.workspace.serverId()) void this.workspace.reloadMembers().catch(() => undefined);
    });
    conn.on('serverUpdated', (p: { serverId: string }) => {
      // Name, icon or settings changed: the rail reads /auth/me, the rest the server detail.
      void this.session.refreshMe().catch(() => undefined);
      if (p.serverId === this.workspace.serverId()) void this.workspace.reload().catch(() => undefined);
    });
    conn.on('policyChanged', (p: { serverId: string }) => void this.onPolicyChanged(p.serverId));
    conn.on('sessionRevoked', () => this.session.handleUnauthorized());

    conn.onreconnecting(() => this._state.set('reconnecting'));
    conn.onreconnected(() => void this.afterConnect());
    conn.onclose(() => {
      if (this.conn !== conn) return;
      this._state.set('disconnected');
      this.conn = undefined;
      this.scheduleRestart();
    });

    this._state.set('connecting');
    try {
      await conn.start();
    } catch {
      if (this.conn === conn) {
        this.conn = undefined;
        this._state.set('disconnected');
        this.scheduleRestart();
      }
      return;
    }
    if (this.conn !== conn) {
      await conn.stop();
      return;
    }
    this.heartbeat = setInterval(() => void this.sendHeartbeat(), HEARTBEAT_MS);
    await this.afterConnect();
  }

  private scheduleRestart(): void {
    clearTimeout(this.retry);
    if (this.session.status() !== 'authenticated' || this.session.expired()) return;
    this.retry = setTimeout(() => void this.start(), 3000 + Math.random() * 2000);
  }

  private async stop(): Promise<void> {
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    const conn = this.conn;
    this.conn = undefined;
    this._state.set('disconnected');
    if (conn) await conn.stop().catch(() => undefined);
  }

  private async afterConnect(): Promise<void> {
    this._state.set('connected');
    try {
      const snapshot = await this.conn!.invoke<Record<string, PresenceStatus>>('GetPresence');
      this.presence.replace(snapshot);
    } catch {
      /* presence is best effort */
    }
    void this.sendHeartbeat();
    this.resubscribeHandlers.forEach((h) => h());
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.connected) return;
    const idle = Date.now() - this.lastActivity > IDLE_AFTER_MS;
    this.sentIdle = idle;
    await this.conn!.invoke('PresenceHeartbeat', idle).catch(() => undefined);
  }

  private async onPolicyChanged(serverId: string): Promise<void> {
    if (this.workspace.serverId() === serverId) {
      try {
        await this.workspace.reload();
      } catch {
        // Lost access to the server entirely (removed): refresh memberships and leave.
        await this.session.refreshMe().catch(() => undefined);
        this.workspace.clearSelection();
        await this.router.navigateByUrl('/');
      }
    }
    this.resubscribeHandlers.forEach((h) => h());
  }
}
