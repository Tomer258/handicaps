import { Injectable, effect, signal } from '@angular/core';

export type Theme = 'dark' | 'light';
export type Accent = 'volt' | 'glacier' | 'ember' | 'iris';
export type Density = 'cozy' | 'compact';

export interface Appearance {
  theme: Theme;
  accent: Accent;
  density: Density;
  fontScale: number; // 85–125 (%)
  reduceMotion: boolean;
}

const KEY = 'hangar.appearance';
const DEFAULTS: Appearance = { theme: 'dark', accent: 'volt', density: 'cozy', fontScale: 100, reduceMotion: false };

/**
 * Display preferences. Applied to <html> as data attributes so overlays outside the shell inherit them.
 * Persisted locally for instant boot; synced to UserSettings.appearance by the settings feature.
 * Never stores credentials.
 */
@Injectable({ providedIn: 'root' })
export class PreferencesService {
  private readonly _appearance = signal<Appearance>(this.load());
  readonly appearance = this._appearance.asReadonly();

  constructor() {
    effect(() => {
      const a = this._appearance();
      const root = document.documentElement;
      root.dataset['theme'] = a.theme;
      if (a.accent === 'volt') delete root.dataset['accent'];
      else root.dataset['accent'] = a.accent;
      if (a.reduceMotion) root.dataset['reduceMotion'] = '';
      else delete root.dataset['reduceMotion'];
      root.style.setProperty('--msg', `${((15 * a.fontScale) / 100).toFixed(1)}px`);
      try {
        localStorage.setItem(KEY, JSON.stringify(a));
      } catch {
        /* storage may be unavailable (private mode); preferences still apply for this tab */
      }
    });
  }

  update(patch: Partial<Appearance>): void {
    this._appearance.update((a) => sanitize({ ...a, ...patch }));
  }

  /** Apply server-side values (UserSettings.appearance) after login. */
  applyRemote(raw: Record<string, unknown> | undefined): void {
    if (raw && Object.keys(raw).length > 0) this._appearance.set(sanitize({ ...this._appearance(), ...(raw as Partial<Appearance>) }));
  }

  private load(): Appearance {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? sanitize({ ...DEFAULTS, ...JSON.parse(raw) }) : DEFAULTS;
    } catch {
      return DEFAULTS;
    }
  }
}

function sanitize(a: Appearance): Appearance {
  return {
    theme: a.theme === 'light' ? 'light' : 'dark',
    accent: (['volt', 'glacier', 'ember', 'iris'] as const).includes(a.accent) ? a.accent : 'volt',
    density: a.density === 'compact' ? 'compact' : 'cozy',
    fontScale: Math.min(125, Math.max(85, Number(a.fontScale) || 100)),
    reduceMotion: !!a.reduceMotion,
  };
}
