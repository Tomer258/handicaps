import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  ConnectionState,
  DisconnectReason,
  LocalTrack,
  LocalVideoTrack,
  Participant,
  RemoteAudioTrack,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  TrackPublication,
  VideoPreset,
  createLocalScreenTracks,
  createLocalVideoTrack,
} from 'livekit-client';
import { ApiService } from '../api/api.service';
import { MediaPrefsService } from './media-prefs.service';
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

export type ScreenQuality = '1080p60' | '720p30';
export type ShareResult = 'ok' | 'denied' | 'failed';

/** A camera or screen stream in the room. Remote video is subscribed only while a tile watches it. */
export interface StreamInfo {
  key: string;
  identity: string;
  userId: string;
  name: string;
  kind: 'screen' | 'camera';
  isLocal: boolean;
  publication?: RemoteTrackPublication;
  localTrack?: LocalVideoTrack;
  hasAudio: boolean;
}

const VOLUME_KEY = 'hangar.voiceVolumes';
const SOUND_KEY = 'hangar.soundboard';
/** The soundboard worker joins as sb_<room> and publishes one track per actor named sfx_<userId>. */
const SB_PREFIX = 'sb_';
const SFX_PREFIX = 'sfx_';

interface SoundPrefs {
  volume: number;
  muted: boolean;
  mutedActors: string[];
}
const MAX_VOLUME = 2;
const SCREEN_ENCODING: Record<ScreenQuality, { width: number; height: number; fps: number; bitrate: number; layers: VideoPreset[] }> = {
  // Capacity model: 8 Mbps high layer with 2.0 / 0.4 Mbps lower layers for thumbnails and weak links.
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 8_000_000, layers: [new VideoPreset(640, 360, 400_000, 15), new VideoPreset(1280, 720, 2_000_000, 30)] },
  '720p30': { width: 1280, height: 720, fps: 30, bitrate: 2_500_000, layers: [new VideoPreset(640, 360, 400_000, 15)] },
};

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
  private readonly mediaPrefs = inject(MediaPrefsService);

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
  private readonly _sharing = signal<'off' | 'starting' | 'live'>('off');
  private readonly _shareHasAudio = signal(false);
  private readonly _camera = signal<'off' | 'starting' | 'on'>('off');
  private readonly _canCamera = signal(false);
  private readonly _canScreen = signal(false);
  private readonly _streamVolumes = signal<Record<string, number>>({});
  private readonly _sound = signal<SoundPrefs>(loadSoundPrefs());
  /** Bumped on any track change so stream lists/tiles recompute (LiveKit objects are not signals). */
  private readonly _version = signal(0);

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
  readonly sharing = this._sharing.asReadonly();
  readonly shareHasAudio = this._shareHasAudio.asReadonly();
  readonly camera = this._camera.asReadonly();
  readonly canCamera = this._canCamera.asReadonly();
  readonly canScreen = this._canScreen.asReadonly();
  readonly version = this._version.asReadonly();
  /** Soundboard volume 0–1 (only what I hear). */
  readonly soundVolume = computed(() => this._sound().volume);
  readonly soundMuted = computed(() => this._sound().muted);
  readonly soundMutedActors = computed(() => new Set(this._sound().mutedActors));

  /** Every camera/screen stream in the room, including my own (rendered from the local track). */
  readonly streams = computed<StreamInfo[]>(() => {
    this._version();
    const room = this.room;
    if (!room || !this.connected()) return [];
    const out: StreamInfo[] = [];
    const lp = room.localParticipant;
    for (const [source, kind] of [[Track.Source.ScreenShare, 'screen'], [Track.Source.Camera, 'camera']] as const) {
      const pub = lp.getTrackPublication(source);
      const uid = userIdOf(lp);
      if (pub?.track && uid)
        out.push({ key: `${lp.identity}:${kind}`, identity: lp.identity, userId: uid, name: lp.name || 'You', kind, isLocal: true,
          localTrack: pub.track as LocalVideoTrack, hasAudio: kind === 'screen' && !!lp.getTrackPublication(Track.Source.ScreenShareAudio) });
    }
    for (const p of room.remoteParticipants.values()) {
      const uid = userIdOf(p);
      if (!uid) continue;
      for (const [source, kind] of [[Track.Source.ScreenShare, 'screen'], [Track.Source.Camera, 'camera']] as const) {
        const pub = p.getTrackPublication(source) as RemoteTrackPublication | undefined;
        if (pub)
          out.push({ key: `${p.identity}:${kind}`, identity: p.identity, userId: uid, name: p.name || 'Unknown', kind, isLocal: false,
            publication: pub, hasAudio: kind === 'screen' && !!p.getTrackPublication(Track.Source.ScreenShareAudio) });
      }
    }
    return out;
  });

  private room?: Room;
  private readonly videoWatchers = new Map<string, number>();
  private readonly audioWatchers = new Map<string, number>();
  private screenTracks: LocalTrack[] = [];
  private cameraTrack?: LocalVideoTrack;
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
    // Device / processing changes apply live to the running call.
    effect(() => {
      const p = this.mediaPrefs.prefs();
      untracked(() => void this.applyDevicePrefs(p.inputDeviceId, p.outputDeviceId, p.cameraDeviceId));
    });
  }

  /** The current voice lease (authorizes soundboard plays); null when not in voice. */
  currentLeaseId(): string | null {
    return this.connected() ? this.leaseId : null;
  }

  setSoundVolume(volume: number): void {
    this.updateSound({ volume: Math.max(0, Math.min(1, volume)) });
  }

  setSoundMuted(muted: boolean): void {
    this.updateSound({ muted });
  }

  /** Mute one person's soundboard effects for me only (their voice is unaffected). */
  setActorSoundMuted(userId: string, muted: boolean): void {
    const set = new Set(this._sound().mutedActors);
    if (muted) set.add(userId);
    else set.delete(userId);
    this.updateSound({ mutedActors: [...set] });
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
    this._canCamera.set(grant.canCamera);
    this._canScreen.set(grant.canScreen);

    const prefs = this.mediaPrefs.prefs();
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      // Web Audio mixing lets per-user volume go above 100%.
      webAudioMix: true,
      disconnectOnPageLeave: true,
      audioCaptureDefaults: this.captureOptions(),
      audioOutput: prefs.outputDeviceId ? { deviceId: prefs.outputDeviceId } : undefined,
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
    this.resetPublishing();
    if (lease) this.releaseLease(lease);
  }

  // ---- screen share / camera -------------------------------------------------------------------

  /**
   * Must be called directly from a click handler: the browser picker needs transient activation, so capture happens
   * first; nothing is published until the server reserves capacity and grants the source. Denial stops every track.
   */
  async startScreenShare(quality: ScreenQuality, withAudio: boolean): Promise<ShareResult> {
    const room = this.room;
    const lease = this.leaseId;
    if (!room || !lease || this._sharing() !== 'off') return 'failed';
    const enc = SCREEN_ENCODING[quality];
    let tracks: LocalTrack[];
    try {
      tracks = await createLocalScreenTracks({
        audio: withAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
        systemAudio: withAudio ? 'include' : 'exclude',
        resolution: { width: enc.width, height: enc.height, frameRate: enc.fps },
        contentHint: 'motion',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      });
    } catch (e) {
      return (e as Error)?.name === 'NotAllowedError' || (e as Error)?.name === 'AbortError' ? 'denied' : 'failed';
    }
    const gen = this.generation;
    const video = tracks.find((t) => t.kind === Track.Kind.Video) as LocalVideoTrack | undefined;
    // Publish only audio the browser actually returned (window capture on Windows has none).
    const audio = tracks.find((t) => t.kind === Track.Kind.Audio);
    if (!video) {
      tracks.forEach((t) => t.stop());
      return 'failed';
    }
    this._sharing.set('starting');
    try {
      await this.api.post(`/voice/${lease}/publications/screen`, { quality, withAudio: !!audio });
      if (gen !== this.generation) throw new Error('stale');
      await this.waitForSource(room, Track.Source.ScreenShare);
      await room.localParticipant.publishTrack(video, {
        source: Track.Source.ScreenShare,
        simulcast: true,
        videoEncoding: { maxBitrate: enc.bitrate, maxFramerate: enc.fps },
        screenShareSimulcastLayers: enc.layers,
      });
      if (audio) {
        await this.waitForSource(room, Track.Source.ScreenShareAudio);
        await room.localParticipant.publishTrack(audio, { source: Track.Source.ScreenShareAudio, dtx: false, red: false, audioPreset: { maxBitrate: 128_000 } });
      }
    } catch (e) {
      tracks.forEach((t) => t.stop());
      this._sharing.set('off');
      if (gen === this.generation) {
        void this.api.delete(`/voice/${lease}/publications/screen`).catch(() => undefined);
        if (e instanceof ApiError || (e as Error)?.message !== 'stale') this.toast.show(ApiError.from(e).message, 'danger');
      }
      return 'failed';
    }
    this.screenTracks = tracks;
    // Ending capture from the browser's own "Stop sharing" bar stops both parts without leaving voice.
    video.mediaStreamTrack.addEventListener('ended', () => void this.stopScreenShare());
    this._shareHasAudio.set(!!audio);
    this._sharing.set('live');
    this.bump();
    return 'ok';
  }

  async stopScreenShare(): Promise<void> {
    if (this._sharing() === 'off') return;
    const tracks = this.screenTracks;
    this.screenTracks = [];
    this._sharing.set('off');
    this._shareHasAudio.set(false);
    const room = this.room;
    for (const t of tracks) {
      if (room) await room.localParticipant.unpublishTrack(t, true).catch(() => t.stop());
      else t.stop();
    }
    if (this.leaseId) void this.api.delete(`/voice/${this.leaseId}/publications/screen`).catch(() => undefined);
    this.bump();
  }

  async toggleCamera(): Promise<void> {
    const room = this.room;
    const lease = this.leaseId;
    if (!room || !lease || this._camera() === 'starting') return;
    if (this._camera() === 'on') {
      const t = this.cameraTrack;
      this.cameraTrack = undefined;
      this._camera.set('off');
      if (t) await room.localParticipant.unpublishTrack(t, true).catch(() => t.stop());
      void this.api.delete(`/voice/${lease}/publications/camera`).catch(() => undefined);
      this.bump();
      return;
    }
    const gen = this.generation;
    this._camera.set('starting');
    let track: LocalVideoTrack | undefined;
    try {
      const cam = this.mediaPrefs.prefs().cameraDeviceId;
      track = await createLocalVideoTrack({ deviceId: cam || undefined, resolution: { width: 1280, height: 720, frameRate: 30 } });
      await this.api.post(`/voice/${lease}/publications/camera`, {});
      if (gen !== this.generation) throw new Error('stale');
      await this.waitForSource(room, Track.Source.Camera);
      await room.localParticipant.publishTrack(track, { source: Track.Source.Camera, simulcast: true, videoEncoding: { maxBitrate: 1_200_000, maxFramerate: 30 } });
      this.cameraTrack = track;
      this._camera.set('on');
      this.bump();
    } catch (e) {
      track?.stop();
      this._camera.set('off');
      if (gen !== this.generation) return;
      void this.api.delete(`/voice/${lease}/publications/camera`).catch(() => undefined);
      const name = (e as Error)?.name;
      this.toast.show(name === 'NotAllowedError' ? 'Camera permission was denied.' : ApiError.from(e).message, 'danger');
    }
  }

  /** Ref-counted explicit video subscription: only streams on screen are received. */
  watchVideo(s: StreamInfo): void {
    if (!s.publication) return;
    const n = (this.videoWatchers.get(s.key) ?? 0) + 1;
    this.videoWatchers.set(s.key, n);
    if (n === 1) s.publication.setSubscribed(true);
  }

  unwatchVideo(s: StreamInfo): void {
    if (!s.publication) return;
    const n = (this.videoWatchers.get(s.key) ?? 1) - 1;
    if (n <= 0) {
      this.videoWatchers.delete(s.key);
      s.publication.setSubscribed(false);
    } else this.videoWatchers.set(s.key, n);
  }

  /** Stream audio is received only while that stream is being watched (it is independent of voice). */
  watchStreamAudio(s: StreamInfo): void {
    const pub = this.screenAudioPub(s);
    if (!pub) return;
    const n = (this.audioWatchers.get(s.key) ?? 0) + 1;
    this.audioWatchers.set(s.key, n);
    if (n === 1) pub.setSubscribed(true);
  }

  unwatchStreamAudio(s: StreamInfo): void {
    const pub = this.screenAudioPub(s);
    if (!pub) return;
    const n = (this.audioWatchers.get(s.key) ?? 1) - 1;
    if (n <= 0) {
      this.audioWatchers.delete(s.key);
      pub.setSubscribed(false);
    } else this.audioWatchers.set(s.key, n);
  }

  streamVolume(userId: string): number {
    return this._streamVolumes()[userId] ?? 1;
  }

  setStreamVolume(userId: string, volume: number): void {
    this._streamVolumes.update((m) => ({ ...m, [userId]: Math.max(0, Math.min(1, volume)) }));
    this.applyVolumes();
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
      .on(RoomEvent.ParticipantDisconnected, () => {
        if (!live()) return;
        this.refreshPeers();
        this.bump();
      })
      .on(RoomEvent.TrackPublished, (pub: RemoteTrackPublication, p: RemoteParticipant) => {
        if (!live()) return;
        // Voice is always heard; stream audio waits until someone watches that stream.
        if (pub.source === Track.Source.Microphone) pub.setSubscribed(true);
        if (isSoundboard(p)) this.syncSoundSubscription(pub);
        this.refreshPeers();
        this.bump();
      })
      .on(RoomEvent.TrackUnpublished, () => {
        if (!live()) return;
        this.refreshPeers();
        this.bump();
      })
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
        if (!live()) return;
        if (track.kind === Track.Kind.Audio && this.audioHost) {
          this.audioHost.appendChild(track.attach());
          if (isSoundboard(p)) this.applySoundVolume(pub);
          else this.applyVolumeFor(p);
        }
        this.bump();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) track.detach().forEach((el) => el.remove());
        if (live()) this.bump();
      })
      // Unsubscribing is immediate for us, but the track only ends after the SFU renegotiates: stop playing it now.
      .on(RoomEvent.TrackSubscriptionStatusChanged, (pub: RemoteTrackPublication, status: TrackPublication.SubscriptionStatus, p: RemoteParticipant) => {
        if (!live() || pub.kind !== Track.Kind.Audio || !pub.track) return;
        if (status === TrackPublication.SubscriptionStatus.Unsubscribed) pub.track.detach().forEach((el) => el.remove());
        else if (status === TrackPublication.SubscriptionStatus.Subscribed && pub.track.attachedElements.length === 0 && this.audioHost) {
          // Re-subscribed before the old track ended: TrackSubscribed does not fire again.
          this.audioHost.appendChild(pub.track.attach());
          if (isSoundboard(p)) this.applySoundVolume(pub);
          else this.applyVolumeFor(p);
        }
      })
      .on(RoomEvent.LocalTrackUnpublished, () => live() && this.bump())
      .on(RoomEvent.TrackMuted, () => live() && this.refreshPeers())
      .on(RoomEvent.TrackUnmuted, () => live() && this.refreshPeers())
      .on(RoomEvent.LocalTrackPublished, () => {
        if (!live()) return;
        this.refreshPeers();
        this.bump();
      })
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
        this.resetPublishing();
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
    if (isSoundboard(p)) {
      for (const pub of p.audioTrackPublications.values()) this.syncSoundSubscription(pub);
      return;
    }
    const mic = p.getTrackPublication(Track.Source.Microphone) as RemoteTrackPublication | undefined;
    if (mic && !mic.isSubscribed) mic.setSubscribed(true);
  }

  private bump(): void {
    this._version.update((v) => v + 1);
  }

  /** The server grants a source via RoomService; publishing before the grant reaches this client would be rejected. */
  private async waitForSource(room: Room, source: Track.Source): Promise<void> {
    const proto = Track.sourceToProto(source);
    for (let i = 0; i < 50; i++) {
      if (room.localParticipant.permissions?.canPublishSources?.includes(proto)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('The server did not grant publishing in time. Try again.');
  }

  private screenAudioPub(s: StreamInfo): RemoteTrackPublication | undefined {
    if (s.kind !== 'screen' || s.isLocal) return undefined;
    return this.room?.remoteParticipants.get(s.identity)?.getTrackPublication(Track.Source.ScreenShareAudio) as RemoteTrackPublication | undefined;
  }

  private resetPublishing(): void {
    this.screenTracks.forEach((t) => t.stop());
    this.screenTracks = [];
    this.cameraTrack?.stop();
    this.cameraTrack = undefined;
    this._sharing.set('off');
    this._shareHasAudio.set(false);
    this._camera.set('off');
    this.videoWatchers.clear();
    this.audioWatchers.clear();
    this.bump();
  }

  /** Microphone capture constraints from the user's device and processing choices. */
  private captureOptions() {
    const p = this.mediaPrefs.prefs();
    return {
      deviceId: p.inputDeviceId || undefined,
      echoCancellation: p.echoCancellation,
      noiseSuppression: p.noiseSuppression,
      autoGainControl: p.autoGainControl,
      channelCount: 1,
    };
  }

  private appliedDevices = { input: '', output: '', camera: '', capture: '' };

  private async applyDevicePrefs(input: string, output: string, camera: string): Promise<void> {
    const room = this.room;
    const capture = JSON.stringify(this.captureOptions());
    const prev = this.appliedDevices;
    this.appliedDevices = { input, output, camera, capture };
    if (!room || !this.connected()) return;
    try {
      if (output !== prev.output) await room.switchActiveDevice('audiooutput', output || 'default');
      const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
      if (mic && capture !== prev.capture) {
        const o = this.captureOptions();
        await mic.restartTrack({ ...o, deviceId: o.deviceId ? { exact: o.deviceId } : undefined });
      }
      if (this.cameraTrack && camera !== prev.camera) await this.cameraTrack.restartTrack({ deviceId: camera || undefined, resolution: { width: 1280, height: 720, frameRate: 30 } });
    } catch {
      this.toast.show('Could not switch to that device. It may be in use or unplugged.', 'warn');
    }
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
    for (const p of room.remoteParticipants.values()) {
      if (!isSoundboard(p)) {
        this.applyVolumeFor(p);
        continue;
      }
      for (const pub of p.audioTrackPublications.values()) {
        this.syncSoundSubscription(pub);
        this.applySoundVolume(pub);
      }
    }
  }

  /** Effects from muted actors (or with the soundboard muted) are not even received. */
  private syncSoundSubscription(pub: RemoteTrackPublication): void {
    const want = pub.kind === Track.Kind.Audio && this.soundAudible(pub);
    if (pub.isDesired !== want) pub.setSubscribed(want);
  }

  private applySoundVolume(pub: RemoteTrackPublication): void {
    if (pub.track) (pub.track as RemoteAudioTrack).setVolume(this._deafened() || !this.soundAudible(pub) ? 0 : this._sound().volume);
  }

  private soundAudible(pub: RemoteTrackPublication): boolean {
    const actor = pub.trackName.startsWith(SFX_PREFIX) ? pub.trackName.slice(SFX_PREFIX.length) : null;
    return !!actor && !this._sound().muted && !this._sound().mutedActors.includes(actor);
  }

  private updateSound(patch: Partial<SoundPrefs>): void {
    this._sound.update((s) => ({ ...s, ...patch }));
    try {
      localStorage.setItem(SOUND_KEY, JSON.stringify(this._sound()));
    } catch {
      /* storage unavailable */
    }
    this.applyVolumes();
  }

  private applyVolumeFor(p: RemoteParticipant): void {
    const uid = userIdOf(p);
    p.setVolume(this._deafened() ? 0 : uid ? this.volumeOf(uid) : 1, Track.Source.Microphone);
    p.setVolume(this._deafened() ? 0 : uid ? this.streamVolume(uid) : 1, Track.Source.ScreenShareAudio);
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

function isSoundboard(p: Participant): boolean {
  return p.identity.startsWith(SB_PREFIX);
}

function loadSoundPrefs(): SoundPrefs {
  const fallback: SoundPrefs = { volume: 0.8, muted: false, mutedActors: [] };
  try {
    const raw = JSON.parse(localStorage.getItem(SOUND_KEY) ?? 'null') as Partial<SoundPrefs> | null;
    if (!raw) return fallback;
    return {
      volume: typeof raw.volume === 'number' ? Math.max(0, Math.min(1, raw.volume)) : fallback.volume,
      muted: raw.muted === true,
      mutedActors: Array.isArray(raw.mutedActors) ? raw.mutedActors.filter((a): a is string => typeof a === 'string') : [],
    };
  } catch {
    return fallback;
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
