import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { Router } from '@angular/router';
import { MediaSessionService } from '../../core/media/media-session.service';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { Icon } from '../../shared/ui/icon';
import { SettingsDialog } from '../settings/settings.dialog';
import { LayoutService } from './layout.service';

/**
 * Persistent voice connection panel above the user row (only while in voice). The button row (camera, screen share,
 * soundboard, voice settings) follows the prototype and works from any page, not only the voice view.
 */
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
        <div role="group" aria-label="Call actions" style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; margin-top: 10px">
          <button class="ibtn" [class.on]="media.camera() === 'on'" style="width: 100%; height: 34px; background: var(--bg4)"
                  [attr.aria-label]="media.camera() === 'on' ? 'Turn camera off' : 'Turn camera on'" [attr.aria-pressed]="media.camera() === 'on'"
                  [title]="media.canCamera() ? 'Camera' : 'You cannot use video in this channel'"
                  [disabled]="!media.canCamera() || media.camera() === 'starting'" (click)="media.toggleCamera()">
            <hx-icon [name]="media.camera() === 'on' ? 'camera' : 'camera-off'" />
          </button>
          <button class="ibtn" [class.on]="media.sharing() === 'live'" style="width: 100%; height: 34px; background: var(--bg4)"
                  [attr.aria-label]="media.sharing() === 'live' ? 'Stop sharing your screen' : 'Share your screen'" [attr.aria-pressed]="media.sharing() === 'live'"
                  [title]="media.canScreen() ? (media.sharing() === 'live' ? 'Stop sharing' : 'Share screen') : 'You cannot stream in this channel'"
                  [disabled]="!media.canScreen() || media.sharing() === 'starting'" (click)="share()">
            <hx-icon [name]="media.sharing() === 'live' ? 'screen-off' : 'screen'" />
          </button>
          <button class="ibtn sb" [class.on]="layout.soundboardOpen()" style="width: 100%; height: 34px; background: var(--bg4)"
                  aria-label="Soundboard" [attr.aria-pressed]="layout.soundboardOpen()" title="Soundboard"
                  (click)="layout.soundboardOpen.set(!layout.soundboardOpen())">
            <hx-icon name="soundboard" />
          </button>
          <button class="ibtn" style="width: 100%; height: 34px; background: var(--bg4)" aria-label="Voice settings" title="Voice settings" (click)="voiceSettings()">
            <hx-icon name="sliders" />
          </button>
        </div>
        <ng-content />
      </section>
    }
  `,
})
export class VoicePanel {
  readonly media = inject(MediaSessionService);
  readonly store = inject(WorkspaceStore);
  readonly layout = inject(LayoutService);
  private readonly router = inject(Router);
  private readonly dialog = inject(Dialog);

  readonly reconnecting = computed(() => this.media.connection() === 'reconnecting');
  readonly label = computed(() => (this.reconnecting() ? 'Reconnecting…' : 'Voice connected'));
  readonly color = computed(() => (this.reconnecting() ? 'var(--warn)' : 'var(--online)'));
  readonly channelName = computed(() => this.store.channel(this.media.channelId())?.name ?? 'Voice');

  openView(): void {
    const ch = this.store.channel(this.media.channelId());
    if (ch) void this.router.navigate(['/s', ch.serverId, 'v', ch.id]);
  }

  share(): void {
    if (this.media.sharing() === 'live') void this.media.stopScreenShare();
    else this.layout.shareOpen.set(true);
  }

  voiceSettings(): void {
    this.dialog.open(SettingsDialog, { data: { section: 'voice' }, ariaLabel: 'Settings', panelClass: 'hx-fullscreen-dialog', width: '100vw', height: '100dvh' });
  }

  leave(): void {
    void this.media.leave();
  }
}
