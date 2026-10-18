// Dev smoke for States 08 (going live: the presenter sees the negotiation instead of a dead button) and 09 (stream
// buffering overlay on the viewer's tile). Usage: node scripts/smoke-going-live.mjs <out-dir>
// (needs compose livekit + API + ng serve; tomer & friend)
import { chromium } from '@playwright/test';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen',
    '--autoplay-policy=no-user-gesture-required'],
});

function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}
async function session(login) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone', 'camera'] })).newPage();
  page.on('pageerror', (e) => console.log(`[${login}] page error:`, e.message));
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`);
  return page;
}

try {
  const owner = await session('tomer');
  const friend = await session('friend');
  const me = await owner.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
  const serverId = me.servers[0].id;
  const detail = await owner.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), serverId);
  const lounge = detail.channels.find((c) => c.name === 'Lounge');
  for (const p of [owner, friend]) {
    await p.goto(`${BASE}/s/${serverId}/v/${lounge.id}`);
    await p.getByRole('button', { name: 'Join voice' }).click();
    await p.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 20000 });
  }

  // 08 — slow negotiation: the presenter sees "Going live" with the quality and audience.
  await owner.route('**/api/v1/voice/*/publications/screen', async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  const dock = owner.getByRole('toolbar', { name: 'Voice controls' });
  await dock.getByRole('button', { name: 'Share your screen' }).click();
  const dialog = owner.getByRole('dialog', { name: /Go live in/ });
  await dialog.getByRole('radio', { name: /1080p/ }).click();
  await dialog.getByRole('button', { name: 'Choose what to share' }).click();
  const starting = owner.getByRole('status').filter({ hasText: 'GOING LIVE' });
  await starting.waitFor({ timeout: 10000 });
  check(await starting.getByText('Negotiating 1080p · 60 with 1 viewer…').count() === 1, 'going live names the quality and the audience');
  await owner.waitForTimeout(300); // let the fade-in finish
  await owner.screenshot({ path: `${outDir}/state-going-live.png` });
  await dock.getByRole('button', { name: 'Stop sharing your screen' }).waitFor({ timeout: 20000 });
  await starting.waitFor({ state: 'detached', timeout: 5000 });
  check(true, 'the card gives way once the stream is live');
  await owner.unroute('**/api/v1/voice/*/publications/screen');

  // 09 — the viewer's player runs dry: a buffering overlay over the stream, gone when frames resume.
  await friend.getByRole('button', { name: /^Watch Tomer$/ }).click({ timeout: 15000 });
  await friend.waitForFunction(() => [...document.querySelectorAll('.tile.prim video')].some((v) => v.videoWidth > 0 && v.readyState >= 2), null, { timeout: 20000 });
  await friend.evaluate(() => document.querySelector('.tile.prim video').dispatchEvent(new Event('waiting')));
  const buffering = friend.locator('.tile.prim').getByRole('status').filter({ hasText: 'Buffering' });
  await buffering.waitFor({ timeout: 5000 });
  check(true, 'a stalled stream shows a buffering overlay');
  await friend.screenshot({ path: `${outDir}/state-buffering.png` });
  await friend.evaluate(() => document.querySelector('.tile.prim video').dispatchEvent(new Event('playing')));
  await buffering.waitFor({ state: 'detached', timeout: 5000 });
  check(true, 'the overlay clears when playback resumes');
  const pip = friend.getByRole('button', { name: 'Pop out' });
  if (await pip.count()) {
    await pip.click();
    await friend.waitForFunction(() => document.pictureInPictureElement?.tagName === 'VIDEO', null, { timeout: 5000 });
    check(true, 'Pop out puts the stream in picture-in-picture');
    await pip.click();
    await friend.waitForFunction(() => !document.pictureInPictureElement, null, { timeout: 5000 });
  } else console.log('- picture-in-picture not available in this browser; pop-out not checked');
  await dock.getByRole('button', { name: 'Stop sharing your screen' }).click();
  console.log('going-live smoke passed');
} finally {
  await browser.close();
}
