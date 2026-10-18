import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { UserSettingsService } from '../../core/settings/user-settings.service';

/** Notifications: opt-in browser permission (asked only from this button) and what may notify. */
@Component({
  selector: 'hx-notifications-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="disp" style="margin: 0 0 20px; font-size: 26px">Notifications</h2>
    <div class="card" style="display: flex; align-items: center; gap: 14px; flex-wrap: wrap">
      <div style="flex: 1; min-width: 200px"><div style="font-weight: 600">Browser notifications</div>
        <div style="font-size: 12.5px; color: var(--tx3)">Status: {{ label() }}</div></div>
      <button class="btn pri" (click)="ask()" [disabled]="permission() !== 'default'">{{ permission() === 'granted' ? 'Enabled' : permission() === 'denied' ? 'Blocked' : 'Enable' }}</button>
    </div>
    @if (permission() === 'denied') {
      <div class="note w" style="margin-top: 10px">Notifications are blocked for this site. Click the icon left of the address bar › Notifications › Allow, then reload.</div>
    }
    <div class="srow"><div><div class="t">Message notifications</div><div class="d">Which messages pop up when Hangar is in the background</div></div>
      <div class="seg" role="group" aria-label="Message notifications">
        <button [attr.aria-pressed]="n().messages === 'all'" (click)="settings.updateNotifications({ messages: 'all' })">All</button>
        <button [attr.aria-pressed]="n().messages === 'mentions'" (click)="settings.updateNotifications({ messages: 'mentions' })">Mentions</button>
        <button [attr.aria-pressed]="n().messages === 'none'" (click)="settings.updateNotifications({ messages: 'none' })">None</button>
      </div></div>
    <div class="srow"><div><div class="t">Mention alerts during voice</div><div class="d">Still notify when you're in a voice channel</div></div>
      <button class="sw" aria-label="Mention alerts in voice" [attr.aria-pressed]="n().mentionsInVoice" (click)="settings.updateNotifications({ mentionsInVoice: !n().mentionsInVoice })"></button></div>
    <div class="srow"><div><div class="t">Join &amp; leave chimes</div><div class="d">A soft cue when friends enter or leave your voice channel</div></div>
      <button class="sw" aria-label="Join and leave chimes" [attr.aria-pressed]="n().chimes" (click)="settings.updateNotifications({ chimes: !n().chimes })"></button></div>
    <div class="note" style="margin-top: 16px">Do not disturb (set it under My account) silences every pop-up and chime. Notifications only arrive while a Hangar tab is open.</div>
  `,
})
export class NotificationsSection {
  readonly settings = inject(UserSettingsService);
  readonly n = this.settings.notifications;
  readonly supported = typeof Notification !== 'undefined';
  readonly permission = signal<NotificationPermission | 'unsupported'>(this.supported ? Notification.permission : 'unsupported');
  readonly label = computed(() => ({ granted: 'allowed', denied: 'blocked by the browser', default: 'not enabled', unsupported: 'not supported in this browser' })[this.permission()]);

  async ask(): Promise<void> {
    if (!this.supported) return;
    this.permission.set(await Notification.requestPermission());
  }
}
