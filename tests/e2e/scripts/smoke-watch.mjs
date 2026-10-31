// Dev smoke for watch together: owner starts a YouTube video in the call, the friend's player follows play/pause/seek,
// the player survives leaving the voice page (mini player), and stopping ends it for both. Needs internet (YouTube).
// Usage: node scripts/smoke-watch.mjs <out-dir>   (needs compose livekit + API + ng serve; users tomer & friend)
import { chromium } from '@playwright/test';
import { fakeVoiceFile } from './lib/fake-voice.mjs';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'; // Big Buck Bunny (Blender Foundation, CC BY)
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fakeVoiceFile()}`,
    '--autoplay-policy=no-user-gesture-required'],
});

function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}
async function session(login) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${login}] page error:`, e.message));
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`);
  return page;
}
/** The YouTube player's reported time, read from the iframe (frame-level evaluate works cross-origin in Playwright). */
async function playerTime(page) {
  const frame = page.frames().find((f) => f.url().startsWith('https://www.youtube-nocookie.com/embed/'));
  if (!frame) return null;
  return frame.evaluate(() => document.querySelector('video')?.currentTime ?? null).catch(() => null);
}
async function playerPaused(page) {
  const frame = page.frames().find((f) => f.url().startsWith('https://www.youtube-nocookie.com/embed/'));
  return frame?.evaluate(() => document.querySelector('video')?.paused ?? null).catch(() => null);
}
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('FAILED (timeout): ' + what);
}

const owner = await session('tomer');
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

// A leftover player from an aborted run: stop it first (needs to be in the call).
await owner.evaluate(async (ch) => {
  const xsrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1] ?? '');
  await fetch(`/api/v1/channels/${ch}/watch`, { method: 'DELETE', headers: { 'X-XSRF-TOKEN': xsrf } });
}, lounge.id);
await owner.locator('[data-testid=watch-player]').waitFor({ state: 'detached', timeout: 8000 });

// 1. Start from the dock.
await owner.getByRole('toolbar', { name: 'Voice controls' }).getByRole('button', { name: 'Watch together' }).click();
await owner.getByLabel('YouTube link').fill(VIDEO);
await owner.getByRole('button', { name: 'Start' }).click();
for (const p of [owner, friend]) await p.locator('[data-testid=watch-player] iframe').waitFor({ timeout: 10000 });
check(true, 'both see the shared player after the owner starts a video');
const t1 = await until(async () => { const t = await playerTime(friend); return t > 2 ? t : null; }, 30000, 'friend video plays');
check(t1 > 2, `friend's video is playing (${t1.toFixed(1)} s)`);
await owner.waitForTimeout(1500);
await owner.screenshot({ path: `${outDir}/watch-together.png` });

// 2. Friend pauses → owner pauses too; friend seeks → owner follows.
await friend.getByRole('button', { name: 'Pause for everyone' }).click();
await until(async () => (await playerPaused(owner)) === true, 8000, 'owner paused by friend');
check(true, 'friend pausing pauses the owner');
await friend.getByRole('slider', { name: 'Seek for everyone' }).fill('120');
await friend.getByRole('slider', { name: 'Seek for everyone' }).dispatchEvent('change');
await until(async () => { const t = await playerTime(owner); return t !== null && Math.abs(t - 120) < 2; }, 8000, 'owner seeks to 120 s');
check(true, 'friend seeking to 2:00 moves the owner there');
await owner.getByRole('button', { name: 'Play for everyone' }).click();
const resumed = await until(async () => { const t = await playerTime(friend); return t > 121 ? t : null; }, 10000, 'friend resumes after owner plays');
check(resumed > 121, 'owner pressing play resumes the friend from 2:00');

// 3. Leaving the voice page keeps playing in the corner.
const general = detail.channels.find((c) => c.name === 'general');
await owner.locator('a.ch', { hasText: 'general' }).click();
await owner.locator('#composer').waitFor();
await owner.locator('.wt.mini').waitFor({ timeout: 5000 });
const before = await playerTime(owner);
await owner.waitForTimeout(2000);
check((await playerTime(owner)) > before, 'the video keeps playing as a mini player on a text channel');
await owner.screenshot({ path: `${outDir}/watch-mini.png` });

// 4. Stop ends it for both.
await owner.getByRole('button', { name: 'Stop watching together' }).click();
for (const p of [owner, friend]) await p.locator('[data-testid=watch-player]').waitFor({ state: 'detached', timeout: 8000 });
check(true, 'stopping removes the player for everyone');

void general;
console.log('ok');
await browser.close();
