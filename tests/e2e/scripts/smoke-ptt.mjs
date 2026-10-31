// Dev smoke for push to talk and manual input sensitivity (public/audio/mic-gate.js via MicProcessor):
// the friend only sees/hears the owner while the key is held, a new key can be recorded in settings,
// and a manual sensitivity line keeps quiet sound out.
// Usage: node scripts/smoke-ptt.mjs <out-dir>   (needs compose livekit + API + ng serve; users tomer & friend)
import { chromium } from '@playwright/test';
import { fakeVoiceFile } from './lib/fake-voice.mjs';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fakeVoiceFile()}`,
    '--autoplay-policy=no-user-gesture-required'],
});

function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}
async function session(login, prefs) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
  if (prefs) await ctx.addInitScript((p) => localStorage.setItem('hangar.mediaPrefs', JSON.stringify(p)), prefs);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${login}] page error:`, e.message));
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`);
  return page;
}
/** True if `who`'s card shows the speaking ring at least once within `ms`. */
async function talksWithin(page, who, ms) {
  try {
    await page.locator('.pcard.talk', { hasText: who }).waitFor({ timeout: ms });
    return true;
  } catch {
    return false;
  }
}
/** No speaking ring for `ms`, after letting the SFU's speaker updates (about a second behind) settle. */
async function quietFor(page, who, ms) {
  await page.waitForTimeout(2500);
  return !(await talksWithin(page, who, ms));
}

const owner = await session('tomer', { inputMode: 'ptt', pttKey: 'Backquote', pttReleaseMs: 200, noiseMode: 'enhanced' });
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
await friend.locator('.pcard', { hasText: 'Tomer' }).waitFor({ timeout: 10000 });
check(await talksWithin(owner, 'Friend', 15000), 'friend (voice activity) is heard as usual');

// 1. Push to talk: silent until the key is held.
check(await quietFor(friend, 'Tomer', 4000), 'push to talk: nothing is sent while the key is up');
await owner.locator('body').click({ position: { x: 700, y: 400 } }).catch(() => undefined);
await owner.keyboard.down('Backquote');
check(await talksWithin(friend, 'Tomer', 8000), 'holding ` sends the voice');
await owner.keyboard.up('Backquote');
check(await quietFor(friend, 'Tomer', 4000), 'releasing the key stops sending');

// 2. Record a new key in settings (the recording key press is not push to talk).
await owner.getByRole('button', { name: 'User settings' }).click();
await owner.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Voice & audio', exact: true }).click();
await owner.getByRole('button', { name: 'Change key' }).click();
await owner.keyboard.press('KeyV');
await owner.getByLabel('Current key').filter({ hasText: /^V$/ }).waitFor({ timeout: 3000 });
check(JSON.parse(await owner.evaluate(() => localStorage.getItem('hangar.mediaPrefs'))).pttKey === 'KeyV', 'settings record V as the new push-to-talk key');
await owner.screenshot({ path: `${outDir}/ptt-settings.png` });
await owner.keyboard.down('KeyV');
check(await talksWithin(friend, 'Tomer', 8000), 'holding V sends the voice');
await owner.keyboard.up('KeyV');
check(await quietFor(friend, 'Tomer', 4000), 'releasing V stops sending');

// 3. Voice activity with a manual line: at 0 dB nothing passes, at -60 dB the voice passes.
await owner.getByRole('group', { name: 'Input mode' }).getByRole('button', { name: 'Voice activity' }).click();
await owner.getByRole('button', { name: 'Automatic input sensitivity' }).click();
await owner.getByRole('slider', { name: 'Input sensitivity' }).fill('0');
check(await quietFor(friend, 'Tomer', 5000), 'sensitivity at 0 dB keeps the voice out');
await owner.getByRole('button', { name: "Let's check" }).click();
await owner.waitForTimeout(1500);
await owner.screenshot({ path: `${outDir}/sensitivity-settings.png` });
await owner.getByRole('button', { name: 'Stop test' }).click();
await owner.getByRole('slider', { name: 'Input sensitivity' }).fill('-60');
check(await talksWithin(friend, 'Tomer', 10000), 'sensitivity at -60 dB lets the voice through');

// 4. Back to automatic: open mic, the old behaviour.
await owner.getByRole('button', { name: 'Automatic input sensitivity' }).click();
check(await talksWithin(friend, 'Tomer', 10000), 'automatic sensitivity sends again');

console.log('ok');
await browser.close();
