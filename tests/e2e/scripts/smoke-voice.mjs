// Dev smoke for S4 voice against real LiveKit: two browsers with Chromium's fake microphone join the same room,
// see each other, get speaking indicators, mute state, roster updates, switching and leave.
// Usage: node scripts/smoke-voice.mjs <out-dir>   (needs compose livekit + API + ng serve; users tomer & friend)
import { chromium } from '@playwright/test';
import { fakeVoiceFile } from './lib/fake-voice.mjs';

const [, , outDir] = process.argv;
const BASE = 'http://localhost:4200';
const PASSWORD = 'correct horse battery';
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fakeVoiceFile()}`,
    '--autoplay-policy=no-user-gesture-required'],
});

async function newPage(name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('401')) console.log(`[${name}] console error:`, m.text()); });
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
const detail = await owner.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), serverId);
const lounge = detail.channels.find((c) => c.name === 'Lounge');
const ranked = detail.channels.find((c) => c.name === 'Ranked Grind');
const general = detail.channels.find((c) => c.name === 'general');

// 1. Owner joins from the voice page.
await owner.goto(`${BASE}/s/${serverId}/v/${lounge.id}`);
await owner.getByRole('button', { name: 'Join voice' }).click();
await owner.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 15000 });
check(true, 'owner connected to LiveKit room');

// 2. Friend sees owner in the sidebar roster (server-confirmed), then joins by clicking the channel.
await friend.goto(`${BASE}/s/${serverId}/c/${general.id}`);
await friend.locator('.vp[role=group]', { hasText: 'Tomer' }).waitFor({ timeout: 20000 });
check(true, 'friend sees owner in Lounge roster before joining');
await friend.locator('button.ch', { hasText: 'Lounge' }).click();
await friend.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 15000 });
await owner.locator('.pcard', { hasText: 'Friend' }).waitFor({ timeout: 10000 });
await friend.locator('.pcard', { hasText: 'Tomer' }).waitFor({ timeout: 10000 });
check(true, 'both participants see each other in the grid');

// 3. Fake mic produces a tone → speaking ring on the other side.
await owner.locator('.pcard.talk', { hasText: 'Friend' }).waitFor({ timeout: 15000 });
check(true, 'owner sees friend speaking (fake microphone audio flows through the SFU)');
await owner.screenshot({ path: `${outDir}/voice-owner.png` });

// 3b. Right-click a person in the sidebar voice list → menu with their volume (like Discord), applied to the call.
await owner.locator('.vp[role=group]', { hasText: 'Friend' }).click({ button: 'right' });
const userMenu = owner.getByRole('menu', { name: 'Friend options' });
await userMenu.waitFor();
await userMenu.getByRole('slider', { name: 'Friend volume' }).fill('150');
const volTag = (pct) => owner.locator('.pcard', { hasText: 'Friend' }).locator('.tag.mono', { hasText: new RegExp(`^\s*${pct}%\s*$`) }).waitFor({ timeout: 5000 });
await volTag(150);
check(true, 'right-click menu in the sidebar sets Friend to 150%');
await userMenu.getByRole('menuitemcheckbox', { name: 'Mute for me' }).click();
await volTag(0);
check(true, '"Mute for me" silences Friend');
await userMenu.getByRole('menuitemcheckbox', { name: 'Mute for me' }).click();
await volTag(150);
check(true, 'unmuting restores the 150% volume');
await owner.keyboard.press('Escape');
await userMenu.waitFor({ state: 'detached' });
// Same menu from the member list.
await owner.locator('[role=listitem] button', { hasText: '@friend' }).click({ button: 'right' });
await userMenu.waitFor();
check((await userMenu.getByRole('slider', { name: 'Friend volume' }).inputValue()) === '150', 'member list right-click opens the same menu');
await owner.waitForTimeout(400); // let the fade-in finish
await owner.screenshot({ path: `${outDir}/voice-user-menu.png` });
await userMenu.getByRole('slider', { name: 'Friend volume' }).fill('100');
await owner.keyboard.press('Escape');

// 4. Mute → other side sees muted badge and no speaking ring.
const dock = friend.getByRole('toolbar', { name: 'Voice controls' });
await dock.getByRole('button', { name: 'Mute', exact: true }).click();
await owner.locator('.pcard', { hasText: 'Friend' }).getByRole('img', { name: 'Muted' }).waitFor({ timeout: 10000 });
check(true, 'owner sees friend muted');
await dock.getByRole('button', { name: 'Deafen', exact: true }).click();
await owner.locator('.pcard', { hasText: 'Friend' }).getByRole('img', { name: 'Deafened' }).waitFor({ timeout: 10000 });
check(true, 'owner sees friend deafened (via SignalR voice state)');

// 5. Text navigation keeps the call.
await friend.goto(`${BASE}/s/${serverId}/c/${general.id}`).catch(() => undefined);
// goto reloads the SPA (ends voice); use in-app navigation instead to prove the session survives routing.
await friend.goto(`${BASE}/s/${serverId}/v/${lounge.id}`);
await friend.getByRole('button', { name: 'Join voice' }).click();
await friend.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 15000 });
await friend.locator('a.ch', { hasText: 'general' }).click();
await friend.locator('#composer').waitFor();
check(await friend.getByRole('region', { name: 'Voice connection' }).isVisible(), 'voice panel persists while reading a text channel');

// 6. Switch channels: owner moves to Ranked Grind; friend sees roster update.
await owner.locator('button.ch', { hasText: 'Ranked Grind' }).click();
await owner.waitForURL(new RegExp(`/v/${ranked.id}`));
await owner.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 15000 });
await friend.locator('button.ch', { hasText: 'Ranked Grind' }).locator('xpath=..').locator('.vp[role=group]', { hasText: 'Tomer' }).waitFor({ timeout: 20000 });
check(true, 'switching channels moves owner in the roster');

// 7. Leave → removed from roster.
await owner.getByRole('toolbar', { name: 'Voice controls' }).getByRole('button', { name: 'Disconnect', exact: true }).click();
await friend.locator('.vp[role=group]', { hasText: 'Tomer' }).waitFor({ state: 'detached', timeout: 20000 });
check(true, 'leave removes owner from roster');
await friend.screenshot({ path: `${outDir}/voice-friend.png` });

await friend.getByRole('button', { name: 'Disconnect from voice' }).click();
console.log('ok');
await browser.close();
