import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { ApiService } from '../../core/api/api.service';
import { ApiError } from '../../core/api/api-error';
import { MediaSessionService } from '../../core/media/media-session.service';
import { RealtimeService, SoundPlayback } from '../../core/realtime/realtime.service';
import { ToastService } from '../../core/ui/toast.service';
import { WorkspaceStore } from '../workspaces/workspace.store';

export interface Sound {
  id: string;
  name: string;
  emoji: string | null;
  durationMs: number;
  ownerUserId: string;
  state: 'pending' | 'ready' | 'rejected';
  rejectReason: string | null;
  favorite: boolean;
  canManage: boolean;
  createdAt: string;
}

export interface SoundCatalog {
  sounds: Sound[];
  canUpload: boolean;
  ownedCount: number;
  maxOwned: number;
}

const ACTIVE = new Set<SoundPlayback['state']>(['accepted', 'starting', 'playing']);
const RECENT_KEY = 'hangar.soundboardRecent';
const COOLDOWN_MS = 2000;

/** Readable messages for validator reject codes. */
export const REJECT_REASONS: Record<string, string> = {
  too_long: 'Longer than 5 seconds — trim it shorter.',
  too_short: 'Too short to hear.',
  silent: 'The clip is silent.',
  source_too_long: 'The source file is longer than 30 seconds.',
  decode_failed: 'The file could not be decoded as audio.',
  malformed: 'The file is damaged or not really audio.',
  unsupported_format: 'Unsupported audio format — use MP3, WAV or OGG.',
  unsupported_codec: 'Unsupported audio codec — use MP3, WAV or OGG.',
  unsupported_layout: 'Unsupported channel layout.',
  unexpected_streams: 'The file contains more than audio.',
  timeout: 'Processing took too long. Try a shorter file.',
  validator_timeout: 'Processing took too long. Try again.',
  duration: 'The processed clip has an invalid length.',
  output_invalid: 'Processing failed. Try another file.',
};

/**
 * Soundboard state for the selected server: catalog (refetched on catalogChanged hints), favorites, recent plays,
 * room playback state for the joined voice channel (REST snapshot + SignalR updates), cooldown and local preview.
 * Plays are authorized by the server against the current voice lease; the client only reflects the outcome.
 */
@Injectable({ providedIn: 'root' })
export class SoundboardStore {
  private readonly api = inject(ApiService);
  private readonly media = inject(MediaSessionService);
  private readonly realtime = inject(RealtimeService);
  private readonly workspace = inject(WorkspaceStore);
  private readonly toast = inject(ToastService);

  private readonly _catalog = signal<SoundCatalog | null>(null);
  private readonly _playbacks = signal<ReadonlyMap<string, SoundPlayback>>(new Map());
  private readonly _cooldownUntil = signal(0);
  private readonly _recent = signal<string[]>(loadRecent());
  private readonly _now = signal(Date.now());
  private readonly _busy = signal(false);

  readonly catalog = this._catalog.asReadonly();
  readonly now = this._now.asReadonly();
  readonly busy = this._busy.asReadonly();
  readonly sounds = computed(() => this._catalog()?.sounds ?? []);
  readonly ready = computed(() => this.sounds().filter((s) => s.state === 'ready'));
  readonly byId = computed(() => new Map(this.sounds().map((s) => [s.id, s])));
  readonly recent = computed(() => this._recent().map((id) => this.byId().get(id)).filter((s): s is Sound => s?.state === 'ready').slice(0, 6));
  /** Effects currently playing in my voice channel. */
  readonly playing = computed(() => [...this._playbacks().values()].filter((p) => ACTIVE.has(p.state)));
  readonly cooldownLeftMs = computed(() => Math.max(0, this._cooldownUntil() - this._now()));
  readonly inVoice = computed(() => this.media.connected() && !!this.media.channelId());

  private catalogTimer?: ReturnType<typeof setTimeout>;
  private ticker?: ReturnType<typeof setInterval>;
  private preview?: HTMLAudioElement;

  constructor() {
    // Catalog follows the selected server.
    effect(() => {
      const id = this.workspace.serverId();
      untracked(() => {
        this._catalog.set(null);
        if (id) void this.loadCatalog(id);
      });
    });
    // Playback snapshot follows the joined voice channel.
    effect(() => {
      const ch = this.media.connected() ? this.media.channelId() : null;
      untracked(() => {
        this._playbacks.set(new Map());
        if (ch) void this.loadPlaybacks(ch);
      });
    });
    // A clock only while something is animating (progress bars, cooldown countdown).
    effect(() => {
      const animate = this.playing().length > 0 || this.cooldownLeftMs() > 0;
      untracked(() => this.setTicking(animate));
    });

    this.realtime.onSoundCatalog((c) => {
      if (c.serverId !== this.workspace.serverId()) return;
      clearTimeout(this.catalogTimer);
      this.catalogTimer = setTimeout(() => void this.loadCatalog(c.serverId), 150);
    });
    this.realtime.onSoundPlayback((p) => {
      if (p.channelId !== this.media.channelId()) return;
      this._playbacks.update((m) => {
        const next = new Map(m);
        if (ACTIVE.has(p.state)) next.set(p.playbackId, p);
        else next.delete(p.playbackId);
        return next;
      });
    });
    this.realtime.onResubscribe(() => {
      const id = this.workspace.serverId();
      if (id) void this.loadCatalog(id);
      const ch = this.media.channelId();
      if (ch && this.media.connected()) void this.loadPlaybacks(ch);
    });
  }

  async refresh(): Promise<void> {
    const id = this.workspace.serverId();
    if (id) await this.loadCatalog(id);
  }

  /** Progress 0–100 of the playback of this sound in my channel, or null if it is not playing. */
  progressOf(soundId: string): number | null {
    const p = this.playing().find((x) => x.soundId === soundId);
    if (!p) return null;
    if (!p.startedAt || p.durationMs <= 0) return 0;
    return Math.min(100, Math.max(0, ((this._now() - Date.parse(p.startedAt)) / p.durationMs) * 100));
  }

  async play(sound: Sound): Promise<void> {
    const channelId = this.media.channelId();
    const leaseId = this.media.currentLeaseId();
    if (!channelId || !leaseId) {
      this.toast.show('Join a voice channel to play sounds.', 'warn');
      return;
    }
    if (this._busy() || this.cooldownLeftMs() > 0) return;
    this._busy.set(true);
    try {
      const p = await this.api.post<SoundPlayback>(`/channels/${channelId}/sound-plays`, {
        requestId: crypto.randomUUID(),
        voiceLeaseId: leaseId,
        soundId: sound.id,
      });
      if (ACTIVE.has(p.state)) this._playbacks.update((m) => new Map(m).set(p.playbackId, p));
      this.setCooldown(COOLDOWN_MS);
      this.pushRecent(sound.id);
    } catch (e) {
      const err = ApiError.from(e);
      if (err.status === 429 && err.retryAfterMs) this.setCooldown(err.retryAfterMs);
      this.toast.show(err.message, err.status === 429 || err.status === 409 ? 'warn' : 'danger');
    } finally {
      this._busy.set(false);
    }
  }

  async stop(playbackId: string): Promise<void> {
    try {
      await this.api.delete(`/sound-plays/${playbackId}`);
      this._playbacks.update((m) => {
        const next = new Map(m);
        next.delete(playbackId);
        return next;
      });
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'danger');
    }
  }

  async toggleFavorite(sound: Sound): Promise<void> {
    const favorite = !sound.favorite;
    this.patchSound(sound.id, { favorite });
    try {
      if (favorite) await this.api.put(`/sounds/${sound.id}/favorite`);
      else await this.api.delete(`/sounds/${sound.id}/favorite`);
    } catch (e) {
      this.patchSound(sound.id, { favorite: !favorite });
      this.toast.show(ApiError.from(e).message, 'danger');
    }
  }

  async remove(sound: Sound): Promise<void> {
    try {
      await this.api.delete(`/sounds/${sound.id}`);
      this._catalog.update((c) => (c ? { ...c, sounds: c.sounds.filter((s) => s.id !== sound.id) } : c));
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'danger');
    }
  }

  /** Local-only preview of the normalized clip at my soundboard volume (never sent to the room). */
  playPreview(sound: Sound): void {
    this.preview?.pause();
    const audio = new Audio(`/api/v1/sounds/${sound.id}/preview`);
    audio.volume = this.media.soundVolume();
    this.preview = audio;
    void audio.play().catch(() => undefined);
  }

  upsertLocal(sound: Sound): void {
    this._catalog.update((c) => {
      if (!c) return c;
      const exists = c.sounds.some((s) => s.id === sound.id);
      return { ...c, sounds: exists ? c.sounds.map((s) => (s.id === sound.id ? sound : s)) : [...c.sounds, sound] };
    });
  }

  private async loadCatalog(serverId: string): Promise<void> {
    try {
      const c = await this.api.get<SoundCatalog>(`/servers/${serverId}/sounds`);
      if (this.workspace.serverId() === serverId) this._catalog.set(c);
    } catch {
      /* catalog is refetched on the next hint or reconnect */
    }
  }

  private async loadPlaybacks(channelId: string): Promise<void> {
    try {
      const list = await this.api.get<SoundPlayback[]>(`/channels/${channelId}/sound-plays`);
      if (this.media.channelId() === channelId) this._playbacks.set(new Map(list.map((p) => [p.playbackId, p])));
    } catch {
      /* best effort */
    }
  }

  private patchSound(id: string, patch: Partial<Sound>): void {
    this._catalog.update((c) => (c ? { ...c, sounds: c.sounds.map((s) => (s.id === id ? { ...s, ...patch } : s)) } : c));
  }

  private setCooldown(ms: number): void {
    this._now.set(Date.now());
    this._cooldownUntil.set(Math.max(this._cooldownUntil(), Date.now() + ms));
  }

  private pushRecent(id: string): void {
    this._recent.update((r) => [id, ...r.filter((x) => x !== id)].slice(0, 12));
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(this._recent()));
    } catch {
      /* storage unavailable */
    }
  }

  private setTicking(on: boolean): void {
    if (on && !this.ticker) this.ticker = setInterval(() => this._now.set(Date.now()), 200);
    else if (!on && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
      this._now.set(Date.now());
    }
  }
}

function loadRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
