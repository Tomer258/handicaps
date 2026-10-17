import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  ConnectionState,
  DisconnectReason,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
} from 'livekit-client';
import { ApiService } from '../api/api.service';
import { ApiError } from '../api/api-error';
import { SessionService } from '../auth/session.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ToastService } from '../ui/toast.service';

export type VoiceConnection = 'idle' | 'joining' | 'connected' | 'reconnecting' | 'error';

export interface VoiceJoinResponse {
  leaseId: string;
  channelId: string;
  url: string;
  token: string;
  tokenExpiresAt: string;
  canSpeak: boolean;
  canCamera: boolean;
  canScreen: boolean;
}

/** A person in the current room, as seen by LiveKit (the source of truth for who is actually connected). */
export interface RoomPeer {
  identity: string;
  userId: string;
  name: string;
  isLocal: boolean;
  micMuted: boolean;
  hasMic: boolean;
}

const VOLUME_KEY = 'hangar.voiceVolumes';
const MAX_VOLUME = 2;

/**
 * Root voice/media session: one LiveKit Room for the whole app. Route components only read its signals;
 * leaving a text route never ends a call. Logout and explicit Leave perform centralized teardown.
 * Mute affects the microphone only; deafen silences all received audio and also mutes (restore on undeafen).
 */
@Injectable({ providedIn: 'root' })
export class MediaSessionService {
  private readonly api = inject(ApiService);
  private readonly session = inject(SessionService);
  private readonly realtime = inject(RealtimeService);
  private readonly toast = inject(ToastService);

  private readonly _connection = signal<VoiceConnection>('idle');
  private readonly _channelId = signal<string | null>(null);
  private readonly _muted = signal(false);
  private readonly _deafened = signal(false);
  private readonly _speaking = signal<ReadonlySet<string>>(new Set());
  private readonly _peers = signal<RoomPeer[]>([]);
  private readonly _canSpeak = signal(false);
  private readonly _micBlocked = signal(false);
  private readonly _audioBlocked = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _volumes = signal<Record<string, number>>(loadVolumes());

  readonly connection = this._connection.asReadonly();
  readonly channelId = this._channelId.asReadonly();
  readonly muted = this._muted.asReadonly();
  readonly deafened = this._deafened.asReadonly();
  /** User ids currently speaking (microphone only). */
  readonly speaking = this._speaking.asReadonly();
  readonly peers = this._peers.asReadonly();
  readonly canSpeak = this._canSpeak.asReadonly();
  /** Microphone permission denied or device missing: listen-only until the user retries. */
  readonly micBlocked = this._micBlocked.asReadonly();
  /** Browser autoplay policy blocked playback; a click on "Enable audio" resumes it. */
  readonly audioBlocked = this._audioBlocked.asReadonly();
  readonly error = this._error.asReadonly();
  readonly volumes = this._volumes.asReadonly();
  readonly connected = computed(() => this._connection() === 'connected' || this._connection() === 'reconnecting');

  private room?: Room;
  private leaseId: string | null = null;
  /** Incremented per join; callbacks from an older room are ignored. */
  private generation = 0;
  private mutedBeforeDeafen = false;
  private readonly audioHost: HTMLElement | null = typeof document !== 'undefined' ? document.createElement('div') : null;

  constructor() {
    if (this.audioHost) {
      this.audioHost.setAttribute('aria-hidden', 'true');
      this.audioHost.style.display = 'none';
      document.body.appendChild(this.audioHost);
      // Best-effort release so the server does not wait for the reconnect grace after a closed tab.
      window.addEventListener('pagehide', () => this.leaseId && this.releaseLease(this.leaseId, true));
    }
    this.session.onTeardown(() => this.leave());
    this.realtime.onResubscribe(() => this.reportState());
    effect(() => {
      this._muted();
      this._deafened();
      untracked(() => this.reportState());
    });
  }

  async join(channelId: string): Promise<void> {
    if (this.connected() && this._channelId() === channelId) return;
    if (this._connection() === 'joining') return;
    if (this.room || this.leaseId) await this.leave();

    const gen = ++this.generation;
    this._connection.set('joining');
    this._channelId.set(channelId);
    this._error.set(null);

    let grant: VoiceJoinResponse;
    try {
      grant = await this.api.post<VoiceJoinResponse>(`/channels/${channelId}/voice/join`, { requestId: crypto.randomUUID() });
    } catch (e) {
      if (gen !== this.generation) return;
      this.fail(ApiError.from(e).message);
      return;
    }
    if (gen !== this.generation) {
      this.releaseLease(grant.leaseId);
      return;
    }
    this.leaseId = grant.leaseId;
    this._canSpeak.set(grant.canSpeak);

    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      // Web Audio mixing lets per-user volume go above 100%.
      webAudioMix: true,
      disconnectOnPageLeave: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      publishDefaults: { dtx: true, red: true },
    });
    this.room = room;
    this.wire(room, gen);

    try {
      // Explicit subscriptions: audio is subscribed on publish; video waits for the viewer (S5).
      await room.connect(grant.url, grant.token, { autoSubscribe: false });
    } catch (e) {
      if (gen !== this.generation) return;
      this.releaseLease(grant.leaseId);
      this.cleanupRoom();
      this.fail('Could not connect to voice. Check your connection and try again.');
      return;
    }
    if (gen !== this.generation) return;

    for (const p of room.remoteParticipants.values()) this.subscribeAudio(p);
    this._connection.set('connected');
    this.refreshPeers();
    this._audioBlocked.set(!room.canPlaybackAudio);
    void this.api.post(`/voice/${grant.leaseId}/confirm`).catch(() => undefined);

    if (grant.canSpeak) await this.enableMic(gen);
    else this._muted.set(true);
    this.reportState();
  }

  async leave(): Promise<void> {
    this.generation++;
    const lease = this.leaseId;
    this.leaseId = null;
    this.cleanupRoom();
    this._connection.set('idle');
    this._channelId.set(null);
    this._peers.set([]);
    this._speaking.set(new Set());
    this._error.set(null);
    this._audioBlocked.set(false);
    if (lease) this.releaseLease(lease);
  }

  async toggleMute(): Promise<void> {
    if (this._deafened() && this._muted()) {
      // Unmuting while deafened also undeafens (documented restore choice).
      this._deafened.set(false);
      this.applyVolumes();
    }
    await this.setMuted(!this._muted());
  }

  async toggleDeafen(): Promise<void> {
    const next = !this._deafened();
    if (next) this.mutedBeforeDeafen = this._muted();
    this._deafened.set(next);
    this.applyVolumes();
    if (next) await this.setMuted(true);
    else await this.setMuted(this.mutedBeforeDeafen);
  }

  /** Retry microphone after the user fixed permissions/devices (needs a user gesture). */
  async retryMic(): Promise<void> {
    await this.enableMic(this.generation);
  }

  async enableAudio(): Promise<void> {
    await this.room?.startAudio();
    this._audioBlocked.set(!(this.room?.canPlaybackAudio ?? true));
  }

  /** Per-person voice volume (0–200%), remembered locally. Affects only that person's microphone. */
  setVolume(userId: string, volume: number): void {
    const v = Math.max(0, Math.min(MAX_VOLUME, volume));
    this._volumes.update((m) => ({ ...m, [userId]: v }));
    try {
      localStorage.setItem(VOLUME_KEY, JSON.stringify(this._volumes()));
    } catch {
      /* storage unavailable */
    }
    this.applyVolumes();
  }

  volumeOf(userId: string): number {
    return this._volumes()[userId] ?? 1;
  }

  // ---- internals ------------------------------------------------------------------------------

  private wire(room: Room, gen: number): void {
    const live = () => gen === this.generation;
    room
      .on(RoomEvent.ParticipantConnected, (p) => {
        if (!live()) return;
        this.subscribeAudio(p);
        this.refreshPeers();
      })
      .on(RoomEvent.ParticipantDisconnected, () => live() && this.refreshPeers())
      .on(RoomEvent.TrackPublished, (pub, p) => {
        if (!live()) return;
        if (pub.kind === Track.Kind.Audio) pub.setSubscribed(true);
        this.refreshPeers();
        void p;
      })
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) => {
        if (!live() || track.kind !== Track.Kind.Audio || !this.audioHost) return;
        const el = track.attach();
        this.audioHost.appendChild(el);
        this.applyVolumeFor(p);
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => track.detach().forEach((el) => el.remove()))
      .on(RoomEvent.TrackMuted, () => live() && this.refreshPeers())
      .on(RoomEvent.TrackUnmuted, () => live() && this.refreshPeers())
      .on(RoomEvent.LocalTrackPublished, () => live() && this.refreshPeers())
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        if (!live()) return;
        this._speaking.set(new Set(speakers.map((s) => userIdOf(s)).filter((u): u is string => !!u)));
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => live() && this._audioBlocked.set(!room.canPlaybackAudio))
      .on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
        if (!live()) return;
        if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) this._connection.set('reconnecting');
        else if (state === ConnectionState.Connected && this._connection() !== 'joining') this._connection.set('connected');
      })
      .on(RoomEvent.MediaDevicesError, () => {
        if (!live()) return;
        // A lost device stops transmission; we never silently switch to another sensitive input.
        this._micBlocked.set(true);
        void this.setMuted(true);
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (!live() || reason === DisconnectReason.CLIENT_INITIATED) return;
        const lease = this.leaseId;
        this.leaseId = null;
        this.generation++;
        this.cleanupRoom();
        this._peers.set([]);
        this._speaking.set(new Set());
        if (reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.DUPLICATE_IDENTITY) {
          this._connection.set('idle');
          this._channelId.set(null);
          this.toast.show('You left voice — joined from another tab or removed by a moderator.', 'warn');
        } else {
          if (lease) this.releaseLease(lease);
          this.fail('Voice connection lost.');
        }
      });
  }

  private subscribeAudio(p: RemoteParticipant): void {
    for (const pub of p.trackPublications.values()) if (pub.kind === Track.Kind.Audio && !pub.isSubscribed) pub.setSubscribed(true);
  }

  private async enableMic(gen: number): Promise<void> {
    const room = this.room;
    if (!room || gen !== this.generation || !this._canSpeak()) return;
    try {
      // Device choice arrives with the settings dialog (S7); until then the OS default input is used.
      await room.localParticipant.setMicrophoneEnabled(!this._muted());
      this._micBlocked.set(false);
    } catch {
      if (gen !== this.generation) return;
      this._micBlocked.set(true);
      this._muted.set(true);
      this.toast.show('Microphone unavailable — you are listen-only. Check browser permissions.', 'warn');
    }
    this.refreshPeers();
  }

  private async setMuted(muted: boolean): Promise<void> {
    if (!muted && (!this._canSpeak() || this._micBlocked())) {
      if (this._micBlocked()) await this.retryMic();
      if (!this._canSpeak() || this._micBlocked()) return;
    }
    this._muted.set(muted);
    const room = this.room;
    if (room && this._canSpeak()) {
      try {
        await room.localParticipant.setMicrophoneEnabled(!muted);
      } catch {
        this._micBlocked.set(true);
        this._muted.set(true);
      }
    }
    this.refreshPeers();
  }

  private applyVolumes(): void {
    const room = this.room;
    if (!room) return;
    for (const p of room.remoteParticipants.values()) this.applyVolumeFor(p);
  }

  private applyVolumeFor(p: RemoteParticipant): void {
    const uid = userIdOf(p);
    p.setVolume(this._deafened() ? 0 : uid ? this.volumeOf(uid) : 1, Track.Source.Microphone);
  }

  private refreshPeers(): void {
    const room = this.room;
    if (!room) return;
    const list: RoomPeer[] = [];
    const add = (p: Participant, isLocal: boolean) => {
      const uid = userIdOf(p);
      if (!uid) return; // workers (soundboard publisher) are never shown as people
      const mic = p.getTrackPublication(Track.Source.Microphone);
      list.push({ identity: p.identity, userId: uid, name: p.name || 'Unknown', isLocal, hasMic: !!mic, micMuted: !mic || mic.isMuted });
    };
    add(room.localParticipant, true);
    for (const p of room.remoteParticipants.values()) add(p, false);
    this._peers.set(list);
  }

  private reportState(): void {
    if (this.leaseId && this.connected()) this.realtime.updateVoiceState(this.leaseId, this._muted(), this._deafened());
  }

  private cleanupRoom(): void {
    const room = this.room;
    this.room = undefined;
    if (!room) return;
    room.removeAllListeners();
    void room.disconnect(true);
    if (this.audioHost) this.audioHost.replaceChildren();
  }

  private releaseLease(leaseId: string, keepalive = false): void {
    // fetch keepalive survives page unload; it carries the XSRF header like the HTTP client does.
    const xsrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1] ?? '');
    void fetch(`/api/v1/voice/${leaseId}`, { method: 'DELETE', keepalive, credentials: 'same-origin', headers: { 'X-XSRF-TOKEN': xsrf } }).catch(() => undefined);
  }

  private fail(message: string): void {
    this._connection.set('error');
    this._error.set(message);
    this.toast.show(message, 'danger');
  }
}

function userIdOf(p: Participant): string | null {
  try {
    const meta = p.metadata ? (JSON.parse(p.metadata) as { userId?: string }) : null;
    return meta?.userId ?? null;
  } catch {
    return null;
  }
}

function loadVolumes(): Record<string, number> {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}
