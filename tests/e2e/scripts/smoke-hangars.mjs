// Dev smoke for several hangars: only the install owner sees "Create a hangar"; a new hangar shows only for its members;
// an existing account joins from an invite link (Join, not "already in"); Leave hangar removes it from the rail.
// Usage: node scripts/smoke-hangars.mjs [shotsDir]   (needs API + ng serve; owner tomer, member friend; deletes its hangar
// from the dev database afterwards through the compose postgres container)
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const NAME = `Smoke Hangar ${Date.now().toString(36)}`;
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

const rail = (p) => p.getByRole('navigation', { name: 'Servers' });

try {
  const owner = await session('tomer');
  const friend = await session('friend');

  check(await rail(friend).getByRole('button', { name: 'Create a hangar' }).count() === 0, 'a member has no "Create a hangar" button');

  await rail(owner).getByRole('button', { name: 'Create a hangar' }).click();
  const dialog = owner.getByRole('dialog', { name: 'Create a hangar' });
  await dialog.getByLabel('Name').fill(NAME);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await owner.waitForURL(/\/s\/[0-9a-f-]+/);
  const serverId = owner.url().match(/\/s\/([0-9a-f-]+)/)[1];
  await rail(owner).getByRole('listitem', { name: NAME }).waitFor();
  const sidebar = owner.getByRole('navigation', { name: 'Channels' });
  await sidebar.getByText('general').first().waitFor();
  check(await sidebar.getByText('Lounge').count() > 0, 'the owner creates a hangar from the rail and lands in it (general, Lounge…)');
  await owner.getByText('Nobody has posted here yet').waitFor({ timeout: 8000 });
  check(true, "its empty #general loads (blank-page state, not a spinner)");
  await owner.screenshot({ path: `${outDir}/hangars-created.png` });

  await friend.reload();
  await rail(friend).getByRole('listitem').first().waitFor();
  check(await rail(friend).getByRole('listitem', { name: NAME }).count() === 0, 'the new hangar is invisible to people not invited');

  const secret = await owner.evaluate(async (id) => {
    const csrf = document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1] ?? '';
    const r = await fetch(`/api/v1/servers/${id}/invitations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(csrf) }, body: JSON.stringify({ maxUses: 2 }),
    });
    return (await r.json()).secret;
  }, serverId);

  await friend.goto(`${BASE}/invite/${secret}`);
  const join = friend.getByTestId('invite-join');
  await join.waitFor();
  check((await join.textContent()).includes(NAME), 'a signed-in member opening the link gets "Join <hangar>", not "already in"');
  await join.getByRole('button', { name: `Join ${NAME}` }).click();
  await friend.waitForURL(new RegExp(`/s/${serverId}`));
  await rail(friend).getByRole('listitem', { name: NAME }).waitFor();
  check(await rail(friend).getByRole('listitem').count() >= 2, 'joining lands in the new hangar; both hangars are on the rail');
  await owner.getByRole('complementary').getByText('Friend').first().waitFor({ timeout: 8000 }).catch(() => undefined);

  await friend.goto(`${BASE}/invite/${secret}`);
  await friend.getByTestId('invite-signed-in').waitFor();
  check(true, 'opening the link again says "already in"');

  check(await owner.getByRole('button', { name: 'Leave hangar' }).count() === 0, 'the owner has no Leave button in their own hangar');
  await friend.goto(`${BASE}/s/${serverId}`);
  friend.once('dialog', (d) => d.accept());
  await friend.getByRole('navigation', { name: 'Channels' }).getByRole('button', { name: 'Leave hangar' }).click();
  await friend.waitForURL(`${BASE}/`);
  await friend.waitForFunction((n) => ![...document.querySelectorAll('nav[aria-label=Servers] [role=listitem]')].some((e) => e.getAttribute('aria-label')?.startsWith(n)), NAME);
  check(true, 'Leave hangar takes it off the rail');
  console.log('hangars smoke OK');
} finally {
  await browser.close();
  try {
    execFileSync('docker', ['exec', 'hangar-dev-postgres-1', 'psql', '-U', 'hangar', '-d', 'hangar', '-c', `DELETE FROM servers WHERE name = '${NAME}'`], { stdio: 'pipe' });
  } catch (e) {
    console.log('cleanup failed:', String(e.stderr ?? e).trim());
  }
}
