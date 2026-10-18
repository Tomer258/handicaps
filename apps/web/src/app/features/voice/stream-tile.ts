import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, afterRenderEffect, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { Track } from 'livekit-client';
import { MediaSessionService, StreamInfo } from '../../core/media/media-session.service';

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
  private lastFrame = performance.now();
  private frameChain = 0;
  private readonly frameTimer = setInterval(() => this.frameGap.set(this.ready() && performance.now() - this.lastFrame > 2000), 500);
  private watched?: StreamInfo;
  private attached?: Track;

  readonly label = () => `${this.stream().name} ${this.stream().kind === 'screen' ? 'screen share' : 'camera'}`;

  constructor() {
    // (Re)subscribe when the tile is pointed at a different stream.
    effect(() => {
      const s = this.stream();
      untracked(() => {
        if (this.watched?.key === s.key && this.watched.publication === s.publication) {
          this.watched = s;
          return;
        }
        if (this.watched) this.media.unwatchVideo(this.watched);
        this.detach();
        this.watched = s;
        this.media.watchVideo(s);
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
      el.requestVideoFrameCallback(tick);
    };
    el.requestVideoFrameCallback(tick);
  }

  ngOnDestroy(): void {
    clearInterval(this.frameTimer);
    this.frameChain++;
    this.detach();
    if (this.watched) this.media.unwatchVideo(this.watched);
  }

  private detach(): void {
    if (this.attached) {
      this.attached.detach(this.video().nativeElement);
      this.attached = undefined;
    }
  }
}
