// Seeds a fresh install with a small friend group and takes the README screenshots into docs/screenshots.
// Usage: node scripts/readme-shots.mjs <api-log-with-owner-invite>
//   Run against an EMPTY database (e.g. a second DB: ConnectionStrings__Hangar=...Database=hangar_demo), API on :5080,
//   ng serve on :4200, dev compose up. Needs internet for the link preview and watch-together shots.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fakeVoiceFile } from './lib/fake-voice.mjs';

const [, , logPath] = process.argv;
const OUT = fileURLToPath(new URL('../../../docs/screenshots/', import.meta.url));
fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:4200';
const PASSWORD = 'correct horse battery';
const invite = [...fs.readFileSync(logPath, 'utf8').matchAll(/http:\/\/localhost:4200\/invite\/([A-Za-z0-9_-]+)/g)].at(-1)[1];

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fakeVoiceFile()}`,
    '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required',
  ],
});
async function newPage(viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone', 'camera'], colorScheme: 'dark' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  return page;
}
async function api(page, method, path, body) {
  return page.evaluate(async ([method, path, body]) => {
    const xsrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1] ?? '');
    const r = await fetch(`/api/v1${path}`, { method, headers: { 'content-type': 'application/json', 'X-XSRF-TOKEN': xsrf }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  }, [method, path, body]);
}
async function register(page, secret, displayName, login) {
  await page.goto(`${BASE}/invite/${secret}`);
  await page.getByLabel('Display name').fill(displayName);
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(`${BASE}/`);
  await page.waitForLoadState('networkidle');
}
const shot = async (page, name) => {
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log('📸', name);
};

// People.
const tomer = await newPage();
await register(tomer, invite, 'Tomer', 'tomer');
const me = await api(tomer, 'GET', '/auth/me');
const serverId = me.servers[0].id;
const inv = await api(tomer, 'POST', `/servers/${serverId}/invitations`, { lifetimeHours: 24, maxUses: 10 });
const people = {};
for (const [name, login] of [['Maya', 'maya'], ['Noam', 'noam'], ['Dana', 'dana'], ['Itay', 'itay']]) {
  people[login] = await newPage();
  await register(people[login], inv.secret, name, login);
}
const members = await api(tomer, 'GET', `/servers/${serverId}/members`);
const id = (login) => members.find((m) => m.login === login).userId;
let detail = await api(tomer, 'GET', `/servers/${serverId}`);
const general = detail.channels.find((c) => c.name === 'general');
const lounge = detail.channels.find((c) => c.name === 'Lounge');
const say = async (page, body, replyToId) =>
  api(page, 'POST', `/channels/${general.id}/messages`, { clientMessageId: crypto.randomUUID(), body, replyToId });

// A short conversation in #general.
await say(people.maya, 'anyone up for ranked tonight? 🎮');
await say(people.noam, 'after 21:00, still finishing dinner');
const q = await say(people.dana, `I'm in. <@${id('tomer')}> are you bringing the new headset?`);
await say(tomer, 'yep, it finally arrived 🎧 surround is unreal', q.id);
const clip = await say(people.itay, 'the movie for later 👉 https://www.youtube.com/watch?v=aqz-KE-bpKQ');
await api(people.maya, 'PUT', `/messages/${clip.id}/reactions/${encodeURIComponent('🔥')}`);
await api(people.noam, 'PUT', `/messages/${clip.id}/reactions/${encodeURIComponent('🔥')}`);
await api(people.dana, 'PUT', `/messages/${clip.id}/reactions/${encodeURIComponent('🍿')}`);
await say(people.maya, 'see you in the Lounge 🫡');

// A group DM.
const group = await api(tomer, 'POST', `/servers/${serverId}/dms`, { userIds: [id('maya'), id('dana')], name: 'Squad' });
const dm = (page, body) => api(page, 'POST', `/channels/${group.id}/messages`, { clientMessageId: crypto.randomUUID(), body });
await dm(people.maya, 'secret plan: we let Noam carry tonight 😇');
await dm(people.dana, 'lol he will never know');
await dm(tomer, 'deal. I will "lag" in the first round');

// 1. Chat.
await tomer.goto(`${BASE}/s/${serverId}/c/${general.id}`);
await tomer.locator('#composer').waitFor();
await tomer.locator('.lp').first().waitFor({ timeout: 15000 }).catch(() => console.log('(no link preview — offline?)'));
await shot(tomer, 'chat');

// 2. Group DM.
await tomer.goto(`${BASE}/s/${serverId}/c/${group.id}`);
await tomer.getByText('lag').waitFor();
await shot(tomer, 'direct-messages');

// 3. Voice room: four people, one camera, one screen share.
for (const p of [tomer, people.maya, people.noam, people.dana]) {
  await p.goto(`${BASE}/s/${serverId}/v/${lounge.id}`);
  await p.getByRole('button', { name: 'Join voice' }).click();
  await p.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 20000 });
}
await people.noam.getByRole('toolbar', { name: 'Voice controls' }).getByRole('button', { name: 'Turn camera on' }).click();
await tomer.locator('.pcard', { hasText: 'Dana' }).waitFor({ timeout: 15000 });
await tomer.locator('.pcard', { hasText: 'Noam' }).locator('video').waitFor({ timeout: 20000 });
await tomer.waitForTimeout(2500);
await shot(tomer, 'voice');

// 4. Watch together in the call.
await tomer.getByRole('toolbar', { name: 'Voice controls' }).getByRole('button', { name: 'Watch together' }).click();
await tomer.getByLabel('YouTube link').fill('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
await tomer.getByRole('button', { name: 'Start', exact: true }).click();
await tomer.locator('iframe[src*="youtube-nocookie"]').waitFor({ timeout: 15000 }).catch(() => console.log('(no player)'));
await tomer.waitForTimeout(8000);
await shot(tomer, 'watch-together');
await api(tomer, 'DELETE', `/channels/${lounge.id}/watch`).catch(() => undefined);

// 5. Soundboard popover (empty catalogue on a fresh install is fine — shows the upload flow).
// 6. System page (while the call is running).
await tomer.goto(`${BASE}/s/${serverId}/c/${general.id}`);
await tomer.getByRole('button', { name: 'User settings' }).click();
const settings = tomer.getByRole('dialog', { name: 'Settings' });
await settings.getByRole('button', { name: 'System', exact: true }).click();
await settings.getByTestId('project-memory').waitFor();
await tomer.waitForTimeout(22000); // a few samples for the charts + docker stats
await shot(tomer, 'system');
await tomer.keyboard.press('Escape');

// 7. Phone.
const phone = await newPage({ width: 390, height: 844 });
await phone.goto(`${BASE}/login`);
await phone.getByLabel('Login').fill('maya');
await phone.getByLabel('Password').fill(PASSWORD);
await phone.getByRole('button', { name: 'Sign in' }).click();
await phone.waitForURL(`${BASE}/`);
await phone.goto(`${BASE}/s/${serverId}/c/${general.id}`);
await phone.locator('#composer').waitFor();
await shot(phone, 'phone');

await browser.close();
console.log('done →', OUT);
