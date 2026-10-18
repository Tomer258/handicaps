import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api/api.service';
import { ApiError } from '../../core/api/api-error';
import { Profile, SessionInfo } from '../../core/api/models';
import { SessionService } from '../../core/auth/session.service';
import { PreferredStatus, UserSettingsService } from '../../core/settings/user-settings.service';
import { ToastService } from '../../core/ui/toast.service';
import { avatarColor, initials } from '../../shared/ui/avatar';
import { WorkspaceStore } from '../workspaces/workspace.store';

const HUES = [200, 160, 95, 45, 20, 340, 290, 250];

/** My account: profile (name, avatar colour), status, password and signed-in sessions. */
@Component({
  selector: 'hx-account-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="disp" style="margin: 0 0 20px; font-size: 26px">My account</h2>
    <div class="card" style="padding: 0; overflow: hidden">
      <div style="height: 90px; background: linear-gradient(120deg, var(--accent), color-mix(in oklab,var(--accent) 40%,var(--bg4)))"></div>
      <div style="display: flex; align-items: flex-end; gap: 16px; padding: 0 20px 20px; margin-top: -36px; flex-wrap: wrap">
        <span class="av s80" [style.background]="color(hue())" style="border: 5px solid var(--bg3)" aria-hidden="true">{{ ini() }}</span>
        <div style="flex: 1; min-width: 160px; padding-bottom: 6px">
          <div class="disp" style="font-size: 20px; font-weight: 700" dir="auto">{{ user()?.displayName }}</div>
          <div class="mono" style="font-size: 12px; color: var(--tx3)">&#64;{{ user()?.login }}{{ roleLabel() ? ' · ' + roleLabel() : '' }}</div>
        </div>
      </div>
    </div>

    <div class="field" style="margin-top: 22px">
      <label for="dn">Display name</label>
      <div style="display: flex; gap: 8px">
        <input id="dn" class="inp" style="flex: 1" maxlength="32" [value]="name()" (input)="name.set($any($event.target).value)" (keydown.enter)="saveName()" dir="auto" />
        <button class="btn pri" (click)="saveName()" [disabled]="!nameDirty() || busy()">Save</button>
      </div>
    </div>
    <div class="field" style="margin-top: 14px">
      <span class="lbl">Avatar colour</span>
      <div style="display: flex; gap: 8px; flex-wrap: wrap" role="radiogroup" aria-label="Avatar colour">
        @for (h of hues; track h) {
          <button role="radio" [attr.aria-checked]="hue() === h" [attr.aria-label]="'Colour ' + (hues.indexOf(h) + 1)" (click)="saveHue(h)"
                  style="width: 30px; height: 30px; border-radius: 50%" [style.background]="color(h)"
                  [style.box-shadow]="hue() === h ? '0 0 0 2px var(--bg1), 0 0 0 4px var(--tx)' : null"></button>
        }
      </div>
    </div>
    <div class="srow" style="margin-top: 10px">
      <div><div class="t">Status</div><div class="d">Do not disturb silences notification pop-ups. Invisible appears offline.</div></div>
      <div class="seg" role="group" aria-label="Status">
        @for (s of statuses; track s.id) {
          <button [attr.aria-pressed]="settings.preferredStatus() === s.id" (click)="settings.setStatus(s.id)">{{ s.label }}</button>
        }
      </div>
    </div>

    <div class="lbl" style="margin: 28px 0 4px">Password &amp; sessions</div>
    <div class="srow">
      <div><div class="t">Password</div><div class="d">Changing it signs out every other session</div></div>
      <button class="btn sec" (click)="pwOpen.set(!pwOpen())" [attr.aria-expanded]="pwOpen()">Change password</button>
    </div>
    @if (pwOpen()) {
      <form class="card" style="display: grid; gap: 12px; margin: 8px 0 12px" (submit)="$event.preventDefault(); changePassword()">
        <div class="field"><label for="pw-cur">Current password</label>
          <input id="pw-cur" class="inp" type="password" autocomplete="current-password" [value]="pwCur()" (input)="pwCur.set($any($event.target).value)" /></div>
        <div class="field"><label for="pw-new">New password</label>
          <input id="pw-new" class="inp" type="password" autocomplete="new-password" minlength="10" [value]="pwNew()" (input)="pwNew.set($any($event.target).value)" />
          <span style="font-size: 12px; color: var(--tx3)">At least 10 characters. A few random words work well.</span></div>
        @if (pwError()) { <div class="note e" role="alert">{{ pwError() }}</div> }
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <button type="button" class="btn ghost" (click)="pwOpen.set(false)">Cancel</button>
          <button type="submit" class="btn pri" [disabled]="busy() || !pwCur() || pwNew().length < 10">Update password</button>
        </div>
      </form>
    }
    @for (s of sessions(); track s.id) {
      <div class="srow">
        <div><div class="t">{{ s.deviceLabel || 'Unknown device' }}</div>
          <div class="d">Signed in {{ date(s.createdAt) }} · last active {{ date(s.lastSeenAt) }}{{ s.persistent ? ' · remembered' : '' }}</div></div>
        @if (s.current) {
          <span style="font-size: 12px; color: var(--accent-tx); font-weight: 600">This device</span>
        } @else {
          <button class="btn ghost" style="color: var(--danger)" (click)="revoke(s)" [attr.aria-label]="'Sign out ' + (s.deviceLabel || 'session')">Sign out</button>
        }
      </div>
    }
  `,
})
export class AccountSection {
  private readonly api = inject(ApiService);
  private readonly session = inject(SessionService);
  private readonly store = inject(WorkspaceStore);
  private readonly toast = inject(ToastService);
  readonly settings = inject(UserSettingsService);

  readonly hues = HUES;
  readonly statuses: { id: PreferredStatus; label: string }[] = [
    { id: 'online', label: 'Online' },
    { id: 'idle', label: 'Idle' },
    { id: 'doNotDisturb', label: 'DND' },
    { id: 'invisible', label: 'Invisible' },
  ];
  readonly user = this.session.user;
  readonly name = signal(this.session.user()?.displayName ?? '');
  readonly hue = signal(this.session.user()?.avatarHue ?? 200);
  readonly busy = signal(false);
  readonly sessions = signal<SessionInfo[]>([]);
  readonly pwOpen = signal(false);
  readonly pwCur = signal('');
  readonly pwNew = signal('');
  readonly pwError = signal('');

  readonly ini = computed(() => initials(this.name() || this.user()?.displayName || '?'));
  readonly nameDirty = computed(() => this.name().trim().length > 0 && this.name().trim() !== this.user()?.displayName);
  readonly roleLabel = computed(() => {
    const me = this.store.memberById().get(this.user()?.id ?? '');
    if (!me) return '';
    if (me.isOwner) return 'Owner';
    const roles = this.store.server()?.roles ?? [];
    return roles.filter((r) => !r.isDefault && me.roleIds.includes(r.id)).map((r) => r.name).join(', ');
  });

  constructor() {
    void this.loadSessions();
  }

  color(h: number): string {
    return avatarColor(h);
  }

  date(iso: string): string {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  async saveName(): Promise<void> {
    if (!this.nameDirty()) return;
    await this.saveProfile({ displayName: this.name().trim() });
  }

  async saveHue(h: number): Promise<void> {
    this.hue.set(h);
    await this.saveProfile({ avatarHue: h });
  }

  async changePassword(): Promise<void> {
    this.busy.set(true);
    this.pwError.set('');
    try {
      await this.api.post('/auth/password', { currentPassword: this.pwCur(), newPassword: this.pwNew() });
      this.pwOpen.set(false);
      this.pwCur.set('');
      this.pwNew.set('');
      this.toast.show('Password changed. Other sessions were signed out.', 'info');
      await this.loadSessions();
    } catch (e) {
      this.pwError.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }

  async revoke(s: SessionInfo): Promise<void> {
    try {
      await this.api.delete(`/auth/sessions/${s.id}`);
      this.sessions.update((list) => list.filter((x) => x.id !== s.id));
      this.toast.show(`Signed out ${s.deviceLabel || 'that session'}`, 'info');
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'danger');
    }
  }

  private async saveProfile(patch: { displayName?: string; avatarHue?: number }): Promise<void> {
    this.busy.set(true);
    try {
      const p = await this.api.patch<Profile>('/users/me/profile', patch);
      this.session.updateProfile(p);
      this.store.patchMember(p.id, { displayName: p.displayName, avatarHue: p.avatarHue });
      this.name.set(p.displayName);
      this.hue.set(p.avatarHue);
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'danger');
    } finally {
      this.busy.set(false);
    }
  }

  private async loadSessions(): Promise<void> {
    try {
      this.sessions.set(await this.api.get<SessionInfo[]>('/auth/sessions'));
    } catch {
      /* shown empty */
    }
  }
}
