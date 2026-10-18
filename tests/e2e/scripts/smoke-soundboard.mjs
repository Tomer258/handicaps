// Dev smoke for S6 soundboard against real LiveKit + workers: upload with trim through the validator, catalog push,
// play through the publisher worker, the other participant receives the sfx track, cooldown, favorites, per-actor mute.
// Usage: node scripts/smoke-soundboard.mjs <out-dir>   (needs compose livekit/sound-publisher/asset-validator + API + ng serve)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const PASSWORD = 'correct horse battery';
mkdirSync(outDir, { recursive: true });

// 7 s 44.1 kHz mono tone sweep: longer than the 5 s limit, so the dialog's default trim must be applied server-side.
function wav(seconds, rate = 44100) {
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * (300 + (i / n) * 600) * i) / rate) * 12000), 44 + i * 2);
  return buf;
}
const soundFile = join(outDir, 'smoke-sweep.wav');
writeFileSync(soundFile, wav(7));
const soundName = `sweep ${Date.now() % 100000}`;

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

async function newPage(name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/40[19]|429/.test(m.text())) console.log(`[${name}] console error:`, m.text()); });
  page.on('pageerror', (e) => console.log(`[${name}] page error:`, e.message));
  return page;
}

async function login(page, login) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`);
  await page.waitForLoadState('networkidle');
}

function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}

/** Received remote audio elements (voice + soundboard) in the hidden audio host. */
const audioCount = (page) => page.evaluate(() => document.querySelectorAll('body > div[aria-hidden="true"] audio').length);

const owner = await newPage('owner');
const friend = await newPage('friend');
await login(owner, 'tomer');
await login(friend, 'friend');

const me = await owner.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
const serverId = me.servers[0].id;
const detail = await owner.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), serverId);
const lounge = detail.channels.find((c) => c.name === 'Lounge');
// Remove leftovers of earlier failed runs.
await owner.evaluate(async (id) => {
  const xsrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1] ?? '');
  const { sounds } = await (await fetch(`/api/v1/servers/${id}/sounds`)).json();
  for (const s of sounds.filter((x) => /^sweep \d+$/.test(x.name)))
    await fetch(`/api/v1/sounds/${s.id}`, { method: 'DELETE', headers: { 'X-XSRF-TOKEN': xsrf } });
}, serverId);

for (const p of [owner, friend]) {
  await p.goto(`${BASE}/s/${serverId}/v/${lounge.id}`);
  await p.getByRole('button', { name: 'Join voice' }).click();
  await p.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 15000 });
}
await owner.locator('.pcard', { hasText: 'Friend' }).waitFor({ timeout: 15000 });
await friend.locator('.pcard', { hasText: 'Tomer' }).waitFor({ timeout: 15000 });
check(true, 'both in Lounge');

// 1. Upload through the dialog: decode, default trim to 5 s, server normalization, catalog push.
await owner.getByRole('toolbar', { name: 'Voice controls' }).getByRole('button', { name: 'Soundboard' }).click();
const pop = owner.getByRole('dialog', { name: 'Soundboard' });
await pop.waitFor();
await pop.getByRole('button', { name: 'Upload sound' }).click();
const up = owner.getByRole('dialog', { name: 'Upload a sound' });
await up.getByLabel('Choose audio file').setInputFiles(soundFile);
await up.getByText('7.0s total').waitFor({ timeout: 10000 });
check(await up.getByText('5.0s selected').isVisible(), 'dialog decodes the file and defaults the trim to 5 s');
await up.getByLabel('Sound name').fill(soundName);
await up.getByRole('radio', { name: 'Icon 💥' }).click();
await up.getByRole('button', { name: /^Upload to / }).click();
await owner.locator('.toast', { hasText: `“${soundName}” added to the soundboard` }).waitFor({ timeout: 30000 });
check(true, 'validator normalized the trimmed upload and the sound became ready');

await pop.getByRole('button', { name: 'All', exact: true }).click();
const tile = pop.locator('.stile', { hasText: soundName });
await tile.waitFor();
check((await tile.textContent()).includes('5.0s'), 'tile shows the trimmed 5.0 s duration');

// Friend sees the new sound via the catalog push (no reload).
await friend.getByRole('toolbar', { name: 'Voice controls' }).getByRole('button', { name: 'Soundboard' }).click();
const fpop = friend.getByRole('dialog', { name: 'Soundboard' });
await fpop.locator('.stile', { hasText: soundName }).waitFor({ timeout: 10000 });
check(true, 'friend sees the new sound');

// 2. Play: the publisher worker joins as sb_<room>; the friend receives an extra audio track.
await tile.click();
await fpop.getByText(`played by Tomer`).waitFor({ timeout: 10000 });
check(true, 'friend sees "now playing … played by Tomer" (SignalR playback state)');
// Tomer's microphone + the sfx_<tomer> track (the worker may already be in the room from an earlier play).
await friend.waitForFunction(() => document.querySelectorAll('body > div[aria-hidden="true"] audio').length >= 2, null, { timeout: 10000 });
check(true, `friend receives the soundboard track (${await audioCount(friend)} audio elements)`);
check(await pop.getByText(/Cooldown — play again in/).isVisible(), 'owner sees the cooldown');
await owner.screenshot({ path: `${outDir}/soundboard-owner.png` });
await friend.screenshot({ path: `${outDir}/soundboard-friend.png` });
check(!(await friend.locator('.pcard', { hasText: 'Soundboard' }).count()), 'the worker is not shown as a participant');

// 3. Favorites.
await pop.getByRole('button', { name: `Add ${soundName} to favorites` }).click();
await pop.getByRole('button', { name: 'Favorites', exact: true }).click();
await pop.locator('.stile', { hasText: soundName }).waitFor();
check(true, 'favorite shows in the Favorites tab');

// 4. Per-actor soundboard mute: friend mutes Tomer's effects → that track is unsubscribed.
await fpop.getByRole('button', { name: 'Close soundboard' }).click();
await friend.locator('.pcard', { hasText: 'Tomer' }).click();
await friend.getByRole('menuitemcheckbox', { name: 'Mute their soundboard' }).click();
await friend.getByRole('menuitemcheckbox', { name: 'Mute their soundboard', checked: true }).waitFor();
await friend.waitForFunction(() => document.querySelectorAll('body > div[aria-hidden="true"] audio').length === 1, null, { timeout: 10000 });
check(true, "friend muted Tomer's soundboard (track unsubscribed)");
await friend.getByRole('menuitemcheckbox', { name: 'Mute their soundboard' }).click();
await friend.waitForFunction(() => document.querySelectorAll('body > div[aria-hidden="true"] audio').length === 2, null, { timeout: 10000 });
check(true, "unmuting resubscribes Tomer's soundboard track");
await friend.keyboard.press('Escape');

// 5. Clean up: delete the smoke sound.
const catalog = await owner.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}/sounds`)).json(), serverId);
const created = catalog.sounds.find((s) => s.name === soundName);
await pop.getByText(/Cooldown — play again in/).waitFor({ state: 'detached', timeout: 10000 });
await pop.locator('.stile', { hasText: soundName }).click({ button: 'right' });
await owner.getByRole('menuitem', { name: 'Delete sound' }).click();
await pop.locator('.stile', { hasText: soundName }).waitFor({ state: 'detached' });
check(!!created, 'owner deleted the smoke sound');

for (const p of [owner, friend]) await p.getByRole('toolbar', { name: 'Voice controls' }).getByRole('button', { name: 'Disconnect', exact: true }).click();
console.log('ok');
await browser.close();
