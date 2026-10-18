// End-to-end smoke against a deployed stack (local POC from infra/scripts/poc-local.sh, or a real host):
// owner registers from the one-time invite, invites a friend, chat is realtime, and both talk in voice through the
// edge (Caddy layer4 + forward_auth gate) with real media.
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
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
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

// 3. Voice through the gate with real media.
await owner.goto(`${BASE}/s/${serverId}/v/${voice.id}`);
await owner.getByRole('button', { name: 'Join voice' }).click();
await owner.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 20000 });
await friend.goto(`${BASE}/s/${serverId}/v/${voice.id}`);
await friend.getByRole('button', { name: 'Join voice' }).click();
await friend.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 20000 });
check(true, 'both joined voice through the admission gate');
await owner.locator('.pcard.talk', { hasText: 'Friend' }).waitFor({ timeout: 20000 });
check(true, 'owner hears friend (speaking indicator from real audio through the SFU)');

await browser.close();
console.log('poc smoke passed');
