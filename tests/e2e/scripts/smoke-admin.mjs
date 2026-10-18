// Dev smoke for the admin panel (S9c–e): roles tab (create, rename, permission, reorder, delete), channel settings
// (rename + a deny override that hides the channel from the friend), and the audit log.
// Usage: node scripts/smoke-admin.mjs <out-dir>   (needs API + ng serve; users tomer & friend)
import { chromium } from '@playwright/test';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const browser = await chromium.launch();

function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}
async function session(login) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => console.log(`[${login}] page error:`, e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`);
  return page;
}
const api = (page, method, path, body) => page.evaluate(async ([method, path, body]) => {
  const xsrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1] ?? '');
  const r = await fetch('/api/v1' + path, { method, headers: { 'content-type': 'application/json', 'X-XSRF-TOKEN': xsrf }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
}, [method, path, body]);

try {
  const owner = await session('tomer');
  const friend = await session('friend');
  const serverId = (await api(owner, 'GET', '/auth/me')).body.servers[0].id;
  await owner.goto(`${BASE}/s/${serverId}`);
  await owner.getByRole('button', { name: 'User settings' }).click();
  const nav = (label) => owner.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: label, exact: true }).click();

  // Roles: create → rename → grant a permission → move up → delete.
  await nav('Roles');
  await owner.getByRole('button', { name: 'Create role' }).click();
  const nameInput = owner.locator('[data-role="new role"] input.inp').first();
  await nameInput.waitFor();
  const roleName = `smoke${Date.now() % 100000}`;
  await nameInput.fill(roleName);
  await nameInput.press('Enter');
  await nameInput.blur();
  const card = owner.locator(`[data-role="${roleName}"]`);
  await card.waitFor();
  check(true, 'role created and renamed');
  await card.getByRole('radio', { name: '#0090ff' }).click();
  await card.getByLabel('Mute members').check();
  await owner.waitForFunction(async ([id, name]) => {
    const d = await (await fetch(`/api/v1/servers/${id}`)).json();
    const r = d.roles.find((x) => x.name === name);
    return r && r.color === '#0090ff' && (r.permissions & (1 << 15)) !== 0;
  }, [serverId, roleName]);
  check(true, 'color and permission saved');
  const before = (await api(owner, 'GET', `/servers/${serverId}`)).body.roles;
  const mine = before.find((r) => r.name === roleName);
  const below = before.filter((r) => !r.isDefault && r.position < mine.position).sort((a, b) => b.position - a.position)[0];
  if (below) {
    await owner.getByRole('button', { name: `Move ${roleName} down` }).click();
    await owner.waitForFunction(async ([id, name, pos]) => {
      const d = await (await fetch(`/api/v1/servers/${id}`)).json();
      return d.roles.find((x) => x.name === name).position < pos;
    }, [serverId, roleName, mine.position]);
    check(true, 'role moved down one place');
  }
  await owner.screenshot({ path: `${outDir}/admin-roles.png` });
  await card.getByRole('button', { name: 'Delete role' }).click();
  await card.waitFor({ state: 'detached' });
  check(true, 'role deleted');

  // Audit log shows what just happened.
  await nav('Audit log');
  await owner.getByText(`created the role`).first().waitFor();
  await owner.getByText(`deleted the role ${roleName}`).waitFor();
  check(true, 'audit log lists role create/delete');
  await owner.screenshot({ path: `${outDir}/admin-audit.png` });
  await owner.keyboard.press('Escape');

  // Channel settings: a temp channel, renamed, then hidden from @everyone.
  const ch = (await api(owner, 'POST', `/servers/${serverId}/channels`, { type: 'text', name: `adm${Date.now() % 100000}` })).body;
  await owner.goto(`${BASE}/s/${serverId}/c/${ch.id}`);
  await owner.getByRole('button', { name: 'Channel settings' }).click();
  await owner.getByLabel('Name').fill(`${ch.name}-x`);
  await owner.getByRole('button', { name: 'Save changes' }).click();
  await owner.locator('a.ch', { hasText: `${ch.name}-x` }).waitFor();
  check(true, 'channel renamed from channel settings');

  await owner.getByRole('button', { name: 'Channel settings' }).click();
  await owner.getByRole('tab', { name: 'Permissions' }).click();
  await owner.getByRole('radiogroup', { name: 'View channels' }).getByRole('radio', { name: 'Deny' }).click();
  await owner.getByRole('radiogroup', { name: 'View channels' }).getByRole('radio', { name: 'Deny', checked: true }).waitFor();
  await owner.screenshot({ path: `${outDir}/admin-channel-perms.png` });
  const visible = async () => (await api(friend, 'GET', `/servers/${serverId}`)).body.channels.some((c) => c.id === ch.id);
  check(!(await visible()), '@everyone deny hides the channel from the friend');
  await owner.getByRole('radiogroup', { name: 'View channels' }).getByRole('radio', { name: 'Default' }).click();
  await owner.getByRole('radiogroup', { name: 'View channels' }).getByRole('radio', { name: 'Default', checked: true }).waitFor();
  check(await visible(), 'back to default shows it again');
  await owner.getByRole('tab', { name: 'Overview' }).click();
  await owner.getByRole('button', { name: 'Delete channel' }).click();
  await owner.locator('a.ch', { hasText: `${ch.name}-x` }).waitFor({ state: 'detached' });
  check(true, 'channel deleted from channel settings');
} finally {
  await browser.close();
}
