import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { MediaSessionService } from '../../core/media/media-session.service';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { Icon } from '../../shared/ui/icon';

/** Persistent voice connection panel above the user row (only while in voice). */
@Component({
  selector: 'hx-voice-panel',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (media.connected()) {
      <section aria-label="Voice connection" class="fade"
               style="margin: 0 8px; padding: 10px; border-radius: 12px 12px 0 0; background: var(--bg2); border: 1px solid var(--line); border-bottom: 0">
        <div style="display: flex; align-items: center; gap: 10px">
          <div style="display: flex; align-items: flex-end; gap: 2px; height: 14px" role="img" [attr.aria-label]="label()" [title]="label()">
            <i style="width: 3px; height: 5px; border-radius: 1px" [style.background]="color()"></i>
            <i style="width: 3px; height: 9px; border-radius: 1px" [style.background]="color()"></i>
            <i style="width: 3px; height: 14px; border-radius: 1px" [style.background]="reconnecting() ? 'var(--line2)' : color()"></i>
          </div>
          <button (click)="openView()" style="flex: 1; min-width: 0; text-align: left">
            <div style="font-size: 12.5px; font-weight: 600" [style.color]="color()">{{ label() }}</div>
            <div style="font-size: 12px; color: var(--tx3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{{ channelName() }} / {{ store.server()?.name }}</div>
          </button>
          <button class="ibtn leave" aria-label="Disconnect from voice" title="Disconnect" (click)="leave()"><hx-icon name="hangup" /></button>
        </div>
        <ng-content />
      </section>
    }
  `,
})
export class VoicePanel {
  readonly media = inject(MediaSessionService);
  readonly store = inject(WorkspaceStore);
  private readonly router = inject(Router);

  readonly reconnecting = computed(() => this.media.connection() === 'reconnecting');
  readonly label = computed(() => (this.reconnecting() ? 'Reconnecting…' : 'Voice connected'));
  readonly color = computed(() => (this.reconnecting() ? 'var(--warn)' : 'var(--online)'));
  readonly channelName = computed(() => this.store.channel(this.media.channelId())?.name ?? 'Voice');

  openView(): void {
    const ch = this.store.channel(this.media.channelId());
    if (ch) void this.router.navigate(['/s', ch.serverId, 'v', ch.id]);
  }

  leave(): void {
    // Implemented with the LiveKit session in S4.
  }
}
