// Dev smoke for States 04: nobody else online → the member list says who was here last and offers "Wait in <voice>".
// Usage: node scripts/smoke-quiet.mjs <out-dir>   (needs compose livekit + API + ng serve; tomer & friend, nobody else online)
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
  const general = detail.channels.find((c) => c.name === 'general');
  await owner.goto(`${BASE}/s/${serverId}/c/${general.id}`);
  const members = owner.getByRole('complementary', { name: 'Members' });

  // The friend drops by, then leaves: the card appears and names them.
  const friend = await session('friend');
  const friendName = (await friend.evaluate(async () => (await fetch('/api/v1/auth/me')).json())).user.displayName;
  await members.getByText('Online — 1').waitFor({ timeout: 15000 });
  check(await members.getByText('Quiet hangar tonight').count() === 0, 'no quiet card while a friend is online');
  await friend.context().close();
  const card = members.getByRole('status').filter({ hasText: 'Quiet hangar tonight' });
  await card.waitFor({ timeout: 15000 });
  check(await card.getByText(`${friendName} was last here just now.`).count() === 1, 'the card says who was here last');
  await owner.waitForTimeout(400); // let the fade-in finish
  await owner.screenshot({ path: `${outDir}/state-quiet.png` });

  const wait = card.getByRole('button', { name: /^Wait in / });
  const voiceName = (await wait.textContent()).trim().replace(/^Wait in /, '');
  await wait.click();
  await owner.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 20000 });
  check(owner.url().includes(`/s/${serverId}/v/`), `"Wait in ${voiceName}" opens the voice channel and joins it`);
  await card.getByText(`You're in ${voiceName}`).waitFor({ timeout: 5000 });
  check(await wait.count() === 0, 'once waiting, the card says so instead of offering the button');
  console.log('quiet smoke passed');
} finally {
  await browser.close();
}
