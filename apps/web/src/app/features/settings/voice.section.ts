import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { DevicesService } from '../../core/media/devices.service';
import { MediaPrefs, MediaPrefsService } from '../../core/media/media-prefs.service';

/** Voice & audio: microphone / speaker choice, a real input level test and browser audio processing. */
@Component({
  selector: 'hx-voice-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="disp" style="margin: 0 0 20px; font-size: 26px">Voice &amp; audio</h2>
    @if (!devices.labelled()) {
      <div class="note" style="margin-bottom: 16px; align-items: center">
        <span style="flex: 1">Device names appear after you allow microphone access once.</span>
        <button class="btn sec" (click)="devices.requestLabels('audio')">Allow access</button>
      </div>
    }
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px">
      <div class="field"><label for="idev">Microphone</label>
        <select id="idev" class="inp" [value]="prefs.prefs().inputDeviceId" (change)="set({ inputDeviceId: $any($event.target).value })">
          <option value="">System default</option>
          @for (d of devices.inputs(); track d.id) { <option [value]="d.id" [selected]="d.id === prefs.prefs().inputDeviceId">{{ d.label }}</option> }
        </select></div>
      <div class="field"><label for="odev">Speakers</label>
        <select id="odev" class="inp" [value]="prefs.prefs().outputDeviceId" (change)="set({ outputDeviceId: $any($event.target).value })" [disabled]="!devices.canPickOutput">
          <option value="">System default</option>
          @for (d of devices.outputs(); track d.id) { <option [value]="d.id" [selected]="d.id === prefs.prefs().outputDeviceId">{{ d.label }}</option> }
        </select>
        @if (!devices.canPickOutput) { <span style="font-size: 12px; color: var(--tx3)">This browser always uses the system output device.</span> }
      </div>
    </div>

    <div class="card" style="margin-top: 20px">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px">
        <div><div style="font-weight: 600">Mic test</div>
          <div style="font-size: 12.5px; color: var(--tx3)">Talk normally — the bar shows what your microphone picks up with the settings below.</div></div>
        <button class="btn" [class.pri]="!testing()" [class.sec]="testing()" (click)="toggleTest()">{{ testing() ? 'Stop test' : "Let's check" }}</button>
      </div>
      <div style="display: flex; align-items: center; gap: 12px; margin-top: 14px">
        <div class="meter" role="meter" aria-label="Microphone level" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="level()">
          <i [style.width.%]="level()" [style.background]="level() > 8 ? 'var(--accent)' : 'var(--tx3)'"></i>
        </div>
      </div>
      @if (testError()) { <div class="note e" role="alert" style="margin-top: 10px">{{ testError() }}</div> }
    </div>

    <div class="srow"><div><div class="t">Noise suppression</div><div class="d">Filters keyboards, fans and that one friend's mechanical switches</div></div>
      <button class="sw" aria-label="Noise suppression" [attr.aria-pressed]="prefs.prefs().noiseSuppression" (click)="set({ noiseSuppression: !prefs.prefs().noiseSuppression })"></button></div>
    <div class="srow"><div><div class="t">Echo cancellation</div><div class="d">Keep on if you use speakers instead of headphones</div></div>
      <button class="sw" aria-label="Echo cancellation" [attr.aria-pressed]="prefs.prefs().echoCancellation" (click)="set({ echoCancellation: !prefs.prefs().echoCancellation })"></button></div>
    <div class="srow"><div><div class="t">Automatic gain control</div><div class="d">Evens out your volume when you lean back or shout</div></div>
      <button class="sw" aria-label="Automatic gain control" [attr.aria-pressed]="prefs.prefs().autoGainControl" (click)="set({ autoGainControl: !prefs.prefs().autoGainControl })"></button></div>
    <div class="srow" style="border-bottom: 0"><div><div class="t">Keyboard shortcuts</div><div class="d">Work while the Hangar tab is focused</div></div>
      <div style="display: flex; gap: 6px; flex-wrap: wrap"><span class="kbd">Ctrl+Shift+M</span><span style="color: var(--tx3); font-size: 12px">mute</span>
        <span class="kbd">Ctrl+Shift+D</span><span style="color: var(--tx3); font-size: 12px">deafen</span></div></div>
  `,
})
export class VoiceSection {
  readonly devices = inject(DevicesService);
  readonly prefs = inject(MediaPrefsService);

  readonly testing = signal(false);
  readonly level = signal(0);
  readonly testError = signal('');
  private stream?: MediaStream;
  private ctx?: AudioContext;
  private raf = 0;

  constructor() {
    void this.devices.refresh();
    inject(DestroyRef).onDestroy(() => this.stopTest());
  }

  set(patch: Partial<MediaPrefs>): void {
    this.prefs.update(patch);
    if (this.testing()) void this.startTest(); // re-open with the new device/processing
  }

  toggleTest(): void {
    if (this.testing()) this.stopTest();
    else void this.startTest();
  }

  private async startTest(): Promise<void> {
    this.stopTest();
    this.testError.set('');
    const p = this.prefs.prefs();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: p.inputDeviceId ? { exact: p.inputDeviceId } : undefined,
          noiseSuppression: p.noiseSuppression, echoCancellation: p.echoCancellation, autoGainControl: p.autoGainControl,
        },
      });
    } catch (e) {
      this.testError.set((e as Error)?.name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in the browser address bar.' : 'That microphone is unavailable.');
      return;
    }
    void this.devices.refresh();
    this.ctx = new AudioContext();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    this.ctx.createMediaStreamSource(this.stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    this.testing.set(true);
    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-8);
      this.level.set(Math.round(Math.max(0, Math.min(100, ((db + 60) / 60) * 100))));
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  private stopTest(): void {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = undefined;
    this.testing.set(false);
    this.level.set(0);
  }
}
