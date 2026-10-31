import { Injectable, signal } from '@angular/core';
import type { ScreenQuality } from './media-session.service';

/** off = raw mic · standard = the browser's WebRTC suppression · enhanced = RNNoise (core/media/noise-filter.ts). */
export type NoiseMode = 'off' | 'standard' | 'enhanced';

/** voice = voice activity (open mic, or gated by `sensitivity*`) · ptt = push to talk. */
export type InputMode = 'voice' | 'ptt';

export interface MediaPrefs {
  /** '' = browser/OS default. Device ids are per-origin and per-browser, so they stay local. */
  inputDeviceId: string;
  outputDeviceId: string;
  cameraDeviceId: string;
  noiseMode: NoiseMode;
  echoCancellation: boolean;
  autoGainControl: boolean;
  inputMode: InputMode;
  /** Voice activity: true = send whenever the mic hears anything (filtered by noise suppression only). */
  sensitivityAuto: boolean;
  /** Voice activity with manual sensitivity: send only above this level, dBFS (-60…0). */
  sensitivityDb: number;
  /** KeyboardEvent.code, or 'Mouse3'/'Mouse4' for the side mouse buttons. */
  pttKey: string;
  /** Push to talk: keep sending this long after the key is released, ms (0…1000). */
  pttReleaseMs: number;
  streamQuality: ScreenQuality;
  /** Screen-share sound with the browser's default audio settings: set once clean capture failed and this worked. */
  screenAudioCompat: boolean;
}

const KEY = 'hangar.mediaPrefs';
const DEFAULTS: MediaPrefs = {
  inputDeviceId: '',
  outputDeviceId: '',
  cameraDeviceId: '',
  noiseMode: 'enhanced',
  echoCancellation: true,
  autoGainControl: true,
  inputMode: 'voice',
  sensitivityAuto: true,
  sensitivityDb: -50,
  pttKey: 'Backquote',
  pttReleaseMs: 200,
  streamQuality: '1080p60',
  screenAudioCompat: false,
};

/** Local device and processing choices. Applied by MediaSessionService on the next capture (and live where possible). */
@Injectable({ providedIn: 'root' })
export class MediaPrefsService {
  private readonly _prefs = signal<MediaPrefs>(load());
  readonly prefs = this._prefs.asReadonly();

  update(patch: Partial<MediaPrefs>): void {
    this._prefs.update((p) => ({ ...p, ...patch }));
    try {
      localStorage.setItem(KEY, JSON.stringify(this._prefs()));
    } catch {
      /* storage unavailable */
    }
  }
}

function load(): MediaPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as (Partial<MediaPrefs> & { noiseSuppression?: boolean }) | null;
    if (!raw) return DEFAULTS;
    return {
      inputDeviceId: typeof raw.inputDeviceId === 'string' ? raw.inputDeviceId : '',
      outputDeviceId: typeof raw.outputDeviceId === 'string' ? raw.outputDeviceId : '',
      cameraDeviceId: typeof raw.cameraDeviceId === 'string' ? raw.cameraDeviceId : '',
      // Before the modes there was only an on/off switch (noiseSuppression); 'on' becomes enhanced.
      noiseMode: raw.noiseMode === 'off' || raw.noiseMode === 'standard' || raw.noiseMode === 'enhanced' ? raw.noiseMode : raw.noiseSuppression === false ? 'off' : 'enhanced',
      echoCancellation: raw.echoCancellation !== false,
      autoGainControl: raw.autoGainControl !== false,
      inputMode: raw.inputMode === 'ptt' ? 'ptt' : 'voice',
      sensitivityAuto: raw.sensitivityAuto !== false,
      sensitivityDb: num(raw.sensitivityDb, -60, 0, DEFAULTS.sensitivityDb),
      pttKey: typeof raw.pttKey === 'string' && /^[A-Za-z0-9]{1,24}$/.test(raw.pttKey) ? raw.pttKey : DEFAULTS.pttKey,
      pttReleaseMs: num(raw.pttReleaseMs, 0, 1000, DEFAULTS.pttReleaseMs),
      streamQuality: raw.streamQuality === '720p30' ? '720p30' : '1080p60',
      screenAudioCompat: raw.screenAudioCompat === true,
    };
  } catch {
    return DEFAULTS;
  }
}

function num(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : fallback;
}

/** A readable name for a push-to-talk binding: "`", "V", "F13", "Mouse 4". */
export function keyLabel(code: string): string {
  const mouse = /^Mouse(\d)$/.exec(code);
  if (mouse) return `Mouse ${+mouse[1] + 1}`;
  const named: Record<string, string> = {
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
    Comma: ',', Period: '.', Slash: '/', Space: 'Space', CapsLock: 'Caps Lock', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
    AltLeft: 'Left Alt', AltRight: 'Right Alt', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', MetaLeft: 'Left Win', MetaRight: 'Right Win',
  };
  if (named[code]) return named[code];
  return code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ');
}
