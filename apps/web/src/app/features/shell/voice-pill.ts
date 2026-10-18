import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { MediaSessionService } from '../../core/media/media-session.service';
import { Icon } from '../../shared/ui/icon';
import { WorkspaceStore } from '../workspaces/workspace.store';

/**
 * Narrow windows (< 820, Responsive.dc.html xs): the sidebar voice panel lives in the drawer, so voice controls
 * collapse into a pill above the composer.
 */
@Component({
  selector: 'hx-voice-pill',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (media.connected()) {
      <section class="fade" aria-label="Voice controls (compact)"
               style="display: flex; align-items: center; gap: 4px; margin: 0 16px 8px; padding: 4px 4px 4px 12px; border-radius: 999px; background: var(--bg3); border: 1px solid var(--line)">
        <span aria-hidden="true" style="width: 8px; height: 8px; border-radius: 50%; flex: none"
              [style.background]="reconnecting() ? 'var(--warn)' : 'var(--online)'"></span>
        <button (click)="openView()" style="flex: 1; min-width: 0; text-align: left; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">
          {{ reconnecting() ? 'Reconnecting…' : channelName() }}
        </button>
        <button class="ibtn" [class.bad]="media.muted()" [attr.aria-label]="media.muted() ? 'Unmute' : 'Mute'" [attr.aria-pressed]="media.muted()" (click)="media.toggleMute()">
          <hx-icon [name]="media.muted() ? 'mic-off' : 'mic'" />
        </button>
        <button class="ibtn" [class.bad]="media.deafened()" [attr.aria-label]="media.deafened() ? 'Undeafen' : 'Deafen'" [attr.aria-pressed]="media.deafened()" (click)="media.toggleDeafen()">
          <hx-icon [name]="media.deafened() ? 'headphones-off' : 'headphones'" />
        </button>
        <button class="ibtn leave" aria-label="Disconnect from voice" (click)="media.leave()"><hx-icon name="hangup" /></button>
      </section>
    }
  `,
})
export class VoicePill {
  readonly media = inject(MediaSessionService);
  private readonly store = inject(WorkspaceStore);
  private readonly router = inject(Router);

  readonly reconnecting = computed(() => this.media.connection() === 'reconnecting');
  readonly channelName = computed(() => this.store.channel(this.media.channelId())?.name ?? 'Voice');

  openView(): void {
    const ch = this.store.channel(this.media.channelId());
    if (ch) void this.router.navigate(['/s', ch.serverId, 'v', ch.id]);
  }
}
