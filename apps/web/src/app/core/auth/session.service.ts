import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService } from '../api/api.service';
import { ApiError } from '../api/api-error';
import { InvitePreview, MeResponse, Profile, ServerSummary } from '../api/models';

export type AuthStatus = 'unknown' | 'authenticated' | 'anonymous' | 'offline';

/**
 * Session facade: current user and memberships. Holds no tokens — the auth cookie is HttpOnly.
 * Route guards use it for navigation hints only; the API enforces access.
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  private readonly _status = signal<AuthStatus>('unknown');
  private readonly _user = signal<Profile | null>(null);
  private readonly _servers = signal<ServerSummary[]>([]);
  private readonly _sessionId = signal<string | null>(null);
  private readonly _expired = signal(false);

  readonly status = this._status.asReadonly();
  readonly user = this._user.asReadonly();
  readonly servers = this._servers.asReadonly();
  readonly sessionId = this._sessionId.asReadonly();
  /** True after a 401 during use: the shell shows a login-recovery prompt instead of looping. */
  readonly expired = this._expired.asReadonly();
  readonly userId = computed(() => this._user()?.id ?? null);

  private restoring?: Promise<void>;
  private readonly teardownHooks: Array<() => void | Promise<void>> = [];

  /** Root services (realtime, media) register cleanup to run on logout/expiry. */
  onTeardown(fn: () => void | Promise<void>): void {
    this.teardownHooks.push(fn);
  }

  restore(): Promise<void> {
    this.restoring ??= (async () => {
      try {
        await this.api.get('/auth/csrf');
        this.apply(await this.api.get<MeResponse>('/auth/me'));
      } catch (e) {
        // 401 → login form. Network/API outage → "offline" so the UI offers retry instead of a login form.
        this._status.set(ApiError.from(e).status === 401 ? 'anonymous' : 'offline');
      } finally {
        this.restoring = undefined;
      }
    })();
    return this.restoring;
  }

  async login(login: string, password: string, remember: boolean): Promise<void> {
    await this.api.get('/auth/csrf');
    this.apply(await this.api.post<MeResponse>('/auth/login', { login, password, remember }));
  }

  async register(inviteSecret: string, login: string, password: string, displayName: string, remember: boolean): Promise<void> {
    await this.api.get('/auth/csrf');
    this.apply(await this.api.post<MeResponse>('/auth/register', { inviteSecret, login, password, displayName, remember }));
  }

  previewInvite(secret: string): Promise<InvitePreview> {
    return this.api.get('/auth/csrf').then(() => this.api.post<InvitePreview>('/auth/invitations/preview', { secret }));
  }

  async refreshMe(): Promise<void> {
    this.apply(await this.api.get<MeResponse>('/auth/me'));
  }

  updateProfile(p: Profile): void {
    this._user.set(p);
  }

  async logout(): Promise<void> {
    await this.runTeardown();
    try {
      await this.api.post('/auth/logout');
    } finally {
      this.clear();
      await this.router.navigateByUrl('/login');
    }
  }

  /** Called on any 401 outside /auth: stop activity and expose recovery. */
  handleUnauthorized(): void {
    if (this._status() !== 'authenticated') return;
    this._expired.set(true);
    void this.runTeardown();
  }

  async recoverToLogin(): Promise<void> {
    this.clear();
    await this.router.navigateByUrl('/login');
  }

  private async runTeardown(): Promise<void> {
    for (const fn of this.teardownHooks) {
      try {
        await fn();
      } catch {
        /* teardown is best effort */
      }
    }
  }

  private apply(me: MeResponse): void {
    this._user.set(me.user);
    this._servers.set(me.servers);
    this._sessionId.set(me.sessionId);
    this._expired.set(false);
    this._status.set('authenticated');
  }

  private clear(): void {
    this._user.set(null);
    this._servers.set([]);
    this._sessionId.set(null);
    this._expired.set(false);
    this._status.set('anonymous');
  }
}
