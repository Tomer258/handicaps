// Screen share quality probe: the owner shares an animated tab (moving content, like a game) at 1080p60 and the
// friend watches it in the stream view. Prints, every 2 s, what the sender encodes per simulcast layer (resolution,
// fps, encoder, what limits it) and what the viewer receives (resolution, fps).
// Usage: node scripts/stream-stats.mjs [seconds]   (needs compose livekit + API + ng serve; users tomer & friend)
import { chromium } from '@playwright/test';

const [, , SECONDS = '16'] = process.argv;
const BASE = 'http://localhost:4200';
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-tab-capture-source-by-title=HangarAnim',
    '--autoplay-policy=no-user-gesture-required'],
});
const keepPcs = () => {
  const Native = window.RTCPeerConnection;
  window.__pcs = [];
  window.RTCPeerConnection = class extends Native {
    constructor(...a) {
      super(...a);
      window.__pcs.push(this);
    }
  };
};
async function session(login) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone', 'camera'] });
  await ctx.addInitScript(keepPcs);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`);
  return page;
}

const owner = await session('tomer');
// The tab to share: full-window moving gradient + spinning boxes at the display rate.
const anim = await owner.context().newPage();
await anim.setContent(`<title>HangarAnim</title><body style="margin:0;overflow:hidden"><canvas id=c></canvas><script>
  const c = document.getElementById('c'), x = c.getContext('2d');
  c.width = innerWidth; c.height = innerHeight;
  (function f(t) {
    x.fillStyle = 'hsl(' + (t / 10 % 360) + ',70%,40%)'; x.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < 40; i++) { x.fillStyle = 'hsl(' + (i * 9) + ',90%,60%)';
      x.fillRect((Math.sin(t / 300 + i) * .45 + .5) * c.width, (Math.cos(t / 400 + i * 2) * .45 + .5) * c.height, 60, 60); }
    requestAnimationFrame(f);
  })(0);
</script>`);
await owner.bringToFront();
const friend = await session('friend');
const me = await owner.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
const serverId = me.servers[0].id;
const detail = await owner.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), serverId);
const lounge = detail.channels.find((c) => c.name === 'Lounge');
for (const p of [owner, friend]) {
  await p.goto(`${BASE}/s/${serverId}/v/${lounge.id}`);
  await p.getByRole('button', { name: 'Join voice' }).click();
  await p.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 15000 });
}
const dock = owner.getByRole('toolbar', { name: 'Voice controls' });
await dock.getByRole('button', { name: 'Share your screen' }).click();
const dialog = owner.getByRole('dialog', { name: /Go live in/ });
await dialog.getByRole('radio', { name: /1080p/ }).click();
await dialog.getByRole('button', { name: 'Choose what to share' }).click();
await dock.getByRole('button', { name: 'Stop sharing your screen' }).waitFor({ timeout: 20000 });
await friend.getByRole('button', { name: /^Watch Tomer$/ }).click({ timeout: 15000 });

const sent = () => owner.evaluate(async () => {
  const out = [];
  for (const pc of window.__pcs) {
    if (pc.connectionState !== 'connected') continue;
    for (const s of (await pc.getStats()).values()) {
      if (s.type === 'media-source' && s.kind === 'video') out.push(`source ${s.width}x${s.height}@${Math.round(s.framesPerSecond ?? 0)}`);
      if (s.type === 'outbound-rtp' && s.kind === 'video')
        out.push(`${s.rid ?? '-'}:${s.frameWidth ?? 0}x${s.frameHeight ?? 0}@${Math.round(s.framesPerSecond ?? 0)} limit=${s.qualityLimitationReason} ${Math.round((s.targetBitrate ?? 0) / 1000)}kbps`);
    }
  }
  return out.join(' | ');
});
const got = () => friend.evaluate(async () => {
  const out = [];
  for (const pc of window.__pcs) {
    if (pc.connectionState !== 'connected') continue;
    for (const s of (await pc.getStats()).values())
      if (s.type === 'inbound-rtp' && s.kind === 'video' && (s.framesPerSecond ?? 0) > 0)
        out.push(`${s.frameWidth}x${s.frameHeight}@${Math.round(s.framesPerSecond)} ${s.decoderImplementation ?? ''}`);
  }
  return out.join(' | ');
});
for (let i = 0; i < Number(SECONDS) / 2; i++) {
  await owner.waitForTimeout(2000);
  console.log(`t=${(i + 1) * 2}s sent [${await sent()}]  received [${await got()}]`);
}
await dock.getByRole('button', { name: 'Stop sharing your screen' }).click();
await browser.close();
