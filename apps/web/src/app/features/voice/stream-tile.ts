import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, afterRenderEffect, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { Track } from 'livekit-client';
import { MediaSessionService, StreamInfo, WatchRole } from '../../core/media/media-session.service';
import { NetStats, NetStatsReader, streamStatsOpen } from './stream-stats';

/** Renders one camera/screen stream. Subscribes while mounted (explicit subscriptions), detaches on destroy. */
@Component({
  selector: 'hx-stream-tile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <video #v autoplay playsinline muted [style.object-fit]="fit()" (waiting)="waiting.set(true)" (playing)="waiting.set(false)" (resize)="readHeight()"
           style="position: absolute; inset: 0; width: 100%; height: 100%; background: #000" [attr.aria-label]="label()"></video>
    @if (ready() && showLoading() && buffering()) {
      <div role="status" style="position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.55)">
        <div style="display: flex; flex-direction: column; align-items: center; gap: 10px; color: #fff">
          <div class="spin"></div><span style="font-size: 12.5px">{{ bufferingText() }}</span>
        </div>
      </div>
    }
    @if (ready() && showLoading() && weak()) {
      <span class="tag" style="position: absolute; left: 8px; top: 8px; background: var(--warn); color: #1D1300">Weak connection</span>
    }
    @if (!ready() && showLoading()) {
      <div style="position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.6)">
        <div style="display: flex; flex-direction: column; align-items: center; gap: 12px; color: #fff">
          <div class="spin"></div><div style="font-size: 13px">Connecting to {{ stream().name }}'s {{ stream().kind === 'screen' ? 'stream' : 'camera' }}…</div>
        </div>
      </div>
    }
  `,
  host: { style: 'position: absolute; inset: 0; display: block' },
})
export class StreamTile implements OnDestroy {
  readonly stream = input.required<StreamInfo>();
  readonly fit = input<'contain' | 'cover'>('contain');
  readonly showLoading = input(true);
  /** full = the main layer (someone is watching this tile) · thumb = the small layer (cards, strips). */
  readonly watch = input<WatchRole>('full');
  /** Read WebRTC network stats while the stats panel is open (the big stage and grid tiles, not thumbnails). */
  readonly detailed = input(false);

  private readonly media = inject(MediaSessionService);
  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('v');
  readonly ready = signal(false);
  /** The element ran out of frames (the browser's own "waiting"), or frames stopped while a link is weak. */
  readonly waiting = signal(false);
  private readonly frameGap = signal(false);
  private readonly height = signal(0);
  readonly weak = computed(() => !this.stream().isLocal && (this.media.weakLink() || this.media.weakLinkOf(this.stream().identity)));
  readonly buffering = computed(() => !this.stream().isLocal && (this.waiting() || (this.frameGap() && this.weak())));
  /** States 09: the SFU drops to a lower simulcast layer under congestion; say so when the received picture is smaller. */
  readonly bufferingText = computed(() => {
    const got = this.height();
    const source = this.stream().publication?.dimensions?.height ?? 0;
    return got && source && got < source - 8 ? `Buffering — dropping to ${got}p to keep up` : 'Buffering…';
  });
  /**
   * What is being shown right now: the received picture size and the frames actually painted per second (measured once
   * a second from the video element, so it costs nothing and never touches the stream). Null until frames arrive.
   */
  readonly stats = signal<{ width: number; height: number; fps: number } | null>(null);
  /** "1080p · 60 fps" for the corner of the stream. */
  readonly statsText = computed(() => {
    const s = this.stats();
    return s ? `${s.height}p · ${s.fps} fps` : '';
  });
  /** The tooltip: exact size, and why it is smaller than what the streamer sends (the SFU picks a layer per viewer). */
  readonly statsTitle = computed(() => {
    const s = this.stats();
    if (!s) return '';
    const source = this.stream().publication?.dimensions?.height ?? 0;
    const lower = !this.stream().isLocal && source > s.height + 8
      ? ` — the stream is ${source}p; a lower layer is sent while your connection can't take the full one` : '';
    return `Watching ${s.width}×${s.height} at ${s.fps} frames per second${lower}`;
  });
  /** Live network numbers (bitrate, loss, ping…) while the stats panel is open; null otherwise. */
  readonly net = signal<NetStats | null>(null);
  private readonly netReader = new NetStatsReader();
  private lastFrame = performance.now();
  private frameChain = 0;
  private frames = 0;
  private statsAt = performance.now();
  private readonly frameTimer = setInterval(() => this.frameGap.set(this.ready() && performance.now() - this.lastFrame > 2000), 500);
  private readonly statsTimer = setInterval(() => this.measure(), 1000);
  private watched?: StreamInfo;
  private watchedAs: WatchRole = 'full';
  private attached?: Track;

  readonly label = () => `${this.stream().name} ${this.stream().kind === 'screen' ? 'screen share' : 'camera'}`;

  constructor() {
    // (Re)subscribe when the tile is pointed at a different stream.
    effect(() => {
      const s = this.stream();
      const role = this.watch();
      untracked(() => {
        if (this.watched?.key === s.key && this.watched.publication === s.publication && this.watchedAs === role) {
          this.watched = s;
          return;
        }
        const same = this.watched?.key === s.key && this.watched.publication === s.publication;
        // Take the new role before giving up the old one, so a role change never unsubscribes in between.
        this.media.watchVideo(s, role);
        if (this.watched) this.media.unwatchVideo(this.watched, this.watchedAs);
        if (!same) this.detach();
        this.watched = s;
        this.watchedAs = role;
      });
    });
    // Attach once the track exists (subscription completes asynchronously).
    afterRenderEffect(() => {
      this.media.version();
      const s = this.stream();
      untracked(() => {
        const track = s.isLocal ? s.localTrack : s.publication?.track;
        const el = this.video().nativeElement;
        if (!track) {
          this.ready.set(false);
          return;
        }
        if (track !== this.attached) {
          this.detach();
          track.attach(el);
          this.attached = track;
          this.lastFrame = performance.now();
          this.watchFrames(el);
        }
        if (!this.ready()) this.ready.set(true);
      });
    });
  }

  readHeight(): void {
    this.height.set(this.video().nativeElement.videoHeight);
  }

  private watchFrames(el: HTMLVideoElement): void {
    if (!('requestVideoFrameCallback' in el)) return;
    const chain = ++this.frameChain;
    const tick = () => {
      if (chain !== this.frameChain) return;
      this.lastFrame = performance.now();
      this.frames++;
      el.requestVideoFrameCallback(tick);
    };
    el.requestVideoFrameCallback(tick);
  }

  private measure(): void {
    const el = this.video().nativeElement;
    const now = performance.now();
    const fps = Math.round((this.frames * 1000) / Math.max(1, now - this.statsAt));
    this.frames = 0;
    this.statsAt = now;
    // Hidden tab: no frames are painted, so there is nothing honest to show; keep the last reading.
    if (document.hidden) return;
    const next = this.ready() && el.videoHeight > 0 ? { width: el.videoWidth, height: el.videoHeight, fps } : null;
    const cur = this.stats();
    if (next?.width !== cur?.width || next?.height !== cur?.height || next?.fps !== cur?.fps) this.stats.set(next);
    void this.readNet();
  }

  private async readNet(): Promise<void> {
    const s = this.stream();
    const track = s.isLocal ? s.localTrack : s.publication?.track;
    if (!this.detailed() || !streamStatsOpen() || !track) {
      if (this.net()) this.net.set(null);
      this.netReader.reset();
      return;
    }
    const report = await track.getRTCStatsReport().catch(() => undefined);
    if (report) this.net.set(this.netReader.read(report, s.isLocal ? 'out' : 'in'));
  }

  ngOnDestroy(): void {
    clearInterval(this.frameTimer);
    clearInterval(this.statsTimer);
    this.frameChain++;
    this.detach();
    if (this.watched) this.media.unwatchVideo(this.watched, this.watchedAs);
  }

  private detach(): void {
    if (this.attached) {
      this.attached.detach(this.video().nativeElement);
      this.attached = undefined;
    }
  }
}
