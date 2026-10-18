// Dev smoke for S7c notifications. The Notification API is stubbed (records calls) and "background" is simulated by
// making document.hasFocus() return false. Covers: mention → browser notification in background, toast when focused
// elsewhere, "none" / "all" preferences, Do not disturb, and join/leave chimes in voice (real LiveKit).
// Usage: node scripts/smoke-notifications.mjs   (needs compose livekit + API + ng serve; users tomer & friend)
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:4200';
const PASSWORD = 'correct horse battery';
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

const STUB = () => {
  window.__notes = [];
  window.__bg = false;
  window.__chimes = [];
  class FakeNotification {
    static permission = 'granted';
    static requestPermission = async () => 'granted';
    constructor(title, opts) { window.__notes.push({ title, body: opts?.body ?? '' }); }
    close() {}
  }
  window.Notification = FakeNotification;
  Document.prototype.hasFocus = function () { return !window.__bg; };
  document.addEventListener('hangar:chime', (e) => window.__chimes.push(e.detail));
};

async function newPage(name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone', 'camera'] });
  await ctx.addInitScript(STUB);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/40[19]|412|rtc\/v1/.test(m.text())) console.log(`[${name}] console error:`, m.text()); });
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
const general = detail.channels.find((c) => c.name === 'general');
const clips = detail.channels.find((c) => c.name === 'clips');
const lounge = detail.channels.find((c) => c.name === 'Lounge');
await owner.goto(`${BASE}/s/${serverId}/c/${clips.id}`);
await friend.goto(`${BASE}/s/${serverId}/c/${general.id}`);
await owner.locator('#composer').waitFor();
await friend.locator('#composer').waitFor();

const settings = async (section, group, button) => {
  await owner.getByRole('button', { name: 'User settings' }).click();
  await owner.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section, exact: true }).click();
  await owner.getByRole('group', { name: group }).getByRole('button', { name: button, exact: true }).click();
  await owner.keyboard.press('Escape');
  await owner.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached' });
};
const say = async (text) => {
  await friend.locator('#composer').fill(text);
  await friend.keyboard.press('Enter');
  await owner.locator('article.msg', { hasText: text }).count(); // owner is in another channel; just pace
  await friend.locator('article.msg', { hasText: text }).waitFor();
  await owner.waitForTimeout(1200);
};
const notes = () => owner.evaluate(() => window.__notes.splice(0));
const bg = (on) => owner.evaluate((v) => { window.__bg = v; }, on);

await settings('My account', 'Status', 'Online');
await settings('Notifications', 'Message notifications', 'Mentions');

// 1. Focused, other channel: a mention shows a toast, not a browser notification.
const t = Date.now();
await say(`@tomer focused ping ${t}`);
await owner.getByText('Friend mentioned you in #general').first().waitFor({ timeout: 5000 });
check((await notes()).length === 0, 'focused: mention shows an in-app toast, no browser notification');

// 2. Background: a mention raises a browser notification with the message text; plain messages do not (mentions mode).
await bg(true);
await say(`@tomer background ping ${t}`);
await say(`plain chatter ${t}`);
let n = await notes();
check(n.length === 1 && n[0].title === 'Friend mentioned you in #general' && n[0].body.includes(`background ping ${t}`),
  `background mention → notification "${n[0]?.title}: ${n[0]?.body}"`);

// 3. "All messages": plain messages notify too.
await bg(false);
await settings('Notifications', 'Message notifications', 'All');
await bg(true);
await say(`all mode ${t}`);
n = await notes();
check(n.length === 1 && n[0].title === 'Friend in #general' && n[0].body === `all mode ${t}`, 'all mode: plain message notifies');

// 4. "None": nothing pops up, even mentions.
await bg(false);
await settings('Notifications', 'Message notifications', 'None');
await bg(true);
await say(`@tomer none mode ${t}`);
check((await notes()).length === 0, 'none mode: no notification');

// 5. Do not disturb silences everything.
await bg(false);
await settings('Notifications', 'Message notifications', 'Mentions');
await settings('My account', 'Status', 'DND');
await bg(true);
await say(`@tomer dnd ${t}`);
check((await notes()).length === 0, 'DND: mention does not notify');
await bg(false);
await settings('My account', 'Status', 'Online');
await owner.waitForTimeout(1000); // let the settings PATCH land before reloading

// 6. Chimes: owner in Lounge; friend joins → join chime; friend leaves → leave chime.
await owner.goto(`${BASE}/s/${serverId}/v/${lounge.id}`);
await owner.getByRole('button', { name: 'Join voice' }).click();
await owner.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 15000 });
await owner.waitForTimeout(1500);
await owner.evaluate(() => window.__chimes.splice(0));
await friend.goto(`${BASE}/s/${serverId}/v/${lounge.id}`);
await friend.getByRole('button', { name: 'Join voice' }).click();
await friend.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 15000 });
await owner.waitForFunction(() => window.__chimes.includes('join'), null, { timeout: 15000 });
check(true, 'join chime when the friend enters my channel');
await friend.getByRole('toolbar', { name: 'Voice controls' }).getByRole('button', { name: 'Disconnect', exact: true }).click();
await owner.waitForFunction(() => window.__chimes.includes('leave'), null, { timeout: 15000 });
check(true, 'leave chime when the friend leaves');
await owner.getByRole('toolbar', { name: 'Voice controls' }).getByRole('button', { name: 'Disconnect', exact: true }).click();

await browser.close();
console.log('notifications smoke passed');
