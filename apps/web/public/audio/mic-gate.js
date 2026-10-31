// Hangar microphone gate (AudioWorklet): push to talk and input sensitivity.
// Runs on the audio thread, so it keeps working while the tab is in the background (timers there are throttled).
// Messages in: { mode: 'open' | 'vad' | 'ptt', thresholdDb, pttDown, releaseMs, report }.
// Messages out (only while `report`): { level (dBFS, smoothed), open } about 25 times a second.

const ATTACK_S = 0.005; // fade in fast so the first syllable is not cut
const FADE_S = 0.04; // fade out after the hold, no click
const VAD_HOLD_S = 0.3; // keep open between words
const LEVEL_TAU_S = 0.02;

class MicGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = 'open';
    this.thresholdDb = -50;
    this.pttDown = false;
    this.releaseS = 0.2;
    this.report = false;
    this.power = 0;
    this.gain = 1;
    this.holdUntil = 0;
    this.nextReport = 0;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.mode === 'open' || m.mode === 'vad' || m.mode === 'ptt') this.mode = m.mode;
      if (typeof m.thresholdDb === 'number') this.thresholdDb = m.thresholdDb;
      if (typeof m.releaseMs === 'number') this.releaseS = Math.max(0, m.releaseMs) / 1000;
      if (typeof m.report === 'boolean') this.report = m.report;
      if (typeof m.pttDown === 'boolean') {
        // Releasing the key keeps the mic open for the release delay, so the last word gets through.
        if (this.pttDown && !m.pttDown) this.holdUntil = currentTime + this.releaseS;
        this.pttDown = m.pttDown;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const frames = output[0] ? output[0].length : 128;
    const src = input && input[0];
    let sum = 0;
    if (src) for (let i = 0; i < src.length; i++) sum += src[i] * src[i];
    const blockPower = src ? sum / src.length : 0;
    const k = 1 - Math.exp(-frames / (sampleRate * LEVEL_TAU_S));
    this.power += (blockPower - this.power) * k;
    const levelDb = 10 * Math.log10(this.power + 1e-12);

    let open;
    if (this.mode === 'open') open = true;
    else if (this.mode === 'ptt') open = this.pttDown || currentTime < this.holdUntil;
    else {
      if (levelDb >= this.thresholdDb) this.holdUntil = currentTime + VAD_HOLD_S;
      open = currentTime < this.holdUntil;
    }

    const target = open ? 1 : 0;
    const step = frames / (sampleRate * (open ? ATTACK_S : FADE_S));
    const from = this.gain;
    const to = target > from ? Math.min(target, from + step) : Math.max(target, from - step);
    this.gain = to;
    for (let c = 0; c < output.length; c++) {
      const out = output[c];
      const inp = input && (input[c] || input[0]);
      for (let i = 0; i < out.length; i++) out[i] = inp ? inp[i] * (from + ((to - from) * i) / out.length) : 0;
    }

    if (this.report && currentTime >= this.nextReport) {
      this.nextReport = currentTime + 0.04;
      this.port.postMessage({ level: levelDb, open });
    }
    return true;
  }
}

registerProcessor('hangar-mic-gate', MicGate);
