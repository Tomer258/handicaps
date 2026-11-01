import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, signal } from '@angular/core';
import { DevicesService } from '../../core/media/devices.service';
import { MediaPrefs, MediaPrefsService, NoiseMode, keyLabel } from '../../core/media/media-prefs.service';
import { MediaSessionService } from '../../core/media/media-session.service';
import { GateConfig, createMicGate, createNoiseFilter, noiseContext } from '../../core/media/noise-filter';

/** Voice & audio: microphone / speaker choice, input mode, a real input level test and browser audio processing. */
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

    <div class="srow" style="margin-top: 8px"><div><div class="t">Input mode</div>
        <div class="d">{{ prefs.prefs().inputMode === 'ptt' ? 'Your mic only sends while you hold the key' : 'Your mic sends when you talk' }}</div></div>
      <div class="seg" role="group" aria-label="Input mode">
        <button [attr.aria-pressed]="prefs.prefs().inputMode === 'voice'" (click)="set({ inputMode: 'voice' })">Voice activity</button>
        <button [attr.aria-pressed]="prefs.prefs().inputMode === 'ptt'" (click)="set({ inputMode: 'ptt' })">Push to talk</button>
      </div></div>
    @if (prefs.prefs().inputMode === 'ptt') {
      <div class="srow"><div><div class="t">Push-to-talk key</div>
          <div class="d">{{ recording() ? 'Press a key or a side mouse button… (Esc cancels)' : 'Hold it to talk. Works while the Hangar tab is focused.' }}</div></div>
        <div style="display: flex; align-items: center; gap: 8px">
          <span class="kbd" aria-label="Current key">{{ keyLabel(prefs.prefs().pttKey) }}</span>
          <button class="btn" [class.pri]="recording()" [class.sec]="!recording()" (click)="recordKey()">{{ recording() ? 'Listening…' : 'Change key' }}</button>
        </div></div>
      <div class="srow"><div><div class="t">Release delay</div><div class="d">Keeps sending a moment after you let go, so your last word isn't cut</div></div>
        <div style="display: flex; align-items: center; gap: 10px; min-width: 220px">
          <input type="range" class="rng" min="0" max="1000" step="20" style="flex: 1" aria-label="Release delay"
                 [value]="prefs.prefs().pttReleaseMs" (input)="set({ pttReleaseMs: +$any($event.target).value })" />
          <span class="mono" style="width: 56px; text-align: right; font-size: 12.5px">{{ prefs.prefs().pttReleaseMs }} ms</span>
        </div></div>
    } @else {
      <div class="srow"><div><div class="t">Automatic input sensitivity</div>
          <div class="d">{{ prefs.prefs().sensitivityAuto ? 'Sends everything noise suppression lets through' : 'Sends only when you are louder than the line on the mic test meter' }}</div></div>
        <button class="sw" aria-label="Automatic input sensitivity" [attr.aria-pressed]="prefs.prefs().sensitivityAuto" (click)="set({ sensitivityAuto: !prefs.prefs().sensitivityAuto })"></button></div>
    }
    @if (media.micGateUnavailable() && (prefs.prefs().inputMode === 'ptt' || !prefs.prefs().sensitivityAuto)) {
      <div class="note" role="status" style="margin-top: 8px">Push to talk and input sensitivity aren't available in this browser right now — your mic stays open.</div>
    }

    <div class="card" style="margin-top: 20px">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px">
        <div><div style="font-weight: 600">Mic test</div>
          <div style="font-size: 12.5px; color: var(--tx3)">Talk normally — you'll hear yourself the way friends hear you, with the settings below. Use headphones to avoid feedback.</div></div>
        <button class="btn" [class.pri]="!testing()" [class.sec]="testing()" (click)="toggleTest()">{{ testing() ? 'Stop test' : "Let's check" }}</button>
      </div>
      <div style="display: flex; align-items: center; gap: 12px; margin-top: 14px">
        <div class="meter" role="meter" aria-label="Microphone level" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="level()" style="position: relative">
          <i [style.width.%]="level()" [style.background]="sending() ? 'var(--accent)' : 'var(--tx3)'"></i>
          @if (manualSensitivity()) {
            <b aria-hidden="true" [style.left.%]="pct(prefs.prefs().sensitivityDb)"
               style="position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--warn); border-radius: 1px"></b>
          }
        </div>
      </div>
      @if (manualSensitivity()) {
        <div style="display: flex; align-items: center; gap: 10px; margin-top: 10px">
          <input type="range" class="rng" min="-60" max="0" step="1" style="flex: 1" aria-label="Input sensitivity"
                 [value]="prefs.prefs().sensitivityDb" (input)="setSensitivity(+$any($event.target).value)" />
          <span class="mono" style="width: 56px; text-align: right; font-size: 12.5px">{{ prefs.prefs().sensitivityDb }} dB</span>
        </div>
        <div style="font-size: 12px; color: var(--tx3); margin-top: 4px">Run the test and drag the line just above your background noise: the bar turns green when your mic sends.</div>
      }
      @if (prefs.prefs().inputMode === 'ptt' && testing()) {
        <div style="font-size: 12px; color: var(--tx3); margin-top: 8px" role="status">{{ media.pttDown() ? 'Sending' : 'Hold ' + keyLabel(prefs.prefs().pttKey) + ' to talk' }}</div>
      }
      @if (testError()) { <div class="note e" role="alert" style="margin-top: 10px">{{ testError() }}</div> }
    </div>

    <div class="srow"><div><div class="t">Noise suppression</div>
        <div class="d">{{ noiseHint[prefs.prefs().noiseMode] }}</div>
        @if (prefs.prefs().noiseMode === 'enhanced' && media.noiseFilterUnavailable()) {
          <div class="d" role="status" style="color: var(--warn)">Enhanced isn't available in this browser right now — Standard is used instead.</div>
        }</div>
      <div class="seg" role="group" aria-label="Noise suppression">
        <button [attr.aria-pressed]="prefs.prefs().noiseMode === 'off'" (click)="set({ noiseMode: 'off' })">Off</button>
        <button [attr.aria-pressed]="prefs.prefs().noiseMode === 'standard'" (click)="set({ noiseMode: 'standard' })">Standard</button>
        <button [attr.aria-pressed]="prefs.prefs().noiseMode === 'enhanced'" (click)="set({ noiseMode: 'enhanced' })">Enhanced</button>
      </div></div>
    <div class="srow"><div><div class="t">Echo cancellation</div><div class="d">Keep on if you use speakers instead of headphones. Applies in calls; the mic test plays without it.</div></div>
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
  readonly media = inject(MediaSessionService);
  readonly keyLabel = keyLabel;
  readonly noiseHint: Record<NoiseMode, string> = {
    off: 'Sends your microphone as it is — for studio mics and quiet rooms',
    standard: "The browser's built-in filter: steady hum and fans",
    enhanced: "AI filter on your PC: keyboards, fans, clicks and that one friend's mechanical switches",
  };

  readonly testing = signal(false);
  readonly level = signal(0);
  readonly testError = signal('');
  readonly recording = signal(false);
  /** The test's gate is open (it would send). */
  private readonly gateOpen = signal(false);
  private stream?: MediaStream;
  private ctx?: AudioContext;
  private gate?: AudioWorkletNode;
  private raf = 0;
  /** Bumped by every start/stop so a slow getUserMedia or filter load cannot revive a stopped test. */
  private testRun = 0;
  private recordCleanup?: () => void;

  constructor() {
    void this.devices.refresh();
    inject(DestroyRef).onDestroy(() => {
      this.stopTest();
      this.stopRecording();
    });
    // The push-to-talk key is tracked by MediaSessionService; mirror it into the test's gate.
    effect(() => {
      const down = this.media.pttDown();
      this.gate?.port.postMessage({ pttDown: down });
    });
  }

  manualSensitivity(): boolean {
    const p = this.prefs.prefs();
    return p.inputMode === 'voice' && !p.sensitivityAuto;
  }

  /** The bar is green while the mic would send. */
  sending(): boolean {
    return this.gate ? this.gateOpen() && this.level() > 2 : this.level() > 8;
  }

  /** dBFS → meter position (the meter shows -60…0 dB). */
  pct(db: number): number {
    return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  }

  set(patch: Partial<MediaPrefs>): void {
    const before = this.prefs.prefs();
    this.prefs.update(patch);
    if (!this.testing()) return;
    const p = this.prefs.prefs();
    // Re-open with the new device/processing; gate-only changes apply live so the meter keeps going.
    if (p.inputDeviceId !== before.inputDeviceId || p.outputDeviceId !== before.outputDeviceId || p.noiseMode !== before.noiseMode
      || p.autoGainControl !== before.autoGainControl || !!this.gate !== this.wantsGate()) void this.startTest();
    else this.gate?.port.postMessage({ ...this.gateConfig() });
  }

  setSensitivity(db: number): void {
    this.set({ sensitivityDb: db });
  }

  toggleTest(): void {
    if (this.testing()) this.stopTest();
    else void this.startTest();
  }

  recordKey(): void {
    if (this.recording()) return this.stopRecording();
    this.recording.set(true);
    this.media.pttRecording.set(true);
    const done = (code: string | null) => {
      if (code) this.set({ pttKey: code });
      this.stopRecording();
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      done(e.code === 'Escape' ? null : e.code || null);
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button <= 2) return;
      e.preventDefault();
      done(`Mouse${e.button}`);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
    this.recordCleanup = () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
    };
  }

  private stopRecording(): void {
    this.recordCleanup?.();
    this.recordCleanup = undefined;
    this.recording.set(false);
    this.media.pttRecording.set(false);
  }

  private wantsGate(): boolean {
    return this.gateConfig().mode !== 'open';
  }

  /** Same gate as the call (MediaSessionService.gateConfig). */
  private gateConfig(): GateConfig {
    const p = this.prefs.prefs();
    const mode = this.media.micGateUnavailable() ? 'open' : p.inputMode === 'ptt' ? 'ptt' : p.sensitivityAuto ? 'open' : 'vad';
    return { mode, thresholdDb: p.sensitivityDb, releaseMs: p.pttReleaseMs };
  }

  private async startTest(): Promise<void> {
    this.stopTest();
    const run = ++this.testRun;
    this.testError.set('');
    const p = this.prefs.prefs();
    const enhanced = p.noiseMode === 'enhanced' && !this.media.noiseFilterUnavailable();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: p.inputDeviceId ? { exact: p.inputDeviceId } : undefined,
          // Same capture as a call: Enhanced runs RNNoise below instead of the browser's filter.
          noiseSuppression: p.noiseMode === 'standard' || (p.noiseMode === 'enhanced' && !enhanced),
          // No echo cancellation here: it treats the test's own playback as echo and chops the voice up. In a call
          // it cancels the friends' voices coming out of your speakers, which the test has none of.
          echoCancellation: false, autoGainControl: p.autoGainControl, channelCount: 1,
        },
      });
    } catch (e) {
      if (run === this.testRun)
        this.testError.set((e as Error)?.name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in the browser address bar.' : 'That microphone is unavailable.');
      return;
    }
    if (run !== this.testRun) return stream.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    void this.devices.refresh();
    let ctx: AudioContext | undefined;
    let filter: AudioNode | undefined;
    if (enhanced) {
      try {
        ctx = await noiseContext();
        filter = await createNoiseFilter(ctx);
      } catch {
        void ctx?.close().catch(() => undefined);
        ctx = filter = undefined;
      }
    }
    ctx ??= new AudioContext();
    if (run !== this.testRun) return void ctx.close().catch(() => undefined);
    this.ctx = ctx;
    let gate: AudioWorkletNode | undefined;
    if (this.wantsGate()) {
      try {
        gate = await createMicGate(ctx);
        gate.port.postMessage({ ...this.gateConfig(), pttDown: this.media.pttDown(), report: true });
        gate.port.onmessage = (e: MessageEvent<{ open: boolean }>) => this.gateOpen.set(e.data.open);
      } catch {
        gate = undefined;
      }
    }
    if (run !== this.testRun) return;
    this.gate = gate;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const source = ctx.createMediaStreamSource(stream);
    // Play it back: what friends hear, after the same processing, on the chosen speakers.
    // The meter shows the level before the gate, so the sensitivity line can be set against it.
    const processed = (filter ? source.connect(filter) : source).connect(analyser);
    (gate ? processed.connect(gate) : processed).connect(ctx.destination);
    const sink = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (p.outputDeviceId && sink.setSinkId) await sink.setSinkId(p.outputDeviceId).catch(() => undefined);
    if (run !== this.testRun) return;
    const buf = new Float32Array(analyser.fftSize);
    this.testing.set(true);
    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-8);
      this.level.set(Math.round(this.pct(db)));
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  private stopTest(): void {
    this.testRun++;
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.gate = undefined;
    this.gateOpen.set(false);
    void this.ctx?.close().catch(() => undefined);
    this.ctx = undefined;
    this.testing.set(false);
    this.level.set(0);
  }
}
