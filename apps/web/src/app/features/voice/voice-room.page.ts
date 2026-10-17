import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { WorkspaceStore } from '../workspaces/workspace.store';

/** Voice channel view (filled in slice S4). */
@Component({
  selector: 'hx-voice-room-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div style="padding: 24px; color: var(--tx3)">{{ channel()?.name }}</div>`,
})
export class VoiceRoomPage {
  readonly channelId = input.required<string>();
  private readonly store = inject(WorkspaceStore);
  readonly channel = computed(() => this.store.channel(this.channelId()));
}
