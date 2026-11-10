// Dev smoke for the sidebar voice panel's call actions (prototype: camera · share · soundboard · voice settings above
// the user row). They must work from a text channel, not only from the voice view.
// Usage: node scripts/smoke-voice-panel.mjs <out-dir>   (needs compose livekit + API + ng serve; users tomer & friend)
import { chromium } from '@playwright/test';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen',
    '--autoplay-policy=no-user-gesture-required'],
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

const owner = await session('tomer');
const friend = await session('friend');
const me = await owner.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
const serverId = me.servers[0].id;
const detail = await owner.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), serverId);
const lounge = detail.channels.find((c) => c.name === 'Lounge');
const general = detail.channels.find((c) => c.name === 'general');

for (const p of [owner, friend]) {
  await p.goto(`${BASE}/s/${serverId}/v/${lounge.id}`);
  await p.getByRole('button', { name: 'Join voice' }).click();
  await p.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 20000 });
}

// Dock is a toolbar: arrows and Home/End move focus between its buttons.
const ownerDock = owner.getByRole('toolbar', { name: 'Voice controls' });
const dockButtons = ownerDock.locator('button:not([disabled])');
await dockButtons.first().focus();
await owner.keyboard.press('ArrowRight');
check(await dockButtons.nth(1).evaluate((el) => el === document.activeElement), 'ArrowRight moves to the next dock button');
await owner.keyboard.press('End');
check(await dockButtons.last().evaluate((el) => el === document.activeElement), 'End jumps to the last dock button');
await owner.keyboard.press('ArrowRight');
check(await dockButtons.first().evaluate((el) => el === document.activeElement), 'arrows wrap around');
check(/^Voice connected/.test(await owner.getByRole('img', { name: /^Voice connected/ }).getAttribute('title')), 'signal bars name the connection quality');

// The owner leaves the voice view for a text channel (in-app navigation; a reload would end the call).
await owner.locator('a.ch', { hasText: 'general' }).click();
await owner.waitForFunction((id) => location.pathname.endsWith(`/c/${id}`), general.id);
await owner.locator('#composer').waitFor();
const panel = owner.getByRole('group', { name: 'Call actions' });
await panel.waitFor();
check(await panel.getByRole('button').count() === 4, 'voice panel shows four call actions above the user row');

// Soundboard opens over the text channel and closes with Escape.
await panel.getByRole('button', { name: 'Soundboard' }).click();
const pop = owner.getByRole('dialog', { name: 'Soundboard' });
await pop.waitFor();
check(await panel.getByRole('button', { name: 'Soundboard' }).getAttribute('aria-pressed') === 'true', 'soundboard opens from the panel on a text page');
await owner.screenshot({ path: `${outDir}/voice-panel-soundboard.png` });
await owner.keyboard.press('Escape');
await pop.waitFor({ state: 'detached' });
check(true, 'Escape closes the soundboard');

// Screen share from the panel: Go-live dialog → live → the friend can watch → stop from the panel.
await panel.getByRole('button', { name: 'Share your screen' }).click();
const golive = owner.getByRole('dialog', { name: /Go live in/ });
await golive.getByRole('button', { name: 'Limit to 720p' }).click();
await golive.getByRole('button', { name: 'Choose what to share' }).click();
await panel.getByRole('button', { name: 'Stop sharing your screen' }).waitFor({ timeout: 20000 });
check(true, 'screen share started from the panel on a text page');
await friend.getByRole('button', { name: /^Watch Tomer$/ }).click({ timeout: 15000 });
await friend.waitForFunction(() => [...document.querySelectorAll('.tile.prim video')].some((v) => v.videoWidth > 0), null, { timeout: 20000 });
check(true, 'friend watches the stream');
await panel.getByRole('button', { name: 'Stop sharing your screen' }).click();
await panel.getByRole('button', { name: 'Share your screen' }).waitFor({ timeout: 10000 });
check(true, 'stop sharing from the panel');

// Camera toggle and voice settings.
await panel.getByRole('button', { name: 'Turn camera on' }).click();
await panel.getByRole('button', { name: 'Turn camera off' }).waitFor({ timeout: 15000 });
check(true, 'camera turns on from the panel');
await panel.getByRole('button', { name: 'Turn camera off' }).click();
await panel.getByRole('button', { name: 'Turn camera on' }).waitFor({ timeout: 10000 });
await panel.getByRole('button', { name: 'Voice settings' }).click();
await owner.getByRole('dialog', { name: 'Settings' }).getByText('Voice & audio').first().waitFor();
check(true, 'voice settings opens the Voice & audio section');
await owner.keyboard.press('Escape');

// Leaving closes everything; the panel disappears.
await owner.getByRole('button', { name: 'Disconnect from voice' }).click();
await panel.waitFor({ state: 'detached' });
check(true, 'panel disappears after disconnecting');

await browser.close();
console.log('voice panel smoke passed');
