// Voice timing probe: how long joining and switching voice channels take, phase by phase, and which network path
// the media uses (host/srflx/relay, udp/tcp). Works against dev or a deployed server with any account.
// Usage: node scripts/voice-timing.mjs [baseUrl] [login] [password] [switches]
//   defaults: http://localhost:4200 tomer "correct horse battery" 4
import { chromium } from '@playwright/test';
import { fakeVoiceFile } from './lib/fake-voice.mjs';

const [, , BASE = 'http://localhost:4200', LOGIN = 'tomer', PASSWORD = 'correct horse battery', SWITCHES = '4'] = process.argv;
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fakeVoiceFile()}`,
    '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'], ignoreHTTPSErrors: true });
// Record every peer connection and timestamp the requests of a join, so the phases can be told apart.
await ctx.addInitScript(() => {
  const w = window;
  w.__pcs = [];
  w.__marks = [];
  const Orig = w.RTCPeerConnection;
  w.RTCPeerConnection = function (...a) {
    const pc = new Orig(...a);
    w.__pcs.push(pc);
    pc.addEventListener('connectionstatechange', () => w.__marks.push([`pc ${pc.connectionState}`, performance.now()]));
    return pc;
  };
  w.RTCPeerConnection.prototype = Orig.prototype;
  const OrigWs = w.WebSocket;
  w.WebSocket = function (url, p) {
    const ws = new OrigWs(url, p);
    const path = new URL(url).pathname;
    w.__marks.push([`ws open ${path}`, performance.now()]);
    ws.addEventListener('open', () => w.__marks.push([`ws connected ${path}`, performance.now()]));
    ws.addEventListener('close', (e) => w.__marks.push([`ws closed ${path} ${e.code}`, performance.now()]));
    return ws;
  };
  w.WebSocket.prototype = OrigWs.prototype;
  Object.assign(w.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  const origFetch = w.fetch;
  w.fetch = async (...a) => {
    const u = String(a[0]?.url ?? a[0]);
    const t = performance.now();
    const r = await origFetch(...a);
    if (u.includes('/voice')) w.__marks.push([`${a[1]?.method ?? 'GET'} ${u.replace(/^.*\/api\/v1/, '')} ${r.status} (${Math.round(performance.now() - t)} ms)`, performance.now()]);
    return r;
  };
  const XO = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    if (String(u).includes('/voice')) {
      const t0 = performance.now();
      this.addEventListener('loadend', () => w.__marks.push([`${m} ${String(u).replace(/^.*\/api\/v1/, '')} ${this.status} (${Math.round(performance.now() - t0)} ms)`, performance.now()]));
    }
    return XO.call(this, m, u, ...rest);
  };
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('page error:', e.message));

await page.goto(`${BASE}/login`);
await page.getByLabel('Login').fill(LOGIN);
await page.getByLabel('Password').fill(PASSWORD);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL(`${BASE}/`);
await page.waitForLoadState('networkidle');

const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
const serverId = me.servers[0].id;
const detail = await page.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), serverId);
const voice = detail.channels.filter((c) => c.type === 'voice' || c.type === 1);
if (voice.length < 2) throw new Error(`need two voice channels, found ${voice.map((c) => c.name).join(', ')}`);
console.log(`server ${BASE}, voice channels: ${voice.map((c) => c.name).join(', ')}`);

async function measure(label, act, channelId) {
  await page.evaluate(() => { window.__marks = []; window.__t0 = performance.now(); window.__pcStart = window.__pcs.length; });
  const t = Date.now();
  await act();
  await page.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 60000 });
  // Connected = the voice toolbar shows and the latest peer connection is up.
  await page.waitForFunction(() => window.__pcs.slice(window.__pcStart).some((pc) => pc.connectionState === 'connected'), null, { timeout: 60000 });
  const total = Date.now() - t;
  // What I see: my card in the room grid, and me under the new channel in the sidebar.
  const name = me.user.displayName;
  const seen = await page.evaluate(async ({ name, channelName }) => {
    const out = { grid: -1, sidebar: -1 };
    for (let i = 0; i < 300 && (out.grid < 0 || out.sidebar < 0); i++) {
      const now = Math.round(performance.now() - window.__t0);
      if (out.grid < 0 && [...document.querySelectorAll('.pcard')].some((c) => c.textContent?.includes(name))) out.grid = now;
      const ch = [...document.querySelectorAll('button.ch')].find((b) => b.textContent?.includes(channelName));
      if (out.sidebar < 0 && ch?.parentElement && [...ch.parentElement.querySelectorAll('.vp[role=group]')].some((v) => v.textContent?.includes(name))) out.sidebar = now;
      await new Promise((r) => setTimeout(r, 50));
    }
    return out;
  }, { name, channelName: label.replace(/^(join|switch to) /, '') });
  // What friends see: the server roster lists me in the new channel (they get it as a hub event at the same moment).
  const listed = await page.evaluate(async ({ serverId, userId, channelId }) => {
    for (let i = 0; i < 600; i++) {
      const list = await (await fetch(`/api/v1/servers/${serverId}/voice`)).json();
      if ((list.items ?? list).some((m) => m.userId === userId && m.channelId === channelId)) return Math.round(performance.now() - window.__t0);
      await new Promise((r) => setTimeout(r, 100));
    }
    return -1;
  }, { serverId, userId: me.user.id, channelId });
  const { marks, path } = await page.evaluate(async () => {
    const t0 = window.__t0;
    const marks = window.__marks.map(([m, at]) => `${String(Math.round(at - t0)).padStart(6)} ms  ${m}`);
    let path = '?';
    for (const pc of window.__pcs.slice(window.__pcStart).reverse()) {
      if (pc.connectionState !== 'connected') continue;
      const stats = await pc.getStats();
      for (const s of stats.values()) {
        if (s.type !== 'candidate-pair' || !s.nominated || s.state !== 'succeeded') continue;
        const l = stats.get(s.localCandidateId), r = stats.get(s.remoteCandidateId);
        path = `local ${l?.candidateType}/${l?.protocol}${l?.relayProtocol ? ` relay=${l.relayProtocol}` : ''} → remote ${r?.candidateType}/${r?.protocol} ${r?.address}:${r?.port}, rtt ${Math.round((s.currentRoundTripTime ?? 0) * 1000)} ms`;
      }
      break;
    }
    return { marks, path };
  });
  console.log(`\n== ${label}: connected ${total} ms, my card in grid ${seen.grid} ms, me in sidebar ${seen.sidebar} ms, server roster ${listed} ms  [${path}]`);
  for (const m of marks) console.log(m);
}

await page.goto(`${BASE}/s/${serverId}/v/${voice[0].id}`);
await measure(`join ${voice[0].name}`, () => page.getByRole('button', { name: 'Join voice' }).click(), voice[0].id);
for (let i = 0; i < Number(SWITCHES); i++) {
  const target = voice[(i + 1) % 2];
  await page.waitForTimeout(1500);
  await measure(`switch to ${target.name}`, () => page.locator('button.ch', { hasText: target.name }).first().click(), target.id);
}
await page.getByRole('toolbar', { name: 'Voice controls' }).getByRole('button', { name: 'Disconnect', exact: true }).click();
await browser.close();
