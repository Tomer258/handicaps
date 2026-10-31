// Dev smoke: unread pip + mention count on the server icon in the rail, also while on Home.
// Usage: node scripts/smoke-rail-badge.mjs <out-dir>   (needs API + ng serve; users tomer & friend)
import { chromium } from '@playwright/test';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const PASSWORD = 'correct horse battery';
const browser = await chromium.launch();

async function newPage(name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
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
const server = me.servers[0];
const detail = (await api(owner, 'GET', `/servers/${server.id}`)).body;
const general = detail.channels.find((c) => c.name === 'general');
const say = (body) => api(friend, 'POST', `/channels/${general.id}/messages`, { clientMessageId: crypto.randomUUID(), body });

// Start clean: owner reads general, then goes Home.
await owner.goto(`${BASE}/s/${server.id}/c/${general.id}`);
await owner.locator('#composer').waitFor();
await owner.waitForTimeout(1500);
const icon = owner.locator('.rail a.srv[role=listitem]').first();
await owner.locator('.rail a[aria-label=Home]').click();
await owner.waitForURL(`${BASE}/`);

// A plain message → unread pip (refreshed when the tab regains focus / on the minute poll; force via visibilitychange).
await say(`rail badge plain ${Date.now()}`);
await owner.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await owner.waitForFunction(() => document.querySelector('.rail a.srv[role=listitem]')?.classList.contains('unread'), null, { timeout: 5000 });
check((await icon.getAttribute('aria-label')).endsWith('unread messages'), 'rail shows unread for a new message while on Home');

// A mention → count badge, pushed live through the notification signal.
const fid = me.user.id;
await say(`hey <@${fid}> rail badge ${Date.now()}`);
await icon.locator('.badge', { hasText: '1' }).waitFor({ timeout: 5000 });
check(/1 mention$/.test(await icon.getAttribute('aria-label')), 'mention shows a count badge on the server icon');
await owner.screenshot({ path: `${outDir}/rail-badge.png`, clip: { x: 0, y: 0, width: 300, height: 200 } });

// Inside the server the badge follows the live channel badges; reading general clears it.
await icon.click();
await owner.locator('a.ch', { hasText: 'general' }).click();
await owner.locator('#composer').waitFor();
await owner.waitForFunction(() => !document.querySelector('.rail a.srv[role=listitem]')?.classList.contains('unread'), null, { timeout: 8000 });
check((await icon.locator('.badge').count()) === 0, 'reading the channel clears the rail badge');

console.log('ok');
await browser.close();
