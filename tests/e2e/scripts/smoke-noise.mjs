// Dev smoke for Enhanced/Strong noise suppression (RNNoise [+ GTCRN] in AudioWorklets, core/media/noise-filter.ts):
// the shipped model removes noise, old prefs migrate, the call publishes the filtered track, modes switch live,
// and a page that cannot load the filter falls back to the browser's suppression with a notice.
// Usage: node scripts/smoke-noise.mjs <out-dir>   (needs compose livekit + API + ng serve; users tomer & friend)
import { chromium } from '@playwright/test';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}
async function session(login, { blockFilter = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone', 'camera'] });
  // Keep every RTCPeerConnection so the smoke can see which track the mic sender really publishes.
  await ctx.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = class extends Native {
      constructor(...a) {
        super(...a);
        window.__pcs.push(this);
      }
    };
  });
  if (blockFilter) await ctx.route('**/noise/**', (r) => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${login}] page error:`, e.message));
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`);
  return page;
}
/** Label of the live audio track the mic sender publishes ('' when none). The fake device is "Fake Default Audio Input"…; RNNoise output comes from a MediaStreamAudioDestinationNode. */
const micSender = (page) => page.evaluate(() => {
  for (const pc of window.__pcs) {
    if (pc.connectionState === 'closed') continue;
    for (const s of pc.getSenders()) if (s.track?.kind === 'audio' && s.track.readyState === 'live') return s.track.label;
  }
  return '';
});
const isRaw = (label) => /fake/i.test(label);

const owner = await session('tomer');
const me = await owner.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
const serverId = me.servers[0].id;

// 1. The shipped model really removes noise: fan-like pink noise (-34 dBFS) through RNNoise in a live 48 kHz context,
// as in a call. (Synthetic white noise is a poor probe: RNNoise is trained on real noise and adapts to it slowly.)
const dsp = await owner.evaluate(async () => {
  const bin = await (await fetch('/noise/rnnoise_simd.wasm')).arrayBuffer();
  const ctx = new AudioContext({ sampleRate: 48000 });
  await ctx.resume();
  await ctx.audioWorklet.addModule('/noise/rnnoise/workletProcessor.js');
  const node = new AudioWorkletNode(ctx, '@sapphi-red/web-noise-suppressor/rnnoise', { processorOptions: { maxChannels: 1, wasmBinary: bin } });
  const buf = ctx.createBuffer(1, 48000 * 4, 48000);
  const data = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < data.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    data[i] = (b0 + b1 + b2 + w * 0.1848) * 0.004;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const aIn = ctx.createAnalyser();
  const aOut = ctx.createAnalyser();
  const sink = ctx.createGain();
  sink.gain.value = 0;
  src.connect(aIn);
  src.connect(node).connect(aOut).connect(sink).connect(ctx.destination);
  src.start();
  await new Promise((r) => setTimeout(r, 1500));
  const level = (an) => {
    const f = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(f);
    return f.reduce((s, v) => s + v * v, 0) / f.length;
  };
  let inSum = 0;
  let outSum = 0;
  for (let i = 0; i < 10; i++) {
    inSum += level(aIn);
    outSum += level(aOut);
    await new Promise((r) => setTimeout(r, 50));
  }
  await ctx.close();
  return { inRms: Math.sqrt(inSum / 10), outRms: Math.sqrt(outSum / 10) };
});
check(dsp.outRms < dsp.inRms * 0.1, `RNNoise removes fan-like noise (rms ${dsp.inRms.toFixed(3)} → ${dsp.outRms.toFixed(5)})`);

// 2. Prefs: the old on/off switch migrates (off stays off, on becomes Strong); the old default Enhanced moves to Strong once.
const modeIs = async (label) => (await owner.getByRole('group', { name: 'Noise suppression' }).getByRole('button', { name: label }).getAttribute('aria-pressed')) === 'true';
const openVoiceSettings = async () => {
  await owner.getByRole('button', { name: 'User settings' }).click();
  await owner.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Voice & audio', exact: true }).click();
  await owner.getByRole('group', { name: 'Noise suppression' }).waitFor();
};
const closeSettings = async () => {
  await owner.keyboard.press('Escape');
  await owner.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached' });
};
await owner.evaluate(() => localStorage.setItem('hangar.mediaPrefs', JSON.stringify({ noiseSuppression: false })));
await owner.goto(`${BASE}/s/${serverId}`);
await openVoiceSettings();
check(await modeIs('Off'), 'old "noise suppression off" migrates to Off');
await closeSettings();
await owner.evaluate(() => localStorage.setItem('hangar.mediaPrefs', JSON.stringify({ noiseSuppression: true })));
await owner.goto(`${BASE}/s/${serverId}`);
await openVoiceSettings();
check(await modeIs('Strong'), 'old "noise suppression on" migrates to Strong');
await closeSettings();
await owner.evaluate(() => localStorage.setItem('hangar.mediaPrefs', JSON.stringify({ noiseMode: 'enhanced' })));
await owner.goto(`${BASE}/s/${serverId}`);
await openVoiceSettings();
check(await modeIs('Strong'), 'Enhanced saved before Strong existed (the old default) moves to Strong');
await closeSettings();
await owner.evaluate(() => localStorage.setItem('hangar.mediaPrefs', JSON.stringify({ noiseMode: 'enhanced', noiseRev: 2 })));
await owner.goto(`${BASE}/s/${serverId}`);
await openVoiceSettings();
check(await modeIs('Enhanced'), 'Enhanced chosen after Strong existed stays Enhanced');
await owner.getByRole('group', { name: 'Noise suppression' }).getByRole('button', { name: 'Strong' }).click();

// Mic test runs through the filter too (worklet loaded, no fallback note).
// (Worklet module loads are invisible to Playwright; the model download marks the filter path.)
const modelLoad = owner.waitForResponse((r) => /\/noise\/gtcrn\.wasm$/.test(r.url()) && r.ok(), { timeout: 8000 });
await owner.getByRole('button', { name: "Let's check" }).click();
await modelLoad;
await owner.getByRole('button', { name: 'Stop test' }).waitFor({ timeout: 8000 });
check(true, 'mic test runs with Strong (GTCRN model loaded)');
await owner.getByRole('button', { name: 'Stop test' }).click();
await owner.screenshot({ path: `${outDir}/noise-settings.png` });
await closeSettings();

// 3. In a call the mic sender publishes the filtered track; switching modes applies live.
const friend = await session('friend', { blockFilter: true });
const detail = await owner.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), serverId);
const lounge = detail.channels.find((c) => c.name === 'Lounge');
for (const p of [owner, friend]) {
  await p.goto(`${BASE}/s/${serverId}/v/${lounge.id}`);
  await p.getByRole('button', { name: 'Join voice' }).click();
  await p.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 20000 });
}
const waitSender = async (page, raw, what) => {
  const until = Date.now() + 10000;
  let label = '';
  while (Date.now() < until) {
    label = await micSender(page);
    if (label && isRaw(label) === raw) return check(true, `${what} (sender track "${label}")`);
    await page.waitForTimeout(250);
  }
  check(false, `${what} (sender track "${label}")`);
};
await waitSender(owner, false, 'Enhanced: the call publishes the RNNoise output, not the raw mic');
const received = () => friend.evaluate(async () => {
  let bytes = 0;
  for (const pc of window.__pcs) {
    if (pc.connectionState === 'closed') continue;
    (await pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') bytes += r.bytesReceived; });
  }
  return bytes;
});
const before = await received();
await friend.waitForTimeout(2000);
check((await received()) > before + 2000, 'the friend receives the filtered audio');

await openVoiceSettings();
await owner.getByRole('group', { name: 'Noise suppression' }).getByRole('button', { name: 'Standard' }).click();
await waitSender(owner, true, 'switching to Standard during the call publishes the browser-filtered mic');
await owner.getByRole('group', { name: 'Noise suppression' }).getByRole('button', { name: 'Enhanced' }).click();
await waitSender(owner, false, 'switching to Enhanced puts RNNoise back');
await owner.getByRole('group', { name: 'Noise suppression' }).getByRole('button', { name: 'Strong' }).click();
await waitSender(owner, false, 'switching to Strong keeps the filtered mic (RNNoise + GTCRN)');
await closeSettings();

// 4. A page that cannot load the filter falls back to Standard and says so (friend's context blocks /noise/*).
await friend.getByText("Enhanced and Strong noise suppression aren't available here").waitFor({ timeout: 10000 });
check(true, 'blocked filter: toast explains the fallback');
await waitSender(friend, true, 'blocked filter: the raw (browser-filtered) mic is published, not silence');
await friend.getByRole('button', { name: 'User settings' }).click();
await friend.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Voice & audio', exact: true }).click();
await friend.getByText("Strong isn't available in this browser right now").waitFor({ timeout: 5000 });
check(true, 'settings show that Standard is used instead');
await friend.screenshot({ path: `${outDir}/noise-fallback.png` });

await browser.close();
console.log('noise suppression smoke passed');
