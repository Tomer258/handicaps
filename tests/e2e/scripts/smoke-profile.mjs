// Dev smoke for the UserProfilePopover (Handoff hx-profile-popover): friend → Mention / Mute / Sounds, self → status
// picker, friend in my voice → volume; Esc returns focus to the trigger.
// Usage: node scripts/smoke-profile.mjs <out-dir>   (needs compose livekit + API + ng serve; tomer & friend)
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
  const friend = await session('friend');
  const me = await owner.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
  const serverId = me.servers[0].id;
  const detail = await owner.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), serverId);
  const general = detail.channels.find((c) => c.name === 'general');
  const lounge = detail.channels.find((c) => c.name === 'Lounge');
  const friendMe = (await friend.evaluate(async () => (await fetch('/api/v1/auth/me')).json())).user;
  await owner.goto(`${BASE}/s/${serverId}/c/${general.id}`);
  const members = owner.getByRole('complementary', { name: 'Members' });

  // Friend's profile from the member list.
  const row = members.getByRole('button', { name: new RegExp(`^${friendMe.displayName}, online`) });
  await row.click({ timeout: 15000 });
  const pop = owner.getByRole('dialog', { name: `${friendMe.displayName} profile` });
  await pop.waitFor({ timeout: 5000 });
  check(await pop.getByText(`@${friendMe.login} · Online`).count() === 1, 'profile shows handle and presence');
  await owner.waitForTimeout(250);
  await owner.screenshot({ path: `${outDir}/profile-friend.png` });
  await owner.keyboard.press('Escape');
  await pop.waitFor({ state: 'detached' });
  check(await row.evaluate((el) => el === document.activeElement), 'Esc closes it and focus returns to the member row');

  await row.click();
  await pop.getByRole('button', { name: 'Mention' }).click();
  await pop.waitFor({ state: 'detached' });
  const composer = owner.locator('#composer');
  await owner.waitForFunction((login) => document.getElementById('composer')?.value === `@${login} `, friendMe.login, { timeout: 5000 });
  check(await composer.evaluate((el) => el === document.activeElement), '"Mention" puts @login in the composer and focuses it');
  await composer.fill('');

  // My own profile: status picker.
  const selfRow = members.getByRole('button', { name: new RegExp(`^${me.user.displayName}, `) });
  await selfRow.click();
  const selfPop = owner.getByRole('dialog', { name: `${me.user.displayName} profile` });
  await selfPop.getByRole('button', { name: 'Idle' }).click();
  await selfPop.getByText(`@${me.user.login} · Idle`).waitFor({ timeout: 5000 });
  await friend.goto(`${BASE}/s/${serverId}/c/${general.id}`);
  await friend.getByRole('complementary', { name: 'Members' }).getByRole('button', { name: new RegExp(`^${me.user.displayName}, idle`) }).waitFor({ timeout: 10000 });
  check(true, 'setting Idle from my profile reaches friends');
  await owner.screenshot({ path: `${outDir}/profile-self.png` });
  await selfPop.getByRole('button', { name: 'Online' }).click();
  await owner.keyboard.press('Escape');

  // In voice together: Profile from the card menu has the volume slider.
  for (const p of [owner, friend]) {
    await p.goto(`${BASE}/s/${serverId}/v/${lounge.id}`);
    await p.getByRole('button', { name: 'Join voice' }).click();
    await p.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 20000 });
  }
  const card = owner.locator('button.pcard', { hasText: friendMe.displayName });
  await card.click({ button: 'right', timeout: 15000 });
  await owner.getByRole('menuitem', { name: 'Profile' }).click();
  await pop.getByRole('slider', { name: `${friendMe.displayName} volume` }).waitFor({ timeout: 5000 });
  check(true, 'a friend in my voice channel gets a volume slider');
  await pop.getByRole('button', { name: 'Mute', exact: true }).click();
  await pop.getByRole('button', { name: 'Unmute', exact: true }).waitFor();
  check(await pop.getByText('0%').count() === 1, 'Mute sets their voice to 0% for me');
  await pop.getByRole('button', { name: 'Unmute', exact: true }).click();
  await pop.getByText('100%').waitFor();
  check(true, 'Unmute restores the previous volume');
  console.log('profile smoke passed');
} finally {
  await browser.close();
}
