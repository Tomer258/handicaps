import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ServerSummary } from '../../core/api/models';
import { ApiError } from '../../core/api/api-error';
import { SessionService } from '../../core/auth/session.service';

/** Install owner only: a new hangar with starter channels; people join it through its own invite links. */
@Component({
  selector: 'hx-create-server-dialog',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="pop fade" [formGroup]="form" (ngSubmit)="submit()" style="width: 440px; max-width: calc(100vw - 32px); padding: 22px; display: flex; flex-direction: column; gap: 14px">
      <h2 class="disp" style="margin: 0; font-size: 20px">Create a hangar</h2>
      <p style="margin: 0; color: var(--tx2); font-size: 13.5px">
        A separate place with its own channels, roles and invites. Only people you invite to it will see it.
      </p>
      <div class="field">
        <label for="srv-name">Name</label>
        <input id="srv-name" class="inp" formControlName="name" maxlength="48" dir="auto" cdkFocusInitial placeholder="Weekend squad" />
      </div>
      @if (error()) { <div class="note e" role="alert">{{ error() }}</div> }
      <div style="display: flex; justify-content: flex-end; gap: 8px">
        <button type="button" class="btn ghost" (click)="ref.close()">Cancel</button>
        <button type="submit" class="btn pri" [disabled]="form.invalid || busy()">{{ busy() ? 'Creating…' : 'Create' }}</button>
      </div>
    </form>
  `,
})
export class CreateServerDialog {
  readonly ref = inject<DialogRef<ServerSummary>>(DialogRef);
  private readonly session = inject(SessionService);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly form = inject(NonNullableFormBuilder).group({
    name: ['', [Validators.required, Validators.maxLength(48)]],
  });

  async submit(): Promise<void> {
    const name = this.form.getRawValue().name.trim();
    if (!name || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      this.ref.close(await this.session.createServer(name));
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }
}
