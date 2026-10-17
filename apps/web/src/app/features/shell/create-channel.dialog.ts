import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Channel, ChannelType } from '../../core/api/models';
import { ApiError } from '../../core/api/api-error';
import { WorkspaceStore } from '../workspaces/workspace.store';

@Component({
  selector: 'hx-create-channel-dialog',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="pop fade" [formGroup]="form" (ngSubmit)="submit()" style="width: 440px; max-width: calc(100vw - 32px); padding: 22px; display: flex; flex-direction: column; gap: 14px">
      <h2 class="disp" style="margin: 0; font-size: 20px">Create {{ data.type }} channel</h2>
      <div class="field">
        <label for="ch-name">Name</label>
        <input id="ch-name" class="inp" formControlName="name" maxlength="48" dir="auto" cdkFocusInitial
               [placeholder]="data.type === 'text' ? 'new-channel' : 'Squad'" />
      </div>
      @if (data.type === 'text') {
        <div class="field">
          <label for="ch-topic">Topic (optional)</label>
          <input id="ch-topic" class="inp" formControlName="topic" maxlength="240" dir="auto" />
        </div>
      }
      @if (error()) { <div class="note e" role="alert">{{ error() }}</div> }
      <div style="display: flex; justify-content: flex-end; gap: 8px">
        <button type="button" class="btn ghost" (click)="ref.close()">Cancel</button>
        <button type="submit" class="btn pri" [disabled]="form.invalid || busy()">Create</button>
      </div>
    </form>
  `,
})
export class CreateChannelDialog {
  readonly data = inject<{ type: ChannelType }>(DIALOG_DATA);
  readonly ref = inject<DialogRef<Channel>>(DialogRef);
  private readonly store = inject(WorkspaceStore);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly form = inject(NonNullableFormBuilder).group({
    name: ['', [Validators.required, Validators.maxLength(48)]],
    topic: [''],
  });

  async submit(): Promise<void> {
    if (this.form.invalid) return;
    this.busy.set(true);
    try {
      const { name, topic } = this.form.getRawValue();
      this.ref.close(await this.store.createChannel(this.data.type, name, topic || undefined));
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }
}
