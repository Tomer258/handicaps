import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { SessionService } from '../../core/auth/session.service';
import { ApiError } from '../../core/api/api-error';
import { InvitePreview } from '../../core/api/models';
import { Icon } from '../../shared/ui/icon';

/**
 * Invitation landing page. Opening the link only previews; redemption is an explicit protected POST.
 */
@Component({
  selector: 'hx-invite-page',
  imports: [ReactiveFormsModule, RouterLink, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="auth-wrap">
      @if (preview(); as p) {
        @if (signedIn() && canJoin()) {
          <div class="auth-card fade" data-testid="invite-join">
            <span class="eyebrow mono" style="font-size: 11.5px; letter-spacing: .12em; color: var(--tx3); text-transform: uppercase">You're invited</span>
            <h1>Join {{ p.serverName }}</h1>
            <p style="color: var(--tx2)">
              @if (p.invitedBy) { <b style="color: var(--tx)">{{ p.invitedBy }}</b> invited you. }
              @if (p.memberCount) { {{ p.memberCount === 1 ? '1 member' : p.memberCount + ' members' }} already here. }
              You'll join as <b style="color: var(--tx)">{{ session.user()?.displayName }}</b>, with the account you're signed in with.
            </p>
            @if (error(); as e) {
              <div class="note e" role="alert"><hx-icon name="alert-circle" size="sm" /> {{ e }}</div>
            }
            <button class="btn pri" type="button" [disabled]="busy()" (click)="join()" style="height: 40px">{{ busy() ? 'Joining…' : 'Join ' + p.serverName }}</button>
            <button class="btn ghost" type="button" (click)="signOut()">Sign out and create another account</button>
          </div>
        } @else if (signedIn()) {
          <div class="auth-card fade" data-testid="invite-signed-in">
            <span class="eyebrow mono" style="font-size: 11.5px; letter-spacing: .12em; color: var(--tx3); text-transform: uppercase">Invitation</span>
            <h1>You're already in{{ p.serverName ? ' ' + p.serverName : '' }}</h1>
            <p>You're signed in as <b>{{ session.user()?.displayName }}</b>.
              @if (p.valid) { This link is for a friend who doesn't have an account yet — send it to them. }</p>
            <a class="btn pri" routerLink="/" style="height: 40px">Open Hangar</a>
            @if (p.valid) {
              <button class="btn ghost" type="button" (click)="signOut()">Sign out and create another account</button>
            }
          </div>
        } @else if (p.valid) {
          <form class="auth-card fade" [formGroup]="form" (ngSubmit)="submit()" novalidate>
            <span class="eyebrow mono" style="font-size: 11.5px; letter-spacing: .12em; color: var(--tx3); text-transform: uppercase">
              {{ p.ownerBootstrap ? 'Owner setup' : "You're invited" }}
            </span>
            <h1>Join {{ p.serverName }}</h1>
            @if (!p.ownerBootstrap && (p.invitedBy || p.memberCount)) {
              <p style="margin-bottom: 0; color: var(--tx2)" data-testid="invite-from">
                @if (p.invitedBy) { <b style="color: var(--tx)">{{ p.invitedBy }}</b> invited you. }
                @if (p.memberCount) { {{ p.memberCount === 1 ? '1 member' : p.memberCount + ' members' }} already here. }
              </p>
            }
            <p>{{ p.ownerBootstrap ? 'This one-time link creates the owner account.' : 'Pick a login and a display name your friends will see.' }}</p>

            <div class="field">
              <label for="displayName">Display name</label>
              <input id="displayName" class="inp" formControlName="displayName" autocomplete="nickname" maxlength="32" dir="auto" />
            </div>
            <div class="field">
              <label for="login">Login</label>
              <input id="login" class="inp" formControlName="login" autocomplete="username" autocapitalize="none" spellcheck="false"
                     [class.invalid]="form.controls.login.touched && form.controls.login.invalid" aria-describedby="login-hint" />
              <span id="login-hint" style="font-size: 12px; color: var(--tx3)">3–32 characters: letters, digits, dot, dash, underscore.</span>
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input id="password" class="inp" type="password" formControlName="password" autocomplete="new-password"
                     [class.invalid]="form.controls.password.touched && form.controls.password.invalid" aria-describedby="pw-hint" />
              <span id="pw-hint" style="font-size: 12px; color: var(--tx3)">At least 10 characters.</span>
            </div>
            <label class="chk"><input type="checkbox" formControlName="remember" /> Keep me signed in on this device</label>

            @if (error(); as e) {
              <div class="note e" role="alert"><hx-icon name="alert-circle" size="sm" /> {{ e }}</div>
            }
            <button class="btn pri" type="submit" [disabled]="busy() || form.invalid" style="height: 40px">
              {{ busy() ? 'Creating account…' : 'Create account' }}
            </button>
            @if (!p.ownerBootstrap) {
              <p style="margin: 0; font-size: 13px; text-align: center">Already have an account? <a routerLink="/login" [queryParams]="{ next: '/invite/' + secret() }">Sign in</a> to join with it.</p>
            }
          </form>
        } @else {
          <div class="auth-card fade">
            <h1>This invite doesn't work anymore</h1>
            <p>It may have expired, been used up or been turned off. Ask the friend who sent it for a new link.</p>
            <a class="btn sec" routerLink="/login">Go to sign in</a>
          </div>
        }
      } @else {
        <div class="auth-card"><p>Checking invitation…</p></div>
      }
    </main>
  `,
})
export class InvitePage implements OnInit {
  /** Route param bound via withComponentInputBinding. */
  readonly secret = input.required<string>();

  readonly session = inject(SessionService);
  private readonly router = inject(Router);

  readonly preview = signal<InvitePreview | null>(null);
  readonly signedIn = computed(() => this.session.status() === 'authenticated');
  /** A valid member link for a hangar I'm not in yet: join it with this account. */
  readonly canJoin = computed(() => {
    const p = this.preview();
    return !!p?.valid && !p.ownerBootstrap && !!p.serverId && !this.session.servers().some((s) => s.id === p.serverId);
  });
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly form = inject(NonNullableFormBuilder).group({
    displayName: ['', [Validators.required, Validators.maxLength(32)]],
    login: ['', [Validators.required, Validators.pattern(/^[A-Za-z0-9._-]{3,32}$/)]],
    password: ['', [Validators.required, Validators.minLength(10), Validators.maxLength(128)]],
    remember: [true],
  });

  async ngOnInit(): Promise<void> {
    // Already signed in (e.g. a member opening a link they made): say so instead of offering a second account.
    if (this.session.status() === 'unknown') await this.session.restore().catch(() => undefined);
    try {
      this.preview.set(await this.session.previewInvite(this.secret()));
    } catch {
      this.preview.set({ valid: false, serverName: null, ownerBootstrap: false });
    }
  }

  async join(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const serverId = await this.session.acceptInvite(this.secret());
      await this.router.navigate(['/s', serverId]);
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }

  async signOut(): Promise<void> {
    await this.session.logout(`/invite/${encodeURIComponent(this.secret())}`);
  }

  async submit(): Promise<void> {
    if (this.form.invalid || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    const v = this.form.getRawValue();
    try {
      await this.session.register(this.secret(), v.login, v.password, v.displayName, v.remember);
      await this.router.navigateByUrl('/');
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }
}
