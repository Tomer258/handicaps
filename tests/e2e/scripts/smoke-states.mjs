// Dev smoke for UX states (docs/design/States.dc.html): 06 loading skeleton, 13 no camera found, 18 no soundboard
// permission. Usage: node scripts/smoke-states.mjs <out-dir>   (needs compose livekit + API + ng serve; tomer & friend)
import { chromium } from '@playwright/test';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const PLAY_SOUNDBOARD = 1 << 10;

function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}
async function session(login, init) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone', 'camera'] });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${login}] page error:`, e.message));
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`);
  return page;
}
const api = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const xsrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1] ?? '');
  const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json', 'X-XSRF-TOKEN': xsrf }, body: b ? JSON.stringify(b) : undefined });
  return r.status;
}, [method, url, body]);

const owner = await session('tomer');
const me = await owner.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
const serverId = me.servers[0].id;
const detail = await owner.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), serverId);
const lounge = detail.channels.find((c) => c.name === 'Lounge');
const general = detail.channels.find((c) => c.name === 'general');
// The friend's camera "is unplugged": every video request fails like Chrome does without a device.
const friend = await session('friend', () => {
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (c) => (c && c.video ? Promise.reject(new DOMException('Requested device not found', 'NotFoundError')) : orig(c));
});
const friendId = (await friend.evaluate(async () => (await fetch('/api/v1/auth/me')).json())).user.id;
let overrideSet = false;

try {
  // 06 — history is slow: skeleton rows instead of a spinner.
  await owner.route(`**/api/v1/channels/${general.id}/messages?**`, async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  await owner.goto(`${BASE}/s/${serverId}/c/${general.id}`);
  const loading = owner.getByRole('status', { name: 'Loading messages' });
  await loading.waitFor({ timeout: 5000 });
  check(await loading.locator('.sk').count() >= 8, 'loading history shows skeleton rows');
  await owner.screenshot({ path: `${outDir}/state-loading.png` });
  await loading.waitFor({ state: 'detached', timeout: 15000 });
  check(true, 'skeleton gives way to the messages');
  await owner.unroute(`**/api/v1/channels/${general.id}/messages?**`);

  // 18 — no Play soundboard in this channel for the friend.
  check(await api(owner, 'PUT', `/api/v1/channels/${lounge.id}/overrides`, { memberUserId: friendId, allow: 0, deny: PLAY_SOUNDBOARD }) < 300, 'owner denies Play soundboard to friend in Lounge');
  overrideSet = true;
  await friend.goto(`${BASE}/s/${serverId}/v/${lounge.id}`);
  await friend.getByRole('button', { name: 'Join voice' }).click();
  const bar = friend.getByRole('toolbar', { name: 'Voice controls' });
  await bar.waitFor({ timeout: 20000 });
  await bar.getByRole('button', { name: 'Soundboard' }).click();
  const pop = friend.getByRole('dialog', { name: 'Soundboard' });
  await pop.getByText("You can't play sounds in this channel").waitFor({ timeout: 10000 });
  check(true, 'soundboard explains the missing permission and who can grant it');
  const tiles = pop.locator('.stile');
  check((await tiles.count()) === 0 || (await tiles.first().isDisabled()), 'sound tiles cannot be played');
  await friend.waitForTimeout(400); // let the fade-in finish
  await friend.screenshot({ path: `${outDir}/state-soundboard-locked.png` });
  await pop.getByRole('button', { name: 'Close soundboard' }).click();

  // 13 — no camera.
  await bar.getByRole('button', { name: 'Turn camera on' }).click();
  const cam = friend.getByRole('alertdialog', { name: 'No camera found' });
  await cam.waitFor({ timeout: 10000 });
  check(true, 'turning the camera on without one explains what to do');
  await friend.waitForTimeout(400); // let the fade-in finish
  await friend.screenshot({ path: `${outDir}/state-no-camera.png` });
  await cam.getByRole('button', { name: 'Open video settings' }).click();
  await friend.getByRole('navigation', { name: 'Settings sections' }).waitFor();
  await friend.screenshot({ path: `${outDir}/state-video-settings.png` });
  await friend.getByRole('heading', { name: 'Video & streaming' }).waitFor({ timeout: 5000 });
  check(true, '"Open video settings" lands on the video section');
  console.log('states smoke passed');
} finally {
  if (overrideSet) await api(owner, 'PUT', `/api/v1/channels/${lounge.id}/overrides`, { memberUserId: friendId, allow: 0, deny: 0 }).catch(() => {}); // 0/0 removes it
  await browser.close();
}
