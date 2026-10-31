// Dev smoke: direct and group messages — open from the profile, live delivery, unread badge, group create/rename/leave.
// Usage: node scripts/smoke-dm.mjs <out-dir>   (needs API + ng serve; users tomer & friend, plus a third member for the group part)
import { chromium } from '@playwright/test';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const PASSWORD = 'correct horse battery';
const browser = await chromium.launch();

async function newPage(name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] page error:`, e.message));
  page.on('dialog', (d) => void d.accept(d.type() === 'prompt' ? 'Smoke squad' : undefined));
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
async function api(page, method, path, body) {
  return page.evaluate(async ([method, path, body]) => {
    const xsrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1] ?? '');
    const r = await fetch(`/api/v1${path}`, { method, headers: { 'content-type': 'application/json', 'X-XSRF-TOKEN': xsrf }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
  }, [method, path, body]);
}
function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}

const owner = await newPage('owner');
const friend = await newPage('friend');
await login(owner, 'tomer');
await login(friend, 'friend');
const me = (await api(owner, 'GET', '/auth/me')).body;
const fme = (await api(friend, 'GET', '/auth/me')).body;
const server = me.servers[0];
const members = (await api(owner, 'GET', `/servers/${server.id}/members`)).body;
const friendMember = members.find((m) => m.userId === fme.user.id);
const general = (await api(owner, 'GET', `/servers/${server.id}`)).body.channels.find((c) => c.name === 'general');

// Owner starts a DM from the + next to Direct messages.
await owner.goto(`${BASE}/s/${server.id}/c/${general.id}`);
await owner.locator('#composer').waitFor();
await friend.goto(`${BASE}/s/${server.id}/c/${general.id}`);
await friend.locator('#composer').waitFor();
await owner.getByRole('button', { name: 'New message' }).click();
await owner.getByRole('checkbox', { name: `${friendMember.displayName} @${friendMember.login}` }).check();
await owner.getByRole('button', { name: 'Message', exact: true }).click();
await owner.waitForURL((u) => u.toString().includes('/c/') && !u.toString().includes(general.id));
const dmUrl = owner.url();
const dmId = dmUrl.split('/c/')[1];
check(dmId !== general.id, 'New message → Message opens the conversation');
check((await owner.locator('#composer').getAttribute('placeholder')) === `Message @${friendMember.displayName}`, 'composer says "Message @friend"');
check(await owner.getByRole('link', { name: `Direct message: ${friendMember.displayName}` }).isVisible(), 'DM listed under Direct messages');

// Friend sees it appear (policy push) once the first message lands, with a red unread count.
const text = `dm smoke ${Date.now()}`;
await owner.locator('#composer').fill(text);
await owner.locator('#composer').press('Enter');
const ownerName = members.find((m) => m.userId === me.user.id).displayName;
const fLink = friend.getByRole('link', { name: `Direct message: ${ownerName}` });
await fLink.waitFor({ timeout: 8000 });
await fLink.locator('.cnt.m').waitFor({ timeout: 8000 });
check((await fLink.locator('.cnt.m').textContent()).trim() === '1', 'friend gets the DM with an unread count of 1');
await friend.screenshot({ path: `${outDir}/dm-sidebar.png`, clip: { x: 0, y: 0, width: 340, height: 360 } });
await fLink.click();
await friend.getByText(text).waitFor({ timeout: 5000 });
check(true, 'friend reads the message');
await friend.waitForFunction((n) => !document.querySelector(`a[aria-label="Direct message: ${n}"] .cnt`), ownerName, { timeout: 8000 });
check(true, 'reading clears the badge');

// Live reply both ways.
const reply = `dm reply ${Date.now()}`;
await friend.locator('#composer').fill(reply);
await friend.locator('#composer').press('Enter');
await owner.getByText(reply).waitFor({ timeout: 5000 });
check(true, 'reply arrives live');

// The owner of the server cannot read other people's DMs — covered by DmTests; here: re-opening finds the same one.
const again = (await api(friend, 'POST', `/servers/${server.id}/dms`, { userIds: [me.user.id] })).body;
check(again.id === dmId, 'opening again from the other side finds the same conversation');

// Groups need a third member.
const third = members.find((m) => m.userId !== me.user.id && m.userId !== fme.user.id);
if (!third) {
  console.log('- skipped group part: no third member in the server');
} else {
  await owner.getByRole('button', { name: 'New message' }).click();
  await owner.getByRole('checkbox', { name: `${friendMember.displayName} @${friendMember.login}` }).check();
  await owner.getByRole('checkbox', { name: `${third.displayName} @${third.login}` }).check();
  await owner.getByRole('button', { name: 'Create group' }).click();
  await owner.waitForURL((u) => u.toString() !== dmUrl && u.toString().includes('/c/'));
  const groupId = owner.url().split('/c/')[1];
  await owner.getByRole('button', { name: 'Rename group' }).click();
  await owner.locator('h1', { hasText: 'Smoke squad' }).waitFor({ timeout: 5000 });
  check(true, 'group created and renamed');
  await friend.getByRole('link', { name: 'Group: Smoke squad' }).waitFor({ timeout: 8000 });
  check(true, 'friend sees the renamed group');
  await owner.screenshot({ path: `${outDir}/dm-group.png` });
  await friend.getByRole('link', { name: 'Group: Smoke squad' }).click();
  await friend.getByRole('button', { name: 'Leave group' }).click();
  await friend.waitForURL((u) => !u.toString().includes(groupId));
  const gone = await friend.getByRole('link', { name: 'Group: Smoke squad' }).waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false);
  if (!gone) console.log('  still listed:', await friend.locator('a.ch').allTextContents(), friend.url());
  check(gone, 'friend left the group');
  const left = await api(friend, 'GET', `/channels/${groupId}/messages?limit=1`);
  check(left.status === 404, 'after leaving, the group is gone for them');
  await api(owner, 'DELETE', `/channels/${groupId}/members/me`);
}

console.log('ok');
await browser.close();
