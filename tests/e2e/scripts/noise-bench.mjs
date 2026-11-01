// Noise model bench: RNNoise vs GTCRN (both from @sapphi-red/web-noise-suppressor) on fan noise, keyboard clicks and
// speech, in a real 48 kHz AudioContext like a call. Reports how much of each input survives (dB, lower = removed;
// for speech, closer to 0 dB = kept). No server needed: the worklets and models are served from node_modules.
// Usage: node scripts/noise-bench.mjs
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fakeVoiceFile } from './lib/fake-voice.mjs';

const DIST = resolve(import.meta.dirname, '../../../apps/web/node_modules/@sapphi-red/web-noise-suppressor/dist');
const ORIGIN = 'https://bench.local';
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext()).newPage();
await page.route(`${ORIGIN}/**`, (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>bench</title>' });
  if (path === '/voice.wav') return route.fulfill({ contentType: 'audio/wav', body: readFileSync(fakeVoiceFile()) });
  const type = path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
  return route.fulfill({ contentType: type, body: readFileSync(resolve(DIST, '.' + path)) });
});
await page.goto(ORIGIN + '/');

const result = await page.evaluate(async () => {
  const RATE = 48000, SECONDS = 4;
  const fill = (kind, voice) => {
    const d = new Float32Array(RATE * SECONDS);
    if (kind === 'fan') {
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.004;
      }
    } else if (kind === 'keys') {
      // Keystrokes: a sharp click with a short resonant tail, irregular ~7 per second.
      let t = 0.05;
      while (t < SECONDS - 0.05) {
        const at = Math.floor(t * RATE), f = 2000 + Math.random() * 3000, amp = 0.15 + Math.random() * 0.15;
        for (let i = 0; i < RATE * 0.03; i++) {
          const env = Math.exp(-i / (RATE * 0.004));
          d[at + i] += amp * env * ((Math.random() * 2 - 1) * 0.6 + Math.sin((2 * Math.PI * f * i) / RATE) * 0.4);
        }
        t += 0.08 + Math.random() * 0.2;
      }
    } else d.set(voice.subarray(0, d.length));
    return d;
  };
  const voiceBuf = await new AudioContext({ sampleRate: RATE }).decodeAudioData(await (await fetch('/voice.wav')).arrayBuffer());
  const voice = voiceBuf.getChannelData(0);

  async function run(model, kind) {
    const ctx = new AudioContext({ sampleRate: RATE });
    await ctx.resume();
    // A chain of worklet nodes: 'both' = RNNoise (steady noise) then GTCRN (clicks and other transients).
    const nodes = [];
    for (const m of model === 'both' ? ['rnnoise', 'gtcrn'] : model === 'none' ? [] : [model]) {
      const wasm = await (await fetch(m === 'rnnoise' ? '/rnnoise_simd.wasm' : '/gtcrn.wasm')).arrayBuffer();
      // Worklet module fetches bypass Playwright routing: load the script through a blob URL instead.
      const code = await (await fetch(`/${m}/workletProcessor.js`)).text();
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      nodes.push(new AudioWorkletNode(ctx, `@sapphi-red/web-noise-suppressor/${m}`, { processorOptions: { maxChannels: 1, wasmBinary: wasm } }));
    }
    const buf = ctx.createBuffer(1, RATE * SECONDS, RATE);
    buf.copyToChannel(fill(kind, voice), 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    const sink = ctx.createGain();
    sink.gain.value = 0;
    nodes.reduce((prev, n) => prev.connect(n), src).connect(an).connect(sink).connect(ctx.destination);
    src.start();
    // Skip the first second (models adapt), then average the level over the rest.
    await new Promise((r) => setTimeout(r, 1000));
    const f = new Float32Array(an.fftSize);
    let sum = 0, n = 0;
    const until = performance.now() + (SECONDS - 1.3) * 1000;
    while (performance.now() < until) {
      an.getFloatTimeDomainData(f);
      sum += f.reduce((s, v) => s + v * v, 0) / f.length;
      n++;
      await new Promise((r) => setTimeout(r, 20));
    }
    await ctx.close();
    return 10 * Math.log10(sum / n + 1e-12);
  }

  const out = {};
  for (const kind of ['fan', 'keys', 'speech']) {
    const dry = await run('none', kind);
    out[kind] = { input: dry };
    for (const model of ['rnnoise', 'gtcrn', 'both']) out[kind][model] = (await run(model, kind)) - dry;
  }
  return out;
});

const f = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`.padStart(9);
console.log('input        level      RNNoise    GTCRN     both   (change in level; noise: lower is better, speech: near 0 is better)');
for (const [kind, r] of Object.entries(result)) console.log(`${kind.padEnd(8)} ${r.input.toFixed(1).padStart(7)} dBFS ${f(r.rnnoise)} ${f(r.gtcrn)} ${f(r.both)}`);
await browser.close();
