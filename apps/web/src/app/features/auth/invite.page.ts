import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
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
        @if (p.valid) {
          <form class="auth-card fade" [formGroup]="form" (ngSubmit)="submit()" novalidate>
            <span class="eyebrow mono" style="font-size: 11.5px; letter-spacing: .12em; color: var(--tx3); text-transform: uppercase">
              {{ p.ownerBootstrap ? 'Owner setup' : "You're invited" }}
            </span>
            <h1>Join {{ p.serverName }}</h1>
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
          </form>
        } @else {
          <div class="auth-card fade">
            <h1>Link expired</h1>
            <p>This invitation is invalid, expired or already used. Ask for a new one.</p>
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

  private readonly session = inject(SessionService);
  private readonly router = inject(Router);

  readonly preview = signal<InvitePreview | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly form = inject(NonNullableFormBuilder).group({
    displayName: ['', [Validators.required, Validators.maxLength(32)]],
    login: ['', [Validators.required, Validators.pattern(/^[A-Za-z0-9._-]{3,32}$/)]],
    password: ['', [Validators.required, Validators.minLength(10), Validators.maxLength(128)]],
    remember: [true],
  });

  async ngOnInit(): Promise<void> {
    try {
      this.preview.set(await this.session.previewInvite(this.secret()));
    } catch {
      this.preview.set({ valid: false, serverName: null, ownerBootstrap: false });
    }
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
