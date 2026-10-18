import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import qrcode from 'qrcode-generator';
import { ApiService } from '../../core/api/api.service';
import { ApiError } from '../../core/api/api-error';
import { ToastService } from '../../core/ui/toast.service';
import { Icon } from '../../shared/ui/icon';

interface Status { enabled: boolean; recoveryCodesLeft: number }
interface Setup { secret: string; otpAuthUri: string }

/** Account → two-step login: enrol an authenticator app (QR), keep recovery codes, turn it off. */
@Component({
  selector: 'hx-two-factor-block',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="srow">
      <div>
        <div class="t">Two-step login</div>
        <div class="d">
          @if (status()?.enabled) {
            On. Sign-in asks for a code from your authenticator app · {{ status()!.recoveryCodesLeft }} recovery codes left
          } @else {
            Ask for a code from an authenticator app after your password. Recommended for admins.
          }
        </div>
      </div>
      @if (status(); as s) {
        @if (s.enabled) {
          <div style="display: flex; gap: 8px">
            <button class="btn sec" (click)="openConfirm('regenerate')">New recovery codes</button>
            <button class="btn ghost" style="color: var(--danger)" (click)="openConfirm('disable')">Turn off</button>
          </div>
        } @else if (!setup()) {
          <button class="btn sec" (click)="begin()" [disabled]="busy()"><hx-icon name="shield" size="sm" /> Set up</button>
        }
      }
    </div>

    @if (setup(); as st) {
      <form class="card tf" (submit)="$event.preventDefault(); enable()" aria-label="Set up two-step login">
        <svg class="qr" [attr.viewBox]="'0 0 ' + qr().size + ' ' + qr().size" role="img" aria-label="QR code for your authenticator app" shape-rendering="crispEdges">
          <rect [attr.width]="qr().size" [attr.height]="qr().size" fill="#fff" />
          <path [attr.d]="qr().path" fill="#000" />
        </svg>
        <div style="display: grid; gap: 10px; align-content: start">
          <div class="d" style="color: var(--tx2)">1. Scan the code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Aegis…).</div>
          <div class="d" style="color: var(--tx3)">Can't scan? Enter this key: <span class="mono key" data-testid="totp-secret">{{ grouped(st.secret) }}</span></div>
          <div class="field">
            <label for="tf-code">2. Enter the 6-digit code it shows</label>
            <input id="tf-code" class="inp mono" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="123 456"
                   [value]="code()" (input)="code.set($any($event.target).value)" />
          </div>
          @if (error()) { <div class="note e" role="alert">{{ error() }}</div> }
          <div style="display: flex; justify-content: flex-end; gap: 8px">
            <button type="button" class="btn ghost" (click)="cancel()">Cancel</button>
            <button type="submit" class="btn pri" [disabled]="busy() || code().replace(' ', '').length !== 6">Turn on</button>
          </div>
        </div>
      </form>
    }

    @if (confirm(); as what) {
      <form class="card" style="display: grid; gap: 12px; margin: 8px 0 12px" (submit)="$event.preventDefault(); confirmed()">
        <div class="field">
          <label for="tf-pw">{{ what === 'disable' ? 'Enter your password to turn off two-step login' : 'Enter your password to replace your recovery codes' }}</label>
          <input id="tf-pw" class="inp" type="password" autocomplete="current-password" [value]="password()" (input)="password.set($any($event.target).value)" />
        </div>
        @if (error()) { <div class="note e" role="alert">{{ error() }}</div> }
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <button type="button" class="btn ghost" (click)="confirm.set(null)">Cancel</button>
          <button type="submit" class="btn" [class.pri]="what !== 'disable'" [class.dng]="what === 'disable'" [disabled]="busy() || !password()">
            {{ what === 'disable' ? 'Turn off' : 'Replace codes' }}
          </button>
        </div>
      </form>
    }

    @if (codes(); as list) {
      <div class="card" style="display: grid; gap: 10px; margin: 8px 0 12px" role="region" aria-label="Recovery codes">
        <div class="t" style="font-weight: 600">Save your recovery codes</div>
        <div class="d" style="color: var(--tx2)">Each code signs you in once if you lose your phone. They won't be shown again.</div>
        <ul class="codes mono" data-testid="recovery-codes">
          @for (c of list; track c) { <li>{{ c }}</li> }
        </ul>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <button class="btn sec" (click)="copy(list)">Copy</button>
          <button class="btn sec" (click)="download(list)">Download</button>
          <button class="btn pri" (click)="codes.set(null)">I saved them</button>
        </div>
      </div>
    }
  `,
  styles: `
    .tf { display: grid; grid-template-columns: 168px 1fr; gap: 18px; margin: 8px 0 12px; }
    .qr { width: 168px; height: 168px; border-radius: 8px; }
    .key { color: var(--tx); user-select: all; word-break: break-all; }
    .codes { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 24px; margin: 0; padding: 12px 16px; list-style: none;
             background: var(--bg2); border-radius: 8px; font-size: 14px; }
    @media (max-width: 560px) { .tf { grid-template-columns: 1fr; justify-items: center; } }
  `,
})
export class TwoFactorBlock {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  readonly status = signal<Status | null>(null);
  readonly setup = signal<Setup | null>(null);
  readonly codes = signal<string[] | null>(null);
  readonly confirm = signal<'disable' | 'regenerate' | null>(null);
  readonly code = signal('');
  readonly password = signal('');
  readonly error = signal('');
  readonly busy = signal(false);

  /** QR as one SVG path (no HTML injection): one 1×1 square per dark module, with a 4-module quiet zone. */
  readonly qr = computed(() => {
    const uri = this.setup()?.otpAuthUri ?? '';
    const q = qrcode(0, 'M');
    q.addData(uri);
    q.make();
    const n = q.getModuleCount();
    let path = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) path += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { size: n + 8, path };
  });

  constructor() {
    void this.load();
  }

  grouped(secret: string): string {
    return secret.replace(/(.{4})/g, '$1 ').trim();
  }

  async begin(): Promise<void> {
    await this.run(async () => {
      this.setup.set(await this.api.post<Setup>('/auth/2fa/setup', {}));
      this.code.set('');
    });
  }

  cancel(): void {
    this.setup.set(null);
    this.error.set('');
  }

  async enable(): Promise<void> {
    await this.run(async () => {
      const r = await this.api.post<{ recoveryCodes: string[] }>('/auth/2fa/enable', { code: this.code() });
      this.setup.set(null);
      this.codes.set(r.recoveryCodes);
      this.toast.show('Two-step login is on.', 'info');
      await this.load();
    });
  }

  openConfirm(what: 'disable' | 'regenerate'): void {
    this.confirm.set(what);
    this.password.set('');
    this.error.set('');
  }

  async confirmed(): Promise<void> {
    const what = this.confirm();
    await this.run(async () => {
      if (what === 'disable') {
        await this.api.post('/auth/2fa/disable', { password: this.password() });
        this.toast.show('Two-step login is off.', 'info');
      } else {
        const r = await this.api.post<{ recoveryCodes: string[] }>('/auth/2fa/recovery-codes', { password: this.password() });
        this.codes.set(r.recoveryCodes);
      }
      this.confirm.set(null);
      await this.load();
    });
  }

  async copy(list: string[]): Promise<void> {
    try {
      await navigator.clipboard.writeText(list.join('\n'));
      this.toast.show('Recovery codes copied.', 'info');
    } catch {
      this.toast.show('Copy failed. Use Download instead.', 'danger');
    }
  }

  download(list: string[]): void {
    const blob = new Blob([`Hangar recovery codes (each works once)\n\n${list.join('\n')}\n`], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'hangar-recovery-codes.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private async load(): Promise<void> {
    try {
      this.status.set(await this.api.get<Status>('/auth/2fa'));
    } catch {
      /* the row stays hidden; the rest of the page works */
    }
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await fn();
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }
}
