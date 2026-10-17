import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';

/** Full-window settings layer (expanded in slice S7). */
@Component({
  selector: 'hx-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pop" style="width: 100vw; height: 100dvh; border-radius: 0; display: grid; place-items: center">
      <div style="display: flex; flex-direction: column; gap: 12px; align-items: center">
        <h2 class="disp" style="margin: 0">Settings</h2>
        <button class="btn sec" (click)="ref.close()">Close</button>
      </div>
    </div>
  `,
})
export class SettingsDialog {
  readonly data = inject<{ section: string }>(DIALOG_DATA);
  readonly ref = inject(DialogRef);
}
