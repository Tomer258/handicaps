import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, afterRenderEffect, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { Track } from 'livekit-client';
import { MediaSessionService, StreamInfo } from '../../core/media/media-session.service';

/** Renders one camera/screen stream. Subscribes while mounted (explicit subscriptions), detaches on destroy. */
@Component({
  selector: 'hx-stream-tile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <video #v autoplay playsinline muted [style.object-fit]="fit()"
           style="position: absolute; inset: 0; width: 100%; height: 100%; background: #000" [attr.aria-label]="label()"></video>
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
        }
        if (!this.ready()) this.ready.set(true);
      });
    });
  }

  ngOnDestroy(): void {
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
