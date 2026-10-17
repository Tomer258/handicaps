import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { WorkspaceStore } from '../workspaces/workspace.store';

/** Text channel view (filled in slice S3). */
@Component({
  selector: 'hx-text-channel-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div style="padding: 24px; color: var(--tx3)"># {{ channel()?.name }}</div>`,
})
export class TextChannelPage {
  readonly channelId = input.required<string>();
  private readonly store = inject(WorkspaceStore);
  readonly channel = computed(() => this.store.channel(this.channelId()));
}
