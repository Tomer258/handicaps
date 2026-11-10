// Dev smoke for S7 settings: profile, status (presence seen by a friend), appearance synced to the account,
// mic test meter and camera preview with fake devices, invites (secret shown once, revoke) and member roles.
// Usage: node scripts/smoke-settings.mjs <out-dir>   (needs API + ng serve; users tomer & friend)
import { chromium } from '@playwright/test';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const PASSWORD = 'correct horse battery';
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

async function newPage(name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone', 'camera'] });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/40[19]|412/.test(m.text())) console.log(`[${name}] console error:`, m.text()); });
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

const owner = await newPage('owner');
const friend = await newPage('friend');
await login(owner, 'tomer');
await login(friend, 'friend');
const me = await owner.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
const serverId = me.servers[0].id;
await owner.goto(`${BASE}/s/${serverId}`);
await friend.goto(`${BASE}/s/${serverId}`);
await owner.waitForLoadState('networkidle');

const openSettings = async () => {
  await owner.getByRole('button', { name: 'User settings' }).click();
  await owner.getByRole('navigation', { name: 'Settings sections' }).waitFor();
};
const nav = (label) => owner.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: label, exact: true }).click();

// 1. Profile: rename and restore.
await openSettings();
const original = await owner.getByLabel('Display name').inputValue();
await owner.getByLabel('Display name').fill('Tomer QA');
await owner.getByRole('button', { name: 'Save', exact: true }).click();
await friend.getByText('Tomer QA').first().waitFor({ timeout: 10000 });
check(await friend.getByText('Tomer QA').first().isVisible(), 'rename reaches the friend live (memberUpdated)');
await owner.getByLabel('Display name').fill(original);
await owner.getByRole('button', { name: 'Save', exact: true }).click();
await friend.getByText('Tomer QA').first().waitFor({ state: 'detached', timeout: 10000 });
check(true, 'name restored');

// 2. Status: DND is pushed as presence.
await owner.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'DND' }).click();
await owner.waitForTimeout(800);
const settingsAfter = await owner.evaluate(async () => (await fetch('/api/v1/users/me/settings')).json());
check(settingsAfter.preferredStatus.toLowerCase() === 'donotdisturb', 'preferred status saved as Do not disturb');
await owner.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'Online' }).click();

// 3. Appearance syncs to the account (survives a fresh browser context).
await nav('Appearance');
await owner.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Light' }).click();
await owner.getByRole('radio', { name: 'Iris' }).click();
check(await owner.evaluate(() => document.documentElement.dataset['theme']) === 'light', 'light theme applied');
await owner.waitForTimeout(1200); // debounce + PATCH
const fresh = await newPage('owner-2');
await login(fresh, 'tomer');
check(await fresh.evaluate(() => document.documentElement.dataset['theme'] + '/' + document.documentElement.dataset['accent']) === 'light/iris',
  'appearance restored from the account on another browser');
await fresh.context().close();
await owner.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }).click();
await owner.getByRole('radio', { name: 'Volt' }).click();

// 4. Voice: mic test meter moves with the fake microphone.
await nav('Voice & audio');
await owner.getByRole('button', { name: "Let's check" }).click();
await owner.waitForFunction(() => Number(document.querySelector('[role=meter]')?.getAttribute('aria-valuenow')) > 5, null, { timeout: 8000 });
check(true, 'mic test shows input level');
check(await owner.getByLabel('Microphone', { exact: true }).locator('option').count() > 1, 'microphones listed');
await owner.getByRole('button', { name: 'Stop test' }).click();

// 5. Video: camera preview renders frames.
await nav('Video & streaming');
await owner.getByRole('button', { name: 'Test camera' }).click();
await owner.waitForFunction(() => (document.querySelector('video')?.videoWidth ?? 0) > 0, null, { timeout: 8000 });
check(true, 'camera preview renders');
await owner.getByRole('group', { name: 'Default stream mode' }).getByRole('button', { name: 'Sharp' }).click();
await owner.screenshot({ path: `${outDir}/settings-video.png` });
await owner.getByRole('group', { name: 'Default stream mode' }).getByRole('button', { name: 'Smooth' }).click();

// 6. Invites: link shown once, listed, revoked.
await nav('Invites');
const note = `smoke ${Date.now() % 100000}`;
await owner.getByLabel('Note (optional)').fill(note);
await owner.getByRole('button', { name: 'Create invite link' }).click();
const url = await owner.getByTestId('invite-url').textContent();
check(/\/invite\/[A-Za-z0-9_-]{20,}$/.test(url.trim()), 'invite URL shown once');
const preview = await friend.evaluate(async (secret) => {
  const xsrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1] ?? '');
  return (await fetch('/api/v1/auth/invitations/preview', { method: 'POST', headers: { 'content-type': 'application/json', 'X-XSRF-TOKEN': xsrf }, body: JSON.stringify({ secret }) })).json();
}, url.trim().split('/invite/')[1]);
check(preview.valid === true, 'invite is valid');
await owner.getByRole('button', { name: `Revoke invite ${note}` }).click();
await owner.getByRole('button', { name: `Revoke invite ${note}` }).waitFor({ state: 'detached' });
check(true, 'invite revoked');

// 7. Roles: give Friend the Moderator role and take it away.
await nav('Members');
const modBtn = owner.getByRole('button', { name: 'Moderator role for Friend' });
await modBtn.click();
await owner.getByRole('button', { name: 'Moderator role for Friend', pressed: true }).waitFor();
const members = await owner.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}/members`)).json(), serverId);
const detail = await owner.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), serverId);
const modId = detail.roles.find((r) => r.name === 'Moderator').id;
check(members.find((m) => m.login === 'friend').roleIds.includes(modId), 'Friend has the Moderator role on the server');
await modBtn.click();
await owner.getByRole('button', { name: 'Moderator role for Friend', pressed: false }).waitFor();
check(true, 'role removed again');
await owner.screenshot({ path: `${outDir}/settings-server.png` });

await owner.keyboard.press('Escape');
await owner.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached' });
check(true, 'Esc closes settings');
console.log('ok');
await browser.close();
