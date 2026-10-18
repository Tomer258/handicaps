import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { ApiService } from '../api/api.service';
import { ApiError } from '../api/api-error';
import { UserSettings } from '../api/models';
import { SessionService } from '../auth/session.service';
import { PreferencesService } from '../ui/preferences.service';

export type MessageNotify = 'all' | 'mentions' | 'none';
export type PreferredStatus = UserSettings['preferredStatus'];

export interface NotificationPrefs {
  /** Which messages may raise a browser notification while Hangar is in the background. */
  messages: MessageNotify;
  /** Still notify about mentions while in a voice channel. */
  mentionsInVoice: boolean;
  /** Soft cue when someone joins/leaves my voice channel. */
  chimes: boolean;
}

const NOTIFY_DEFAULTS: NotificationPrefs = { messages: 'mentions', mentionsInVoice: true, chimes: true };

/**
 * Server-synced user settings (UserSettings row): preferred status, notification preferences and appearance.
 * Loaded after sign-in; writes are optimistic, debounced and version-checked (412 → reload and reapply once).
 */
@Injectable({ providedIn: 'root' })
export class UserSettingsService {
  private readonly api = inject(ApiService);
  private readonly session = inject(SessionService);
  private readonly prefs = inject(PreferencesService);

  private readonly _status = signal<PreferredStatus>('online');
  private readonly _notify = signal<NotificationPrefs>(NOTIFY_DEFAULTS);
  private readonly _loaded = signal(false);
  readonly preferredStatus = this._status.asReadonly();
  readonly notifications = this._notify.asReadonly();
  readonly loaded = this._loaded.asReadonly();

  private version: string | null = null;
  private pending: Partial<{ preferredStatus: PreferredStatus; notifications: NotificationPrefs; appearance: object }> = {};
  private timer?: ReturnType<typeof setTimeout>;
  /** Last appearance known to the server (skip echoing remote values back). */
  private syncedAppearance = '';

  constructor() {
    effect(() => {
      const authed = this.session.status() === 'authenticated';
      untracked(() => (authed ? void this.load() : this.reset()));
    });
    // Appearance changes made anywhere (settings, shortcuts) are synced to the server.
    effect(() => {
      const a = this.prefs.appearance();
      untracked(() => {
        const json = JSON.stringify(a);
        if (this._loaded() && json !== this.syncedAppearance) {
          this.syncedAppearance = json;
          this.queue({ appearance: a });
        }
      });
    });
  }

  setStatus(status: PreferredStatus): void {
    this._status.set(status);
    this.queue({ preferredStatus: status }, 0);
  }

  updateNotifications(patch: Partial<NotificationPrefs>): void {
    this._notify.update((n) => ({ ...n, ...patch }));
    this.queue({ notifications: this._notify() });
  }

  private async load(): Promise<void> {
    try {
      const s = await this.api.get<UserSettings>('/users/me/settings');
      this.applyRemote(s);
      this._loaded.set(true);
    } catch {
      /* defaults stay in effect; a later write reloads */
    }
  }

  private applyRemote(s: UserSettings): void {
    this.version = s.version;
    this._status.set(normalizeStatus(s.preferredStatus));
    this._notify.set(sanitizeNotify(s.notifications));
    this.prefs.applyRemote(s.appearance);
    this.syncedAppearance = JSON.stringify(this.prefs.appearance());
  }

  private reset(): void {
    clearTimeout(this.timer);
    this.pending = {};
    this.version = null;
    this._loaded.set(false);
    this._status.set('online');
    this._notify.set(NOTIFY_DEFAULTS);
  }

  private queue(patch: typeof this.pending, delay = 600): void {
    this.pending = { ...this.pending, ...patch };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), delay);
  }

  private async flush(retried = false): Promise<void> {
    if (!this.version || Object.keys(this.pending).length === 0) return;
    const body = this.pending;
    this.pending = {};
    try {
      const s = await this.api.patch<UserSettings>('/users/me/settings', { ...body, expectedVersion: this.version });
      this.version = s.version;
    } catch (e) {
      if (ApiError.from(e).status === 412 && !retried) {
        // Changed on another device: take its version, keep our newer local values, write again.
        const latest = await this.api.get<UserSettings>('/users/me/settings').catch(() => null);
        if (latest) this.version = latest.version;
        this.pending = { ...body, ...this.pending };
        await this.flush(true);
      }
    }
  }
}

/** The API serializes the enum name (e.g. "DoNotDisturb"); the client uses camelCase. */
function normalizeStatus(raw: string | undefined): PreferredStatus {
  const v = (raw ?? '').toLowerCase();
  return v === 'idle' ? 'idle' : v === 'donotdisturb' ? 'doNotDisturb' : v === 'invisible' ? 'invisible' : 'online';
}

function sanitizeNotify(raw: Record<string, unknown> | undefined): NotificationPrefs {
  const r = raw ?? {};
  return {
    messages: r['messages'] === 'all' || r['messages'] === 'none' ? r['messages'] : 'mentions',
    mentionsInVoice: r['mentionsInVoice'] !== false,
    chimes: r['chimes'] !== false,
  };
}
