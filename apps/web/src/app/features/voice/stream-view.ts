import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, effect, inject, input, model, signal, untracked, viewChild } from '@angular/core';
import { MediaSessionService, StreamInfo } from '../../core/media/media-session.service';
import { avatarColor, initials } from '../../shared/ui/avatar';
import { Icon } from '../../shared/ui/icon';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { StreamTile } from './stream-tile';

/**
 * Watching streams (prototype STREAM VIEW): focus = one large stage + thumbnails; grid = up to four tiles.
 * Video is subscribed per visible tile; stream audio only while watched, with its own per-stream volume.
 */
@Component({
  selector: 'hx-stream-view',
  imports: [StreamTile, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fade" style="flex: 1; min-height: 0; display: flex; flex-direction: column; background: #050608">
      @if (layout() === 'focus' && primary(); as p) {
        <div style="flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 14px; gap: 12px">
          <div #stage class="tile prim" style="flex: 1; min-height: 0; position: relative; border-radius: 14px">
            <hx-stream-tile [stream]="p" [fit]="fit()" />
            <div class="top">
              <span class="tag live">LIVE</span>
              @if (p.isLocal) { <span class="tag">Your stream</span> }
              <span style="flex: 1"></span>
              @if (p.hasAudio && !p.isLocal && media.streamVolume(p.userId) > 0) {
                <span class="tag" style="background: var(--accent); color: var(--accent-ink)"><span class="eq"><i></i><i></i><i></i></span>Stream audio</span>
              }
            </div>
            <div class="ovl" style="padding: 12px 14px">
              <span class="av s28" [style.background]="colorOf(p)">{{ iniOf(p) }}</span>
              <b style="font-size: 13.5px">{{ p.isLocal ? 'You' : p.name }}</b>
              <span style="flex: 1"></span>
              @if (p.hasAudio && !p.isLocal) {
                <button class="ctl" [attr.aria-label]="(media.streamVolume(p.userId) === 0 ? 'Unmute ' : 'Mute ') + p.name + ' stream'" (click)="toggleStreamMute(p)">
                  <hx-icon [name]="media.streamVolume(p.userId) === 0 ? 'volume-x' : 'volume'" />
                </button>
                <input type="range" class="rng" min="0" max="100" [value]="pct(media.streamVolume(p.userId))"
                       (input)="media.setStreamVolume(p.userId, +$any($event.target).value / 100)" [attr.aria-label]="p.name + ' stream volume'" style="max-width: 110px" />
                <span class="mono" style="font-size: 11px; width: 30px">{{ pct(media.streamVolume(p.userId)) }}%</span>
              }
              <div class="seg" role="group" aria-label="Video fit" style="background: rgba(255,255,255,.08); border-color: transparent">
                <button [attr.aria-pressed]="fit() === 'contain'" (click)="fit.set('contain')" style="color: #fff">Fit</button>
                <button [attr.aria-pressed]="fit() === 'cover'" (click)="fit.set('cover')" style="color: #fff">Fill</button>
              </div>
              @if (canPip) {
                <button class="ctl" aria-label="Pop out" title="Pop out (picture-in-picture)" (click)="popOut()"><hx-icon name="pip" /></button>
              }
              <button class="ctl" aria-label="Full screen" title="Full screen" (click)="fullscreen()"><hx-icon name="fullscreen" /></button>
            </div>
          </div>
          @if (streams().length > 1) {
            <div style="display: flex; gap: 10px; height: 112px; flex: none; overflow-x: auto">
              @for (s of streams(); track s.key) {
                <div class="tile" [class.prim]="s.key === p.key" style="width: 200px; flex: none">
                  <hx-stream-tile [stream]="s" fit="cover" [showLoading]="false" />
                  <button (click)="primaryKey.set(s.key)" [attr.aria-label]="'Watch ' + s.name" style="position: absolute; inset: 0"></button>
                  <div class="top" style="pointer-events: none">
                    <span class="tag live" style="height: 18px; font-size: 10px">LIVE</span>
                    @if (s.key === p.key) { <span class="tag" style="height: 18px; font-size: 10px">Watching</span> }
                  </div>
                  <div class="ovl" style="padding: 6px 8px; pointer-events: none"><span style="font-size: 12px; font-weight: 600; flex: 1">{{ s.isLocal ? 'You' : s.name }}</span></div>
                </div>
              }
              <div style="flex: 1; display: flex; align-items: center; justify-content: flex-end; gap: 8px; color: #9aa1ab; font-size: 12px; white-space: nowrap">Click a thumbnail to switch · audio is per stream</div>
            </div>
          }
        </div>
      } @else {
        <div style="flex: 1; min-height: 0; padding: 14px; display: grid; gap: 12px; align-content: center" [style.grid-template-columns]="gridCols()">
          @for (s of streams(); track s.key) {
            <div class="tile" style="aspect-ratio: 16/9; position: relative">
              <hx-stream-tile [stream]="s" fit="contain" />
              <div class="top"><span class="tag live">LIVE</span><span style="flex: 1"></span></div>
              <div class="ovl">
                <span class="av s20" [style.background]="colorOf(s)">{{ iniOf(s) }}</span>
                <b style="font-size: 12.5px; flex: 1">{{ s.isLocal ? 'You' : s.name }}</b>
                @if (s.hasAudio && !s.isLocal) {
                  <button class="ctl" style="width: 28px; height: 28px" [attr.aria-label]="(media.streamVolume(s.userId) === 0 ? 'Unmute ' : 'Mute ') + s.name + ' stream'" (click)="toggleStreamMute(s)">
                    <hx-icon [name]="media.streamVolume(s.userId) === 0 ? 'volume-x' : 'volume'" size="sm" />
                  </button>
                }
                <button class="ctl" style="width: 28px; height: 28px" [attr.aria-label]="'Focus ' + s.name" (click)="primaryKey.set(s.key); layout.set('focus')"><hx-icon name="expand" size="sm" /></button>
              </div>
            </div>
          }
        </div>
      }
    </div>
  `,
  host: { style: 'flex: 1; min-height: 0; display: flex; flex-direction: column' },
})
export class StreamView implements OnDestroy {
  readonly streams = input.required<StreamInfo[]>();
  readonly primaryKey = model<string | null>(null);
  readonly layout = model<'focus' | 'grid'>('focus');

  readonly media = inject(MediaSessionService);
  private readonly store = inject(WorkspaceStore);
  private readonly stage = viewChild<ElementRef<HTMLElement>>('stage');
  readonly fit = signal<'contain' | 'cover'>('contain');
  private readonly audible = new Map<string, StreamInfo>();
  private readonly restore = new Map<string, number>();

  readonly primary = computed(() => {
    const list = this.streams();
    return list.find((s) => s.key === this.primaryKey()) ?? list[0] ?? null;
  });
  readonly gridCols = computed(() => (this.streams().length <= 1 ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))'));

  constructor() {
    // Receive audio for exactly the streams being watched.
    effect(() => {
      const list = this.streams();
      untracked(() => {
        const keys = new Set(list.map((s) => s.key));
        for (const [key, s] of this.audible) if (!keys.has(key)) {
          this.media.unwatchStreamAudio(s);
          this.audible.delete(key);
        }
        for (const s of list) if (s.hasAudio && !this.audible.has(s.key)) {
          this.media.watchStreamAudio(s);
          this.audible.set(s.key, s);
        }
      });
    });
  }

  ngOnDestroy(): void {
    for (const s of this.audible.values()) this.media.unwatchStreamAudio(s);
    this.audible.clear();
  }

  toggleStreamMute(s: StreamInfo): void {
    const v = this.media.streamVolume(s.userId);
    if (v === 0) this.media.setStreamVolume(s.userId, this.restore.get(s.userId) ?? 1);
    else {
      this.restore.set(s.userId, v);
      this.media.setStreamVolume(s.userId, 0);
    }
  }

  readonly canPip = typeof document !== 'undefined' && !!document.pictureInPictureEnabled;

  /** Keeps the primary stream on top while the user works in another window or tab. */
  popOut(): void {
    const video = this.stage()?.nativeElement.querySelector('video');
    if (!video) return;
    if (document.pictureInPictureElement === video) void document.exitPictureInPicture().catch(() => undefined);
    else void video.requestPictureInPicture().catch(() => undefined);
  }

  fullscreen(): void {
    void this.stage()?.nativeElement.requestFullscreen?.().catch(() => undefined);
  }

  colorOf(s: StreamInfo): string {
    return avatarColor(this.store.memberById().get(s.userId)?.avatarHue ?? 210);
  }

  iniOf(s: StreamInfo): string {
    return initials(this.store.memberById().get(s.userId)?.displayName ?? s.name);
  }

  pct(v: number): number {
    return Math.round(v * 100);
  }
}
