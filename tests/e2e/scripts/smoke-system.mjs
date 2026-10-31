// Dev smoke: Settings → System (resource usage) for the owner; hidden and refused for a member.
// Usage: node scripts/smoke-system.mjs <out-dir>   (needs API + ng serve + dev compose; users tomer & friend)
import { chromium } from '@playwright/test';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const PASSWORD = 'correct horse battery';
const browser = await chromium.launch();

async function newPage(name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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
function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}

const owner = await newPage('owner');
const friend = await newPage('friend');
await login(owner, 'tomer');
await login(friend, 'friend');
const serverId = await owner.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).servers[0].id);

await owner.goto(`${BASE}/s/${serverId}`);
await owner.getByRole('button', { name: 'User settings' }).click();
const settings = owner.getByRole('dialog', { name: 'Settings' });
await settings.getByRole('button', { name: 'System', exact: true }).click();
await settings.getByTestId('project-memory').waitFor({ timeout: 10000 });
const memText = await settings.getByTestId('project-memory').locator('.v').textContent();
check(/\d+(\.\d)? (MB|GB)/.test(memText), `Hangar memory shown (${memText})`);
const table = settings.getByRole('table', { name: 'Usage by service' });
check(await table.locator('tr[data-service="api"]').count() === 1, 'API listed by service');
// Dev: docker stats starts once the page is watched; the containers show up on a following sample.
await table.locator('tr[data-service="postgres"]').waitFor({ timeout: 30000 });
check(true, 'dev containers (postgres) listed by service');
check(await settings.getByText('People online').isVisible(), 'live usage shown');
check(await settings.getByText('Largest tables').isVisible(), 'database tables shown');
await owner.waitForTimeout(500);
await owner.screenshot({ path: `${outDir}/system.png` });

await friend.goto(`${BASE}/s/${serverId}`);
await friend.getByRole('button', { name: 'User settings' }).click();
const fs = friend.getByRole('dialog', { name: 'Settings' });
await fs.getByRole('button', { name: 'My account' }).waitFor();
check(await fs.getByRole('button', { name: 'System', exact: true }).count() === 0, 'members get no System tab');
const status = await friend.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}/system`)).status, serverId);
check(status === 403, 'and the API refuses them');

console.log('ok');
await browser.close();
