import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, Injectable, computed, effect, inject, signal, untracked, viewChild,
} from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ApiService } from '../../core/api/api.service';
import { ApiError } from '../../core/api/api-error';
import { SessionService } from '../../core/auth/session.service';
import { MediaSessionService } from '../../core/media/media-session.service';
import { RealtimeService, WatchState } from '../../core/realtime/realtime.service';
import { ToastService } from '../../core/ui/toast.service';
import { Icon } from '../../shared/ui/icon';
import { WorkspaceStore } from '../workspaces/workspace.store';

const YT_ORIGIN = 'https://www.youtube-nocookie.com';
const VOLUME_KEY = 'hangar.watchVolume';

interface Synced extends WatchState {
  /** serverNow − local clock at receipt, ms. */
  offsetMs: number;
}

/**
 * Watch together: the shared YouTube player of the voice channel I'm in. The API holds the state (who started it,
 * playing/paused, position, version) and pushes `watchChanged`; anyone in the call can control it.
 */
@Injectable({ providedIn: 'root' })
export class WatchTogether {
  private readonly api = inject(ApiService);
  private readonly media = inject(MediaSessionService);
  private readonly toast = inject(ToastService);
  private readonly states = signal<Record<string, Synced>>({});

  /** The voice room page puts the big player here; without it the player floats as a mini player. */
  readonly slot = signal<HTMLElement | null>(null);
  readonly dialogOpen = signal(false);

  /** The player of the call I'm in. */
  readonly active = computed(() => {
    const ch = this.media.connected() ? this.media.channelId() : null;
    return ch ? (this.states()[ch] ?? null) : null;
  });

  constructor() {
    inject(RealtimeService).onWatch((w) => this.apply(w.channelId, w.state));
    inject(SessionService).onTeardown(() => this.states.set({}));
    // Joining a call: fetch what it is watching (the push only covers changes).
    effect(() => {
      const ch = this.media.connected() ? this.media.channelId() : null;
      if (ch) untracked(() => void this.refresh(ch));
      else untracked(() => this.dialogOpen.set(false));
    });
  }

  stateOf(channelId: string): WatchState | null {
    return this.states()[channelId] ?? null;
  }

  /** Where playback should be now, seconds. */
  expectedPosition(s: Synced): number {
    if (!s.playing) return s.position;
    const serverNow = Date.now() + s.offsetMs;
    return s.position + Math.max(0, (serverNow - Date.parse(s.updatedAt)) / 1000);
  }

  async start(url: string): Promise<boolean> {
    const ch = this.media.channelId();
    if (!ch || !this.media.connected()) return false;
    try {
      const s = await this.api.put<WatchState>(`/channels/${ch}/watch`, { url });
      this.apply(ch, s);
      return true;
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'warn');
      return false;
    }
  }

  /** Starts a random Shorts feed for the call (replaces the list; it grows as the group scrolls). */
  async startShorts(): Promise<boolean> {
    const ch = this.media.channelId();
    if (!ch || !this.media.connected()) return false;
    try {
      this.apply(ch, await this.api.put<WatchState>(`/channels/${ch}/watch`, { shorts: true }));
      return true;
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'warn');
      return false;
    }
  }

  /** Appends links to the shared list (the current video keeps playing). */
  async add(links: string): Promise<boolean> {
    const ch = this.active()?.channelId;
    if (!ch) return false;
    try {
      this.apply(ch, await this.api.put<WatchState>(`/channels/${ch}/watch`, { add: links }));
      return true;
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'warn');
      return false;
    }
  }

  /**
   * Plays item `index` of the list for everyone. `fromIndex` (auto-advance at the end of a video): only if that item
   * is still playing, so every player in the call reporting the same end moves the list on once.
   */
  async jump(index: number, fromIndex?: number): Promise<void> {
    const s = this.active();
    if (!s || index < 0 || index >= s.queue.length) return;
    await this.control({ index, fromIndex });
  }

  async control(patch: { playing?: boolean; position?: number; index?: number; fromIndex?: number }): Promise<void> {
    const ch = this.active()?.channelId;
    if (!ch) return;
    try {
      this.apply(ch, await this.api.put<WatchState>(`/channels/${ch}/watch`, patch));
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'warn');
    }
  }

  async stop(): Promise<void> {
    const ch = this.active()?.channelId;
    if (!ch) return;
    try {
      await this.api.delete(`/channels/${ch}/watch`);
      this.apply(ch, null);
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'warn');
    }
  }

  private async refresh(channelId: string): Promise<void> {
    try {
      this.apply(channelId, (await this.api.get<WatchState | null>(`/channels/${channelId}/watch`)) ?? null);
    } catch {
      /* the next push corrects it */
    }
  }

  private apply(channelId: string, s: WatchState | null): void {
    const cur = this.states()[channelId];
    if (s && cur && cur.version > s.version) return; // late reply after a newer push
    this.states.update((m) => {
      const next = { ...m };
      if (s) next[channelId] = { ...s, offsetMs: Date.parse(s.serverNow) - Date.now() };
      else delete next[channelId];
      return next;
    });
  }
}

interface PlayerInfo {
  currentTime?: number;
  duration?: number;
  playerState?: number;
  videoData?: { title?: string };
}

/**
 * The one YouTube iframe (kept alive across navigation, so leaving the voice page doesn't stop it). Positioned over the
 * voice room's slot, or as a mini player in the corner. Controlled through YouTube's postMessage API — no YouTube
 * script runs in our page; our own controls sit over the video, so everyone's actions go through the shared state.
 */
@Component({
  selector: 'hx-watch-player',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (watch.active(); as s) {
      <section class="wt" [class.mini]="!watch.slot()" [class.short]="item()?.short" [style.left.px]="rect().left" [style.top.px]="rect().top"
               [style.width.px]="rect().width" [style.height.px]="rect().height" aria-label="Watch together" data-testid="watch-player">
        <div class="wt-frame">
          @if (src(); as u) {
            <iframe #frame [src]="u" title="YouTube video player" allow="autoplay; encrypted-media; picture-in-picture"
                    referrerpolicy="strict-origin-when-cross-origin" (load)="onFrameLoad()"></iframe>
          }
        </div>
        <!-- Clicks on the video go through our controls (the shared state), not YouTube's. With a list, the wheel and
             the arrow keys scroll through it like the Shorts feed, for everyone. -->
        <div class="wt-shield" tabindex="0" role="button" [attr.aria-label]="s.queue.length > 1 ? 'Play or pause. Scroll or use the arrow keys for the previous or next video' : 'Play or pause'"
             (click)="togglePlay()" (dblclick)="$event.stopPropagation()" (wheel)="onWheel($event)" (keydown)="onKey($event)"></div>
        <div class="wt-bar">
          <div class="wt-title" dir="auto" [title]="title()">{{ title() }} <span>· {{ starter() }}</span></div>
          <div class="wt-row">
            <button class="ibtn" [attr.aria-label]="s.playing ? 'Pause for everyone' : 'Play for everyone'" (click)="togglePlay()">
              <hx-icon [name]="s.playing ? 'pause' : 'play'" />
            </button>
            @if (s.queue.length > 1) {
              <button class="ibtn" aria-label="Previous video for everyone" title="Previous (scroll up)" [disabled]="s.index === 0" (click)="step(-1)"><hx-icon name="chevron-up" size="sm" /></button>
              <span class="mono wt-count" data-testid="watch-count">{{ s.feed ? '#' + (s.index + 1) : (s.index + 1) + '/' + s.queue.length }}</span>
              <button class="ibtn" aria-label="Next video for everyone" title="Next (scroll down)" [disabled]="s.index >= s.queue.length - 1" (click)="step(1)"><hx-icon name="chevron-down" size="sm" /></button>
            }
            <span class="mono wt-time">{{ clock(shownTime()) }} / {{ clock(duration()) }}</span>
            <input type="range" class="rng" min="0" [max]="duration() || 1" step="1" aria-label="Seek for everyone"
                   [value]="shownTime()" (input)="scrub.set(+$any($event.target).value)" (change)="seek(+$any($event.target).value)" />
            @if (!watch.slot()) {
              <a class="ibtn" [href]="voiceLink()" aria-label="Open the voice room" title="Open the voice room"><hx-icon name="expand" size="sm" /></a>
            }
            <hx-icon [name]="volume() === 0 || media.deafened() ? 'volume-x' : 'volume'" size="sm" style="color: var(--tx3)" />
            <input type="range" class="rng" min="0" max="100" step="1" style="max-width: 90px; min-width: 50px" aria-label="Video volume (only for you)"
                   [value]="volume()" (input)="setVolume(+$any($event.target).value)" />
            <button class="ibtn" aria-label="Add or change videos" title="Add or change videos" (click)="watch.dialogOpen.set(true)"><hx-icon name="link" size="sm" /></button>
            <button class="ibtn" aria-label="Stop watching together" title="Stop for everyone" (click)="watch.stop()"><hx-icon name="x" size="sm" /></button>
          </div>
        </div>
      </section>
    }

    @if (watch.dialogOpen()) {
      <div class="scrim" style="position: fixed; z-index: 45" (click)="watch.dialogOpen.set(false)">
        <form class="pop fade wt-dialog" role="dialog" aria-modal="true" aria-labelledby="wt-title" (click)="$event.stopPropagation()" (keydown.escape)="watch.dialogOpen.set(false)"
              (submit)="$event.preventDefault(); submit(false)"
              style="width: 440px; max-width: calc(100% - 32px); padding: 22px; display: flex; flex-direction: column; gap: 12px">
          <h2 id="wt-title" class="disp" style="margin: 0; font-size: 20px">Watch together</h2>
          <p style="margin: 0; color: var(--tx2); font-size: 13.5px">Paste YouTube links or Shorts, one or many. Everyone in the call watches in sync, and anyone in the call can pause or scroll to the next one.</p>
          <button type="button" class="btn sec" style="justify-content: flex-start; gap: 10px" [disabled]="busy()" (click)="shorts()" data-testid="watch-shorts">
            <hx-icon name="shuffle" size="sm" /><span style="flex: 1; text-align: left">Random Shorts<span style="display: block; color: var(--tx3); font-size: 12px; font-weight: 400">A fresh feed everyone scrolls together</span></span>
          </button>
          <div class="field"><label for="wt-url">YouTube links</label>
            <textarea #url id="wt-url" class="inp" rows="3" placeholder="https://youtube.com/shorts/…&#10;https://www.youtube.com/watch?v=…" autocomplete="off"
                      [value]="draft()" (input)="draft.set($any($event.target).value)" (keydown.enter)="onEnter($event)"></textarea>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap">
            <button type="button" class="btn sec" (click)="watch.dialogOpen.set(false)">Cancel</button>
            @if (watch.active()) {
              <button type="button" class="btn sec" [disabled]="busy() || !draft().trim()" (click)="submit(true)">Add to the list</button>
            }
            <button type="submit" class="btn pri" [disabled]="busy() || !draft().trim()">{{ watch.active() ? 'Play these instead' : 'Start' }}</button>
          </div>
        </form>
      </div>
    }
  `,
})
export class WatchPlayer {
  readonly watch = inject(WatchTogether);
  readonly media = inject(MediaSessionService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly workspace = inject(WorkspaceStore);
  private readonly frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');
  private readonly urlInput = viewChild<ElementRef<HTMLTextAreaElement>>('url');

  readonly rect = signal({ left: 0, top: 0, width: 384, height: 216 });
  readonly info = signal<PlayerInfo>({});
  /** While dragging the seek bar. */
  readonly scrub = signal<number | null>(null);
  readonly volume = signal(loadVolume());
  readonly draft = signal('');
  readonly busy = signal(false);
  private readonly tick = signal(0);
  private raf = 0;
  private syncTimer?: ReturnType<typeof setInterval>;
  private appliedVersion = -1;
  /** The version whose video end already asked for the next item (each player asks once). */
  private advancedFor = -1;
  private lastWheel = 0;

  readonly item = computed(() => {
    const s = this.watch.active();
    return s ? (s.queue?.[s.index] ?? { videoId: s.videoId, title: s.title, short: false }) : null;
  });
  /** The iframe URL, rebuilt only when the list moves to another item (the rest goes through postMessage). */
  private readonly itemKey = computed(() => {
    const s = this.watch.active();
    return s ? `${s.index}:${s.videoId}` : null;
  });
  readonly src = computed<SafeResourceUrl | null>(() => {
    if (!this.itemKey()) return null;
    const id = untracked(() => this.watch.active()?.videoId);
    if (!id) return null;
    const s = untracked(() => this.watch.active());
    const start = s ? Math.floor(this.watch.expectedPosition(s as Synced)) : 0;
    const q = new URLSearchParams({
      enablejsapi: '1', controls: '0', disablekb: '1', rel: '0', playsinline: '1', iv_load_policy: '3', fs: '0',
      autoplay: s?.playing ? '1' : '0', start: String(start), origin: location.origin,
    });
    // Only an 11-character id (validated by the API) is interpolated into a fixed YouTube embed URL.
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? this.sanitizer.bypassSecurityTrustResourceUrl(`${YT_ORIGIN}/embed/${id}?${q}`) : null;
  });

  readonly duration = computed(() => this.info().duration ?? 0);
  readonly title = computed(() => this.watch.active()?.title || this.info().videoData?.title || 'YouTube video');
  readonly starter = computed(() => {
    const s = this.watch.active();
    return s ? (s.feed ? 'Shorts feed, started by ' : 'started by ') + (this.workspace.memberById().get(s.startedBy)?.displayName ?? 'someone') : '';
  });
  readonly shownTime = computed(() => {
    this.tick();
    const scrub = this.scrub();
    if (scrub !== null) return scrub;
    const s = this.watch.active();
    return s ? Math.min(this.watch.expectedPosition(s as Synced), this.duration() || Infinity) : 0;
  });
  readonly voiceLink = computed(() => {
    const s = this.watch.active();
    return s ? `/s/${s.serverId}/v/${s.channelId}` : '/';
  });

  constructor() {
    const onMessage = (e: MessageEvent) => this.onMessage(e);
    window.addEventListener('message', onMessage);
    // Follow the slot (voice room) or sit in the corner.
    const place = () => {
      const slot = this.watch.slot();
      if (slot && slot.isConnected) {
        const r = slot.getBoundingClientRect();
        this.setRect({ left: r.left, top: r.top, width: r.width, height: r.height });
      } else {
        const w = Math.min(384, innerWidth - 32);
        this.setRect({ left: innerWidth - w - 16, top: innerHeight - w * 9 / 16 - 16 - 72, width: w, height: w * 9 / 16 + 72 });
      }
      this.raf = requestAnimationFrame(place);
    };
    effect(() => {
      const on = !!this.watch.active();
      untracked(() => {
        cancelAnimationFrame(this.raf);
        clearInterval(this.syncTimer);
        if (!on) {
          this.appliedVersion = -1;
          this.info.set({});
          return;
        }
        this.raf = requestAnimationFrame(place);
        this.syncTimer = setInterval(() => {
          this.tick.update((n) => n + 1);
          this.sync(false);
        }, 1000);
      });
    });
    // A new shared state (someone pressed play/pause/seek): apply it right away.
    effect(() => {
      const s = this.watch.active();
      if (s && s.version !== this.appliedVersion) untracked(() => this.sync(true));
    });
    // My volume, and silence while deafened (like the call).
    effect(() => {
      const v = this.volume();
      const deaf = this.media.deafened();
      untracked(() => this.applyVolume(v, deaf));
    });
    effect(() => {
      if (this.watch.dialogOpen()) {
        untracked(() => this.draft.set(''));
        queueMicrotask(() => this.urlInput()?.nativeElement.focus());
      }
    });
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('message', onMessage);
      cancelAnimationFrame(this.raf);
      clearInterval(this.syncTimer);
    });
  }

  async submit(append: boolean): Promise<void> {
    const links = this.draft().trim();
    if (!links || this.busy()) return;
    this.busy.set(true);
    const ok = append ? await this.watch.add(links) : await this.watch.start(links);
    this.busy.set(false);
    if (ok) this.watch.dialogOpen.set(false);
  }

  async shorts(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    const ok = await this.watch.startShorts();
    this.busy.set(false);
    if (ok) this.watch.dialogOpen.set(false);
  }

  /** Enter submits (Shift+Enter adds a line for another link). */
  onEnter(e: Event): void {
    if ((e as KeyboardEvent).shiftKey) return;
    e.preventDefault();
    void this.submit(false);
  }

  /** Previous (-1) or next (+1) item of the list, for everyone. */
  step(delta: number): void {
    const s = this.watch.active();
    if (s) void this.watch.jump(s.index + delta);
  }

  /** One scroll gesture = one video, like the Shorts feed (a trackpad sends many wheel events per swipe). */
  onWheel(e: WheelEvent): void {
    const s = this.watch.active();
    if (!s || s.queue.length < 2 || Math.abs(e.deltaY) < 8) return;
    e.preventDefault();
    const now = performance.now();
    if (now - this.lastWheel < 700) return;
    this.lastWheel = now;
    this.step(e.deltaY > 0 ? 1 : -1);
  }

  onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.step(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      this.togglePlay();
    }
  }

  togglePlay(): void {
    const s = this.watch.active();
    if (!s) return;
    // The server carries the position forward itself (YouTube's reported time can lag behind a seek while paused).
    void this.watch.control({ playing: !s.playing });
  }

  seek(seconds: number): void {
    this.scrub.set(null);
    void this.watch.control({ position: Math.max(0, seconds) });
  }

  setVolume(v: number): void {
    this.volume.set(v);
    try {
      localStorage.setItem(VOLUME_KEY, String(v));
    } catch {
      /* storage unavailable */
    }
  }

  clock(sec: number): string {
    if (!Number.isFinite(sec) || sec <= 0) return '0:00';
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  onFrameLoad(): void {
    this.appliedVersion = -1;
    // Ask the player to report its state (onReady / infoDelivery) to this window.
    let tries = 0;
    const listen = setInterval(() => {
      this.post({ event: 'listening', id: 'hangar', channel: 'widget' });
      if (++tries > 20 || this.info().playerState !== undefined) clearInterval(listen);
    }, 250);
  }

  private setRect(r: { left: number; top: number; width: number; height: number }): void {
    const c = this.rect();
    if (Math.abs(c.left - r.left) > 0.5 || Math.abs(c.top - r.top) > 0.5 || Math.abs(c.width - r.width) > 0.5 || Math.abs(c.height - r.height) > 0.5)
      this.rect.set(r);
  }

  private onMessage(e: MessageEvent): void {
    if (e.origin !== YT_ORIGIN || e.source !== this.frame()?.nativeElement.contentWindow) return;
    let data: { event?: string; info?: PlayerInfo | number };
    try {
      data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    } catch {
      return;
    }
    if (data.event === 'onReady') {
      this.applyVolume(this.volume(), this.media.deafened());
      this.sync(true);
    } else if ((data.event === 'infoDelivery' || data.event === 'initialDelivery') && data.info && typeof data.info === 'object') {
      const first = this.info().playerState === undefined;
      this.info.update((i) => ({ ...i, ...(data.info as PlayerInfo) }));
      if (first) this.sync(true);
    }
  }

  /** Brings the local player to the shared state: play/pause, and seek when it drifted. */
  private sync(force: boolean): void {
    const s = this.watch.active() as Synced | null;
    const info = this.info();
    if (!s || info.playerState === undefined) return;
    const target = this.watch.expectedPosition(s);
    const playing = info.playerState === 1 || info.playerState === 3; // playing, buffering
    // Ended: the player says so near the shared end (it can finish a moment before the shared clock; telling it to play
    // then would restart the video from 0), or the shared clock is past the end (a player that never reported it).
    const d = this.duration();
    const ended = d > 0 && ((info.playerState === 0 && target >= d - 3) || target >= d + 1.5);
    if (ended && s.playing) {
      // Ended for everyone: the next item of the list, once (the server ignores it if someone already moved on).
      if (s.index < s.queue.length - 1 && this.advancedFor !== s.version) {
        this.advancedFor = s.version;
        void this.watch.jump(s.index + 1, s.index);
      }
      return;
    }
    const drift = Math.abs((info.currentTime ?? 0) - target);
    if (force || drift > (s.playing ? 2.5 : 0.75)) this.command('seekTo', [target, true]);
    if (s.playing && !playing) this.command('playVideo');
    if (!s.playing && playing) this.command('pauseVideo');
    this.appliedVersion = s.version;
  }

  private applyVolume(v: number, deafened: boolean): void {
    if (deafened || v === 0) this.command('mute');
    else {
      this.command('unMute');
      this.command('setVolume', [v]);
    }
  }

  private command(func: string, args: unknown[] = []): void {
    this.post({ event: 'command', func, args, id: 'hangar', channel: 'widget' });
  }

  private post(msg: object): void {
    this.frame()?.nativeElement.contentWindow?.postMessage(JSON.stringify(msg), YT_ORIGIN);
  }
}

function loadVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(v) && localStorage.getItem(VOLUME_KEY) !== null ? Math.max(0, Math.min(100, v)) : 70;
  } catch {
    return 70;
  }
}
