import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import { MediaPrefsService } from '../../core/media/media-prefs.service';
import { MediaSessionService, ScreenQuality } from '../../core/media/media-session.service';
import { Icon } from '../../shared/ui/icon';

/** "Go live" setup (prototype SHARE SCREEN FLOW). The real browser picker opens from the button click itself. */
@Component({
  selector: 'hx-share-dialog',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="closed.emit()" (keydown.escape)="closed.emit()">
      @if (!denied()) {
        <div class="pop fade" role="dialog" aria-modal="true" aria-labelledby="share-title" (click)="$event.stopPropagation()"
             style="width: 520px; max-width: calc(100% - 32px); padding: 22px">
          <div style="display: flex; align-items: center; gap: 12px">
            <span style="width: 36px; height: 36px; border-radius: 10px; background: var(--live); color: #fff; display: grid; place-items: center"><hx-icon name="screen" /></span>
            <div>
              <h2 id="share-title" class="disp" style="margin: 0; font-size: 20px">Go live in {{ channelName() }}</h2>
              <div style="font-size: 12.5px; color: var(--tx3)">{{ viewers() }} {{ viewers() === 1 ? 'friend' : 'friends' }} will be able to watch</div>
            </div>
          </div>
          <div class="lbl" style="margin: 20px 0 8px">Quality</div>
          <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px" role="radiogroup" aria-label="Quality">
            <button class="card" role="radio" [attr.aria-checked]="quality() === '1080p60'" (click)="quality.set('1080p60')" style="text-align: left"
                    [style.border-color]="quality() === '1080p60' ? 'var(--accent)' : null" [style.box-shadow]="quality() === '1080p60' ? '0 0 0 1px var(--accent)' : null">
              <div style="display: flex; justify-content: space-between"><b class="disp" style="font-size: 17px">1080p · 60</b>
                <span style="font-size: 10.5px; font-weight: 600; color: var(--accent-tx)">RECOMMENDED</span></div>
              <div style="font-size: 12px; color: var(--tx3); margin-top: 4px">Crisp game streams. Needs about 8 Mbps upload.</div>
            </button>
            <button class="card" role="radio" [attr.aria-checked]="quality() === '720p30'" (click)="quality.set('720p30')" style="text-align: left"
                    [style.border-color]="quality() === '720p30' ? 'var(--accent)' : null" [style.box-shadow]="quality() === '720p30' ? '0 0 0 1px var(--accent)' : null">
              <b class="disp" style="font-size: 17px">720p · 30</b>
              <div style="font-size: 12px; color: var(--tx3); margin-top: 4px">Fallback for weaker connections. About 2.5 Mbps.</div>
            </button>
          </div>
          <div class="srow" style="border-bottom: 0; padding-bottom: 4px">
            <div><div class="t">Include system audio</div><div class="d">So friends hear the game, not just see it</div></div>
            <button class="sw" [attr.aria-pressed]="audio()" aria-label="Include system audio" (click)="audio.set(!audio())"></button>
          </div>
          <div class="note" style="margin-top: 8px">
            <hx-icon name="info" size="sm" style="color: var(--tx3); margin-top: 1px" />
            <span>On Windows, Chrome and Edge can capture audio from an <b>entire screen</b> or a <b>browser tab</b>. A single app window shares video only — pick Entire screen if friends should hear the game. Sound playing in this browser itself isn't included (so friends don't hear themselves) — share that tab for it.</span>
          </div>
          <div class="note" style="margin-top: 16px; background: transparent">
            <hx-icon name="lock" size="sm" style="color: var(--accent-tx); margin-top: 1px" />
            <span>Next, <b>your browser</b> asks what to share — a screen, a window or a tab. Hangar can't see or pick anything until you choose there.</span>
          </div>
          @if (audioFailed() === 'clean') {
            <div class="note w" role="alert" style="margin-top: 12px">
              <hx-icon name="alert-triangle" size="sm" style="margin-top: 1px" />
              <span>The browser couldn't start this PC's sound in high-quality mode, so nothing was shared.
                <b>Try again with sound</b> retries in compatibility mode (the browser's default audio settings), which often works when this happens — pick the screen once more.</span>
            </div>
          } @else if (audioFailed() === 'compat') {
            <div class="note w" role="alert" style="margin-top: 12px">
              <hx-icon name="alert-triangle" size="sm" style="margin-top: 1px" />
              <span>This browser can't capture the sound of this screen on this PC (it said: <span class="mono">{{ media.lastCaptureError() }}</span>).
                Share without sound, or share a <b>browser tab</b> instead — tab sound comes straight from the browser and always works.</span>
            </div>
          }
          <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px">
            <button class="btn ghost" (click)="closed.emit()">Cancel</button>
            @if (audioFailed() === 'clean') {
              <button class="btn sec" (click)="start(false)" [disabled]="busy()">Share without sound</button>
              <button class="btn pri" (click)="start(true, true)" [disabled]="busy()">Try again with sound</button>
            } @else if (audioFailed() === 'compat') {
              <button class="btn sec" (click)="start(true, true)" [disabled]="busy()">Share a tab with sound</button>
              <button class="btn pri" (click)="start(false)" [disabled]="busy()">Share without sound</button>
            } @else {
              <button class="btn pri" (click)="start()" [disabled]="busy()">Choose what to share</button>
            }
          </div>
        </div>
      } @else {
        <div class="pop fade" role="alertdialog" aria-modal="true" aria-labelledby="denied-title" (click)="$event.stopPropagation()"
             style="width: 460px; max-width: calc(100% - 32px); padding: 22px">
          <span style="width: 40px; height: 40px; border-radius: 12px; background: color-mix(in oklab,var(--danger) 20%,transparent); color: var(--danger); display: grid; place-items: center"><hx-icon name="screen-off" /></span>
          <h2 id="denied-title" class="disp" style="margin: 14px 0 6px; font-size: 20px">Screen sharing didn't start</h2>
          <p style="margin: 0; color: var(--tx2); font-size: 13.5px">The browser dialog was closed or permission was denied. Nothing was shared.</p>
          <ol style="margin: 14px 0 0; padding-left: 18px; color: var(--tx2); font-size: 13px; display: flex; flex-direction: column; gap: 4px">
            <li>Try again and pick a screen, window or tab.</li>
            <li>If no dialog appears: click the site icon left of the address bar › <b>Screen sharing</b> › Allow.</li>
            <li>On Windows, check Settings › Privacy › Screen capture for your browser.</li>
          </ol>
          <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px">
            <button class="btn ghost" (click)="closed.emit()">Close</button>
            <button class="btn pri" (click)="start()">Try again</button>
          </div>
        </div>
      }
    </div>
  `,
})
export class ShareDialog {
  readonly channelName = input('voice');
  readonly viewers = input(0);
  readonly closed = output<void>();

  readonly media = inject(MediaSessionService);
  readonly quality = signal<ScreenQuality>(inject(MediaPrefsService).prefs().streamQuality);
  readonly audio = signal(true);
  readonly denied = signal(false);
  readonly busy = signal(false);
  /** Which sound capture mode failed: offer the next step instead of failing the share. */
  readonly audioFailed = signal<'clean' | 'compat' | null>(null);

  private done = false;

  constructor() {
    // Capture picked: the room shows "Going live" while the stream negotiates (States 08), so get out of the way.
    effect(() => {
      if (this.busy() && this.media.sharing() === 'starting') untracked(() => this.close());
    });
  }

  /** Runs inside the click: startScreenShare calls getDisplayMedia before any await. */
  async start(withAudio = this.audio(), compat?: boolean): Promise<void> {
    this.busy.set(true);
    const result = await this.media.startScreenShare(this.quality(), withAudio, compat);
    this.busy.set(false);
    // Stay open after a sound failure: the next step is one click (a fresh user gesture, which the picker needs).
    if (result === 'denied') this.denied.set(true);
    else if (result === 'audio-failed') this.audioFailed.set('clean');
    else if (result === 'audio-failed-compat') this.audioFailed.set('compat');
    else this.close();
  }

  private close(): void {
    if (this.done) return;
    this.done = true;
    this.closed.emit();
  }
}
