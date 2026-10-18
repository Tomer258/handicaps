// Dev smoke for Settings → Server (Administrator): rename and icon reach a friend live (rail + sidebar header),
// join-message channel picker and the on/off switch; everything is restored at the end.
// Usage: node scripts/smoke-server.mjs <out-dir>   (needs compose asset-validator + API + ng serve; tomer & friend)
import { chromium } from '@playwright/test';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const browser = await chromium.launch();

function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}
async function session(login) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  page.on('pageerror', (e) => console.log(`[${login}] page error:`, e.message));
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`);
  return page;
}
const api = (page, method, path, body) => page.evaluate(async ([method, path, body]) => {
  const x = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '');
  const r = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': x }, body: body ? JSON.stringify(body) : undefined });
  return r.status === 204 ? null : r.json();
}, [method, path, body]);

const owner = await session('tomer');
const friend = await session('friend');
const me = await api(owner, 'GET', '/auth/me');
const serverId = me.servers[0].id;
const original = await api(owner, 'GET', `/servers/${serverId}`);
const general = original.channels.find((c) => c.name === 'general');
const clips = original.channels.find((c) => c.name === 'clips');

try {
  await friend.goto(`${BASE}/s/${serverId}/c/${general.id}`);
  await owner.goto(`${BASE}/s/${serverId}/c/${general.id}`);
  // Both live connections up (each sees the other online) before changing anything.
  await friend.getByRole('complementary', { name: 'Members' }).getByRole('button', { name: new RegExp(`^${me.user.displayName}, online`) }).waitFor({ timeout: 15000 });
  await owner.getByRole('button', { name: 'User settings' }).click();
  const settings = owner.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Server', exact: true }).click();

  // Rename → friend's rail + sidebar header follow live.
  await settings.getByLabel('Server name').fill('Smoke Hangar');
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await friend.getByRole('navigation', { name: 'Channels' }).getByText('Smoke Hangar').waitFor({ timeout: 10000 });
  await friend.locator('a.srv[aria-label="Smoke Hangar"]').waitFor({ timeout: 10000 });
  check(true, 'a rename reaches the friend live (sidebar header and server rail)');

  // Icon upload → friend's rail shows the image.
  const png = await owner.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 300;
    const g = c.getContext('2d');
    g.fillStyle = '#c6f24e'; g.fillRect(0, 0, 400, 300);
    g.fillStyle = '#111'; g.fillRect(100, 75, 200, 150);
    return c.toDataURL('image/png').split(',')[1];
  });
  await settings.getByTestId('server-icon-input').setInputFiles([{ name: 'icon.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }]);
  await owner.getByText('Server icon updated').waitFor({ timeout: 60000 });
  await friend.locator('a.srv[aria-label="Smoke Hangar"] img').waitFor({ timeout: 10000 });
  const size = await friend.locator('a.srv[aria-label="Smoke Hangar"] img').evaluate((img) => img.complete && img.naturalWidth);
  check(size === 256, `the icon shows in the friend's rail (normalized to ${size}px)`);
  await friend.screenshot({ path: `${outDir}/server-icon-rail.png` });

  // Join messages: pick #clips, then turn them off.
  await settings.getByLabel('Post them in').selectOption({ label: '# clips' });
  await owner.waitForFunction(async ([id, ch]) => (await (await fetch(`/api/v1/servers/${id}`)).json()).joinMessageChannelId === ch, [serverId, clips.id]);
  check(true, 'join messages can go to a chosen channel');
  await settings.getByRole('button', { name: 'Say when someone joins' }).click();
  await settings.getByLabel('Post them in').waitFor({ state: 'detached' });
  check((await api(owner, 'GET', `/servers/${serverId}`)).joinMessages === false, 'join messages can be turned off');
  await settings.getByRole('button', { name: 'Remove' }).click();
  await friend.locator('a.srv[aria-label="Smoke Hangar"] img').waitFor({ state: 'detached', timeout: 10000 });
  check(true, 'removing the icon brings the initials back for the friend');

  // A member without Administrator has no Server tab.
  await friend.getByRole('button', { name: 'User settings' }).click();
  const fs = friend.getByRole('dialog', { name: 'Settings' });
  await fs.getByRole('button', { name: 'My account' }).waitFor();
  check(await fs.getByRole('button', { name: 'Server', exact: true }).count() === 0, 'members without Administrator get no Server tab');
  console.log('server smoke passed');
} finally {
  await api(owner, 'PATCH', `/servers/${serverId}`, { name: original.name, joinMessages: true, clearJoinMessageChannel: true });
  if (original.iconAssetId == null) await api(owner, 'DELETE', `/servers/${serverId}/icon`);
  await browser.close();
}
