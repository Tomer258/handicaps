import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { Perm, has } from '../../core/api/models';
import { SessionService } from '../../core/auth/session.service';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { AccountSection } from './account.section';
import { AppearanceSection } from './appearance.section';
import { NotificationsSection } from './notifications.section';
import { ServerSection } from './server.section';
import { SoundboardSection } from './soundboard.section';
import { VideoSection } from './video.section';
import { VoiceSection } from './voice.section';

export type SettingsSection = 'account' | 'voice' | 'video' | 'sound' | 'look' | 'notif' | 'server';

/** Full-window settings layer (prototype SETTINGS). Esc or the close button returns to the app. */
@Component({
  selector: 'hx-settings',
  imports: [AccountSection, VoiceSection, VideoSection, SoundboardSection, AppearanceSection, NotificationsSection, ServerSection],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `
    <div class="fade settings-layer" role="document" (keydown.escape)="ref.close()"
         style="position: fixed; inset: 0; display: flex; background: var(--bg1); z-index: 1">
      <nav aria-label="Settings sections" class="settings-nav"
           style="width: 260px; flex: none; padding: 40px 16px 20px; display: flex; flex-direction: column; gap: 2px; background: var(--bg0); border-right: 1px solid var(--line); overflow-y: auto">
        <div class="lbl" style="padding: 0 10px 8px">User settings</div>
        @for (t of tabs; track t.id) {
          <button class="snav" [attr.aria-pressed]="section() === t.id" (click)="section.set(t.id)" [style.background]="section() === t.id ? 'var(--bg3)' : null"
                  [style.color]="section() === t.id ? 'var(--tx)' : null">
            <span style="width: 8px; height: 8px; border-radius: 2px" [style.background]="t.dot"></span>{{ t.label }}
          </button>
        }
        @if (canAdmin()) {
          <div class="lbl" style="padding: 18px 10px 8px">{{ serverName() }}</div>
          <button class="snav" [attr.aria-pressed]="section() === 'server'" (click)="section.set('server')"
                  [style.background]="section() === 'server' ? 'var(--bg3)' : null" [style.color]="section() === 'server' ? 'var(--tx)' : null">
            <span style="width: 8px; height: 8px; border-radius: 2px; background: var(--accent)"></span>Invites &amp; members
          </button>
        }
        <div style="flex: 1"></div>
        <button class="snav" (click)="logout()" style="color: var(--danger)">Log out</button>
      </nav>
      <div class="scroll settings-body" style="flex: 1; min-width: 0; padding: 40px 48px 60px">
        <div style="max-width: 720px">
          @switch (section()) {
            @case ('account') { <hx-account-section /> }
            @case ('voice') { <hx-voice-section /> }
            @case ('video') { <hx-video-section /> }
            @case ('sound') { <hx-soundboard-section /> }
            @case ('look') { <hx-appearance-section /> }
            @case ('notif') { <hx-notifications-section /> }
            @case ('server') { <hx-server-section /> }
          }
        </div>
      </div>
      <button (click)="ref.close()" aria-label="Close settings" class="settings-close"
              style="position: absolute; right: 28px; top: 32px; display: flex; flex-direction: column; align-items: center; gap: 4px; color: var(--tx3); font-size: 11px">
        <span style="width: 36px; height: 36px; border-radius: 50%; border: 2px solid var(--line2); display: grid; place-items: center">
          <svg viewBox="0 0 24 24" class="ic" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </span>ESC
      </button>
    </div>
  `,
})
export class SettingsDialog {
  readonly data = inject<{ section?: SettingsSection }>(DIALOG_DATA, { optional: true });
  readonly ref = inject(DialogRef);
  private readonly session = inject(SessionService);
  private readonly store = inject(WorkspaceStore);

  readonly tabs: { id: SettingsSection; label: string; dot: string }[] = [
    { id: 'account', label: 'My account', dot: 'var(--tx3)' },
    { id: 'voice', label: 'Voice & audio', dot: 'var(--accent)' },
    { id: 'video', label: 'Video & streaming', dot: 'var(--live)' },
    { id: 'sound', label: 'Soundboard', dot: 'var(--sb)' },
    { id: 'look', label: 'Appearance', dot: 'var(--tx3)' },
    { id: 'notif', label: 'Notifications', dot: 'var(--warn)' },
  ];

  readonly section = signal<SettingsSection>(this.data?.section ?? 'account');
  readonly serverName = computed(() => this.store.server()?.name ?? 'Server');
  readonly canAdmin = computed(() => {
    const p = this.store.server()?.myPermissions ?? 0;
    return has(p, Perm.Administrator) || has(p, Perm.ManageInvites) || has(p, Perm.ManageRoles);
  });

  async logout(): Promise<void> {
    this.ref.close();
    await this.session.logout();
  }
}
