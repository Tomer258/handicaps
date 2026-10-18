import { Injectable, signal } from '@angular/core';
import type { ScreenQuality } from './media-session.service';

export interface MediaPrefs {
  /** '' = browser/OS default. Device ids are per-origin and per-browser, so they stay local. */
  inputDeviceId: string;
  outputDeviceId: string;
  cameraDeviceId: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  streamQuality: ScreenQuality;
  /** Screen-share sound with the browser's default audio settings: set once clean capture failed and this worked. */
  screenAudioCompat: boolean;
}

const KEY = 'hangar.mediaPrefs';
const DEFAULTS: MediaPrefs = {
  inputDeviceId: '',
  outputDeviceId: '',
  cameraDeviceId: '',
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
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
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<MediaPrefs> | null;
    if (!raw) return DEFAULTS;
    return {
      inputDeviceId: typeof raw.inputDeviceId === 'string' ? raw.inputDeviceId : '',
      outputDeviceId: typeof raw.outputDeviceId === 'string' ? raw.outputDeviceId : '',
      cameraDeviceId: typeof raw.cameraDeviceId === 'string' ? raw.cameraDeviceId : '',
      noiseSuppression: raw.noiseSuppression !== false,
      echoCancellation: raw.echoCancellation !== false,
      autoGainControl: raw.autoGainControl !== false,
      streamQuality: raw.streamQuality === '720p30' ? '720p30' : '1080p60',
      screenAudioCompat: raw.screenAudioCompat === true,
    };
  } catch {
    return DEFAULTS;
  }
}
