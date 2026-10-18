import { Injectable, signal } from '@angular/core';

export interface DeviceOption {
  id: string;
  label: string;
}

/**
 * Media device lists for settings. Labels are empty until the user has granted a capture permission once,
 * so the UI offers an explicit "Allow access" step instead of prompting on page load.
 */
@Injectable({ providedIn: 'root' })
export class DevicesService {
  readonly inputs = signal<DeviceOption[]>([]);
  readonly outputs = signal<DeviceOption[]>([]);
  readonly cameras = signal<DeviceOption[]>([]);
  readonly labelled = signal(false);
  readonly canPickOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

  private listening = false;

  async refresh(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    if (!this.listening) {
      this.listening = true;
      navigator.mediaDevices.addEventListener('devicechange', () => void this.refresh());
    }
    const all = await navigator.mediaDevices.enumerateDevices();
    const pick = (kind: MediaDeviceKind, fallback: string) =>
      all.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
    this.inputs.set(pick('audioinput', 'Microphone'));
    this.outputs.set(pick('audiooutput', 'Speakers'));
    this.cameras.set(pick('videoinput', 'Camera'));
    this.labelled.set(all.some((d) => !!d.label));
  }

  /** Asks for access once so device names become visible; the stream is stopped immediately. */
  async requestLabels(kind: 'audio' | 'video'): Promise<boolean> {
    try {
      const s = await navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: true } : { video: true });
      s.getTracks().forEach((t) => t.stop());
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }
}
