import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { MediaSessionService } from '../../core/media/media-session.service';
import { Icon } from '../../shared/ui/icon';
import { openUserSettings } from '../settings/settings.dialog';

/** States 13: the camera didn't start for a reason Hangar can't fix (none plugged in, or another app holds it). */
@Component({
  selector: 'hx-camera-problem',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (media.cameraProblem(); as problem) {
      <div class="scrim" (click)="close()" (keydown.escape)="close()">
        <div class="pop fade" role="alertdialog" aria-modal="true" aria-labelledby="cam-title" aria-describedby="cam-desc" (click)="$event.stopPropagation()"
             style="width: 420px; max-width: calc(100% - 32px); padding: 24px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px">
          <span style="width: 48px; height: 48px; border-radius: 14px; background: var(--bg4); color: var(--tx3); display: grid; place-items: center; opacity: .8">
            <hx-icon name="camera-off" />
          </span>
          @if (problem === 'missing') {
            <h2 id="cam-title" class="disp" style="margin: 6px 0 0; font-size: 19px">No camera found</h2>
            <p id="cam-desc" style="margin: 0; color: var(--tx3); font-size: 13px">
              Plug one in, or check Windows Settings › Privacy › Camera for your browser. Voice and streaming keep working.
            </p>
          } @else {
            <h2 id="cam-title" class="disp" style="margin: 6px 0 0; font-size: 19px">Camera is busy</h2>
            <p id="cam-desc" style="margin: 0; color: var(--tx3); font-size: 13px">
              Another app (Zoom, Teams, OBS…) or browser tab is using it. Close that, then try again. Voice and streaming keep working.
            </p>
          }
          <div style="display: flex; gap: 8px; margin-top: 12px">
            <button class="btn ghost" (click)="close()">Close</button>
            <button class="btn sec" (click)="openVideoSettings()">Open video settings</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class CameraProblemDialog {
  readonly media = inject(MediaSessionService);
  private readonly dialog = inject(Dialog);

  close(): void {
    this.media.cameraProblem.set(null);
  }

  openVideoSettings(): void {
    this.close();
    openUserSettings(this.dialog, 'video');
  }
}
