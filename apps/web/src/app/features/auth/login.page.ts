import { ChangeDetectionStrategy, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
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
      @if (challenge() === null) {
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
      } @else {
        <form class="auth-card fade" (submit)="$event.preventDefault(); submitCode()" novalidate>
          <div style="display: flex; align-items: center; gap: 12px">
            <span class="brand-mark"><hx-icon name="lock" size="lg" /></span>
            <span class="disp" style="font-size: 22px; font-weight: 700">Hangar</span>
          </div>
          <h1>Two-step login</h1>
          <p>{{ recovery() ? 'Enter one of your recovery codes. Each one works once.' : 'Enter the 6-digit code from your authenticator app.' }}</p>

          <div class="field">
            <label for="code">{{ recovery() ? 'Recovery code' : 'Code' }}</label>
            <input #codeInput id="code" class="inp" name="code" [value]="code()" (input)="code.set(codeInput.value)"
                   [attr.inputmode]="recovery() ? null : 'numeric'" autocomplete="one-time-code" autocapitalize="none" spellcheck="false"
                   [attr.maxlength]="recovery() ? 16 : 8" [placeholder]="recovery() ? 'xxxxx-xxxxx' : '123 456'" />
          </div>

          @if (error(); as e) {
            <div class="note e" role="alert" id="login-error"><hx-icon name="alert-circle" size="sm" /> {{ e }}</div>
          }

          <button class="btn pri" type="submit" [disabled]="busy() || code().trim().length < 6" style="height: 40px">
            {{ busy() ? 'Checking…' : 'Continue' }}
          </button>
          <div style="display: flex; justify-content: space-between; font-size: 12.5px">
            <button type="button" class="linkbtn" (click)="toggleRecovery()">{{ recovery() ? 'Use the authenticator app' : 'Use a recovery code' }}</button>
            <button type="button" class="linkbtn" (click)="back()">Back</button>
          </div>
        </form>
      }
    </main>
  `,
  styles: `
    .brand-mark { width: 44px; height: 44px; border-radius: 14px; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center; }
    .linkbtn { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; font: inherit; }
    .linkbtn:hover { text-decoration: underline; }
  `,
})
export class LoginPage {
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly codeInput = viewChild<ElementRef<HTMLInputElement>>('codeInput');

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly challenge = signal<string | null>(null);
  readonly recovery = signal(false);
  readonly code = signal('');
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
      const challenge = await this.session.login(login, password, remember);
      if (challenge) {
        this.challenge.set(challenge);
        this.focusCode();
        return;
      }
      await this.done();
    } catch (e) {
      this.error.set(this.message(e));
    } finally {
      this.busy.set(false);
    }
  }

  async submitCode(): Promise<void> {
    const challenge = this.challenge();
    if (!challenge || this.busy() || this.code().trim().length < 6) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.session.loginCode(challenge, this.code().trim());
      await this.done();
    } catch (e) {
      const err = ApiError.from(e);
      if (err.code === 'auth.challenge_expired') {
        this.back();
        this.error.set('That took too long. Sign in again.');
      } else {
        this.error.set(this.message(e));
        this.code.set('');
        this.focusCode();
      }
    } finally {
      this.busy.set(false);
    }
  }

  toggleRecovery(): void {
    this.recovery.update((r) => !r);
    this.code.set('');
    this.error.set(null);
    this.focusCode();
  }

  back(): void {
    this.challenge.set(null);
    this.recovery.set(false);
    this.code.set('');
    this.error.set(null);
    this.form.controls.password.setValue('');
  }

  private async done(): Promise<void> {
    const next = this.route.snapshot.queryParamMap.get('next');
    await this.router.navigateByUrl(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
  }

  private message(e: unknown): string {
    const err = ApiError.from(e);
    return err.code === 'auth.throttled' ? 'Too many attempts. Wait a moment and try again.' : err.message;
  }

  private focusCode(): void {
    setTimeout(() => this.codeInput()?.nativeElement.focus());
  }
}
