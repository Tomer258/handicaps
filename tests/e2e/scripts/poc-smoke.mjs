// End-to-end smoke against a deployed stack (local POC from infra/scripts/poc-local.sh, or a real host):
// owner registers from the one-time invite, invites a friend, chat is realtime, and both talk in voice through the
// edge (Caddy layer4 + forward_auth gate) with real media. Also covers the production-only plumbing: an image through
// the network-less validator (uid 10001 volumes), a soundboard upload played by the publisher (uid 10002, read-only
// sounds) and a screen share.
// Usage: node scripts/poc-smoke.mjs <owner-invite-url> [base-url]   (base defaults to the invite's origin)
// Local POC certificates come from Caddy's internal CA, so TLS errors are ignored here.
import { chromium } from '@playwright/test';

const [, , inviteUrl, baseArg] = process.argv;
if (!inviteUrl) throw new Error('usage: node scripts/poc-smoke.mjs <owner-invite-url> [base-url]');
const BASE = baseArg ?? new URL(inviteUrl).origin;
const PASSWORD = 'poc smoke passphrase 2026';
const stamp = Date.now().toString(36).slice(-5);

function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen',
    '--autoplay-policy=no-user-gesture-required'],
});
async function newPage(name) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['microphone'], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] page error:`, e.message));
  return page;
}
async function register(page, url, login, name) {
  await page.goto(url);
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(`${BASE}/`);
}
const api = (page, method, path, body) => page.evaluate(async ([method, path, body]) => {
  const xsrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1] ?? '');
  const r = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, path, body]);

// 1. Owner account from the bootstrap invite; owner invites a friend.
const owner = await newPage('owner');
await register(owner, inviteUrl, `owner${stamp}`, 'Owner');
check(true, 'owner registered from the one-time invite');
const me = (await api(owner, 'GET', '/auth/me')).body;
const serverId = me.servers[0].id;
const inv = await api(owner, 'POST', `/servers/${serverId}/invitations`, { lifetimeHours: 1, maxUses: 1, note: 'poc smoke' });
check(inv.status === 200 && inv.body.url.startsWith(BASE), 'owner created an invitation link');
const friend = await newPage('friend');
await register(friend, inv.body.url, `friend${stamp}`, 'Friend');
check(true, 'friend registered from the invitation');

// 2. Realtime chat over the edge (SignalR through Caddy).
const detail = (await api(owner, 'GET', `/servers/${serverId}`)).body;
const general = detail.channels.find((c) => c.type === 'text');
const voice = detail.channels.find((c) => c.type === 'voice');
await owner.goto(`${BASE}/s/${serverId}/c/${general.id}`);
await friend.goto(`${BASE}/s/${serverId}/c/${general.id}`);
await owner.locator('#composer').waitFor();
await friend.locator('#composer').waitFor();
await owner.locator('#composer').fill(`hello from the POC ${stamp}`);
await owner.keyboard.press('Enter');
await friend.locator('article.msg', { hasText: `hello from the POC ${stamp}` }).waitFor({ timeout: 10000 });
check(true, 'friend received the message in realtime');

// 3. Image attachment: upload → validator (ffmpeg, no network) → WebP the friend can load.
const png = Buffer.from((await owner.evaluate(() => {
  const c = Object.assign(document.createElement('canvas'), { width: 800, height: 450 });
  const g = c.getContext('2d');
  g.fillStyle = '#3a7bd5'; g.fillRect(0, 0, 800, 450);
  return c.toDataURL('image/png');
})).split(',')[1], 'base64');
await owner.getByTestId('attach-input').setInputFiles([{ name: `poc-${stamp}.png`, mimeType: 'image/png', buffer: png }]);
await owner.locator('.composer .chip[data-state="ready"]').waitFor({ timeout: 30000 });
await owner.locator('#composer').fill(`picture ${stamp}`);
await owner.keyboard.press('Enter');
const pic = friend.locator('article.msg', { hasText: `picture ${stamp}` }).locator('button.att-img img');
await pic.waitFor({ timeout: 15000 });
await friend.waitForFunction((el) => el.complete && el.naturalWidth > 0, await pic.elementHandle(), { timeout: 15000 });
check(true, 'image normalized by the validator and loaded by the friend');

// 4. Voice through the gate with real media.
await owner.goto(`${BASE}/s/${serverId}/v/${voice.id}`);
await owner.getByRole('button', { name: 'Join voice' }).click();
await owner.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 20000 });
await friend.goto(`${BASE}/s/${serverId}/v/${voice.id}`);
await friend.getByRole('button', { name: 'Join voice' }).click();
await friend.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 20000 });
check(true, 'both joined voice through the admission gate');
await owner.locator('.pcard.talk', { hasText: 'Friend' }).waitFor({ timeout: 20000 });
check(true, 'owner hears friend (speaking indicator from real audio through the SFU)');

// 5. Soundboard: upload (validator trims/normalizes), play, friend receives the publisher's track.
const rate = 44100, n = rate * 2, wav = Buffer.alloc(44 + n * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24);
wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), 44 + i * 2);
const soundName = `beep ${stamp}`;
const dock = owner.getByRole('toolbar', { name: 'Voice controls' });
await dock.getByRole('button', { name: 'Soundboard' }).click();
const pop = owner.getByRole('dialog', { name: 'Soundboard' });
await pop.getByRole('button', { name: 'Upload sound' }).click();
const up = owner.getByRole('dialog', { name: 'Upload a sound' });
await up.getByLabel('Choose audio file').setInputFiles({ name: 'beep.wav', mimeType: 'audio/wav', buffer: wav });
await up.getByText('2.0s total').waitFor({ timeout: 10000 });
await up.getByLabel('Sound name').fill(soundName);
await up.getByRole('button', { name: /^Upload to / }).click();
await owner.locator('.toast', { hasText: `“${soundName}” added to the soundboard` }).waitFor({ timeout: 30000 });
check(true, 'sound uploaded and validated');
const audioEls = () => friend.evaluate(() => document.querySelectorAll('body > div[aria-hidden="true"] audio').length);
const before = await audioEls();
await pop.getByRole('button', { name: 'All', exact: true }).click();
await pop.locator('.stile', { hasText: soundName }).click();
await friend.waitForFunction((n) => document.querySelectorAll('body > div[aria-hidden="true"] audio').length > n, before, { timeout: 15000 });
check(true, 'friend receives the soundboard track from the publisher');
await owner.keyboard.press('Escape');

// 6. Screen share: reservation, publish through the SFU, friend renders frames.
await dock.getByRole('button', { name: 'Share your screen' }).click();
const golive = owner.getByRole('dialog', { name: /Go live in/ });
await golive.getByRole('radio', { name: /720p/ }).click();
await golive.getByRole('button', { name: 'Choose what to share' }).click();
await dock.getByRole('button', { name: 'Stop sharing your screen' }).waitFor({ timeout: 20000 });
await friend.getByRole('button', { name: /^Watch Owner$/ }).click({ timeout: 15000 });
await friend.waitForFunction(() => [...document.querySelectorAll('.tile.prim video')].some((v) => v.videoWidth > 0 && v.readyState >= 2), null, { timeout: 20000 });
check(true, 'friend watches the screen share (video frames through the SFU)');

await browser.close();
console.log('poc smoke passed');
