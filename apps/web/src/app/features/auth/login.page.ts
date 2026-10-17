import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { SessionService } from '../../core/auth/session.service';
import { ApiError } from '../../core/api/api-error';
import { Icon } from '../../shared/ui/icon';

@Component({
  selector: 'hx-login-page',
  imports: [ReactiveFormsModule, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="auth-wrap">
      <form class="auth-card fade" [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <div style="display: flex; align-items: center; gap: 12px">
          <span class="brand-mark"><hx-icon name="home" size="lg" /></span>
          <span class="disp" style="font-size: 22px; font-weight: 700">Hangar</span>
        </div>
        <h1>Welcome back.</h1>
        <p>Sign in to hang out with your friends.</p>

        <div class="field">
          <label for="login">Login</label>
          <input id="login" class="inp" formControlName="login" autocomplete="username" autocapitalize="none" spellcheck="false" />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" class="inp" type="password" formControlName="password" autocomplete="current-password" />
        </div>
        <label class="chk"><input type="checkbox" formControlName="remember" /> Keep me signed in on this device</label>

        @if (error(); as e) {
          <div class="note e" role="alert" id="login-error"><hx-icon name="alert-circle" size="sm" /> {{ e }}</div>
        }

        <button class="btn pri" type="submit" [disabled]="busy() || form.invalid" style="height: 40px">
          {{ busy() ? 'Signing in…' : 'Sign in' }}
        </button>
        <p style="font-size: 12.5px; color: var(--tx3)">Invite-only. Ask a friend with admin rights for an invitation link.</p>
      </form>
    </main>
  `,
  styles: `.brand-mark { width: 44px; height: 44px; border-radius: 14px; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center; }`,
})
export class LoginPage {
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly form = inject(NonNullableFormBuilder).group({
    login: ['', [Validators.required, Validators.maxLength(32)]],
    password: ['', [Validators.required, Validators.maxLength(128)]],
    remember: [true],
  });

  async submit(): Promise<void> {
    if (this.form.invalid || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    const { login, password, remember } = this.form.getRawValue();
    try {
      await this.session.login(login, password, remember);
      const next = this.route.snapshot.queryParamMap.get('next');
      await this.router.navigateByUrl(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
    } catch (e) {
      const err = ApiError.from(e);
      this.error.set(err.code === 'auth.throttled' ? 'Too many attempts. Wait a moment and try again.' : err.message);
    } finally {
      this.busy.set(false);
    }
  }
}
