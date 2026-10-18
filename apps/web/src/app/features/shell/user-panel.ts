import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { SessionService } from '../../core/auth/session.service';
import { Avatar } from '../../shared/ui/avatar';
import { Icon } from '../../shared/ui/icon';
import { MediaSessionService } from '../../core/media/media-session.service';
import { PresenceStore } from '../presence/presence.store';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { SettingsSection, openUserSettings } from '../settings/settings.dialog';

/**
 * Mic and deafen live on the user row so they are always in the same place — connected or not.
 */
@Component({
  selector: 'hx-user-panel',
  imports: [Avatar, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div style="display: flex; align-items: center; gap: 8px; padding: 8px; margin: 0 8px 8px; background: var(--bg2); border: 1px solid var(--line)"
         [style.border-radius]="voice.connected() ? '0 0 12px 12px' : '12px'">
      <button (click)="openSettings('account')" style="display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; padding: 2px 4px; border-radius: 8px; text-align: left"
              aria-label="Your profile and settings">
        <hx-avatar [name]="name()" [hue]="session.user()?.avatarHue ?? 200" [assetId]="session.user()?.avatarAssetId" [size]="32" [status]="presence.myStatus()" surface="var(--bg2)" [speaking]="meSpeaking()" />
        <span style="min-width: 0">
          <span style="display: block; font-weight: 600; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis" dir="auto">{{ name() }}</span>
          <span style="display: block; font-size: 11.5px; color: var(--tx3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{{ subtitle() }}</span>
        </span>
      </button>
      <button class="ibtn" [class.bad]="voice.muted()" [attr.aria-label]="voice.muted() ? 'Unmute' : 'Mute'" [attr.aria-pressed]="voice.muted()"
              [title]="(voice.muted() ? 'Unmute' : 'Mute') + ' (Ctrl+Shift+M)'" (click)="voice.toggleMute()">
        <hx-icon [name]="voice.muted() ? 'mic-off' : 'mic'" />
      </button>
      <button class="ibtn" [class.bad]="voice.deafened()" [attr.aria-label]="voice.deafened() ? 'Undeafen' : 'Deafen'" [attr.aria-pressed]="voice.deafened()"
              [title]="(voice.deafened() ? 'Undeafen' : 'Deafen') + ' (Ctrl+Shift+D)'" (click)="voice.toggleDeafen()">
        <hx-icon [name]="voice.deafened() ? 'headphones-off' : 'headphones'" />
      </button>
      <button class="ibtn" aria-label="User settings" title="Settings" (click)="openSettings('account')"><hx-icon name="settings" /></button>
    </div>
  `,
})
export class UserPanel {
  readonly session = inject(SessionService);
  readonly voice = inject(MediaSessionService);
  readonly presence = inject(PresenceStore);
  private readonly store = inject(WorkspaceStore);
  private readonly dialog = inject(Dialog);

  readonly name = computed(() => this.session.user()?.displayName ?? '');
  readonly meSpeaking = computed(() => {
    const id = this.session.userId();
    return !!id && this.voice.speaking().has(id);
  });
  readonly subtitle = computed(() => {
    const ch = this.voice.connected() ? this.store.channel(this.voice.channelId()) : undefined;
    if (ch) return `In ${ch.name}`;
    const labels = { online: 'Online', idle: 'Idle', dnd: 'Do not disturb', offline: 'Invisible' } as const;
    return labels[this.presence.myStatus()];
  });

  openSettings(section: SettingsSection): void {
    openUserSettings(this.dialog, section);
  }
}
