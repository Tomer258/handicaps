// Dev smoke for voice moderation (S9b): the owner server-mutes the friend from the participant card menu, the friend's
// mic is locked, the mute is lifted, then the owner disconnects the friend from voice.
// Usage: node scripts/smoke-moderation.mjs <out-dir>   (needs compose livekit + API + ng serve; users tomer & friend)
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
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone', 'camera'] })).newPage();
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
  const friend = await session('friend');
  const me = await owner.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
  const serverId = me.servers[0].id;
  const detail = await owner.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), serverId);
  const lounge = detail.channels.find((c) => c.name === 'Lounge');
  const friendName = (await friend.evaluate(async () => (await fetch('/api/v1/auth/me')).json())).user.displayName;

  for (const p of [owner, friend]) {
    await p.goto(`${BASE}/s/${serverId}/v/${lounge.id}`);
    await p.getByRole('button', { name: 'Join voice' }).click();
    await p.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 20000 });
  }

  const card = owner.locator('button.pcard', { hasText: friendName });
  await card.waitFor({ timeout: 15000 });
  await card.click();
  const menu = owner.getByRole('menu', { name: `${friendName} options` });
  await menu.getByRole('menuitemcheckbox', { name: 'Server mute' }).click();

  const mic = friend.getByRole('toolbar', { name: 'Voice controls' }).locator('button[title="Server muted by a moderator"]');
  await mic.waitFor({ timeout: 10000 });
  check(await mic.isDisabled(), 'server mute locks the friend\'s mic button');
  await owner.locator('button.pcard[aria-label*="server muted"]', { hasText: friendName }).waitFor({ timeout: 10000 });
  check(true, 'owner sees the friend as server muted');
  await owner.screenshot({ path: `${outDir}/moderation-muted.png` });

  await card.click();
  await menu.getByRole('menuitemcheckbox', { name: 'Server mute' }).click();
  await friend.getByRole('toolbar', { name: 'Voice controls' }).locator('button[title="Unmute"], button[title="Mute"]').waitFor({ timeout: 10000 });
  check(true, 'lifting the mute unlocks the mic button');

  await card.click();
  await menu.getByRole('menuitem', { name: 'Disconnect from voice' }).click();
  await friend.getByRole('button', { name: 'Join voice' }).waitFor({ timeout: 15000 });
  check(true, 'disconnect removes the friend from the call');
  await card.waitFor({ state: 'detached', timeout: 15000 });
  check(true, 'friend\'s card disappears for the owner');
} finally {
  await browser.close();
}
