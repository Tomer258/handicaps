// Dev smoke for States 02: alone in voice → "Ping online friends" → the friend gets a toast with a one-tap "Join".
// Usage: node scripts/smoke-ping.mjs <out-dir>   (needs compose livekit + API + ng serve; tomer & friend)
// The cooldown is two minutes per person per channel and lives in the API process: restart the API to rerun sooner.
import { chromium } from '@playwright/test';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}
async function session(login) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone'] })).newPage();
  page.on('pageerror', (e) => console.log(`[${login}] page error:`, e.message));
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`);
  return page;
}

try {
  const owner = await session('tomer');
  const me = await owner.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
  const serverId = me.servers[0].id;
  const detail = await owner.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), serverId);
  const lounge = detail.channels.find((c) => c.name === 'Lounge');
  const friend = await session('friend'); // online, not in voice

  await owner.goto(`${BASE}/s/${serverId}/v/${lounge.id}`);
  await owner.getByRole('button', { name: 'Join voice' }).click();
  await owner.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 20000 });
  await owner.getByRole('button', { name: 'Ping online friends' }).waitFor({ timeout: 10000 }); // shown once presence says the friend is online
  await owner.screenshot({ path: `${outDir}/state-alone.png` });
  await owner.getByRole('button', { name: 'Ping online friends' }).click();
  await owner.getByText(/^Pinged \d+ online friends?/).waitFor({ timeout: 10000 });
  check(true, 'pinging confirms how many friends were notified');

  const join = friend.getByRole('button', { name: 'Join', exact: true });
  await join.waitFor({ timeout: 10000 });
  check(await friend.getByText(/is in Lounge — come hang out/).count() === 1, 'the friend gets a toast naming the channel');
  await friend.screenshot({ path: `${outDir}/state-pinged.png` });
  await join.click();
  await friend.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 20000 });
  check(friend.url().endsWith(`/s/${serverId}/v/${lounge.id}`), '"Join" opens the channel and connects to voice');
  await owner.getByText('It is just you in here').waitFor({ state: 'detached', timeout: 15000 });
  check(true, 'the empty-room prompt goes away once the friend arrives');
  console.log('ping smoke passed');
} finally {
  await browser.close();
}
