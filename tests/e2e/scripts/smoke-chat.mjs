// Dev smoke for S3 chat: two browsers (owner + invited member) exercise realtime delivery, mentions,
// reactions, typing, replies, edits and unread badges against the running dev stack.
// Usage: node scripts/smoke-chat.mjs <out-dir>   (requires owner tomer / "correct horse battery")
import { chromium } from '@playwright/test';

const [, , outDir] = process.argv;
const BASE = 'http://localhost:4200';
const PASSWORD = 'correct horse battery';
const browser = await chromium.launch();

async function newPage(name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${name}] console error:`, m.text()); });
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

/** Calls the API from the page with the antiforgery header, like the app does. */
async function api(page, method, path, body) {
  return page.evaluate(async ([method, path, body]) => {
    const xsrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1] ?? '');
    const r = await fetch(`/api/v1${path}`, { method, headers: { 'content-type': 'application/json', 'X-XSRF-TOKEN': xsrf }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
  }, [method, path, body]);
}

function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}

const owner = await newPage('owner');
await login(owner, 'tomer');
const me = (await api(owner, 'GET', '/auth/me')).body;
const serverId = me.servers[0].id;
const detail = (await api(owner, 'GET', `/servers/${serverId}`)).body;
const general = detail.channels.find((c) => c.name === 'general');
const clips = detail.channels.find((c) => c.name === 'clips');

// Member: reuse "friend" if present, else register through a fresh invite.
const member = await newPage('member');
await member.goto(`${BASE}/login`);
const members = (await api(owner, 'GET', `/servers/${serverId}/members`)).body;
if (members.some((m) => m.login === 'friend')) {
  await login(member, 'friend');
} else {
  const inv = (await api(owner, 'POST', `/servers/${serverId}/invitations`, { maxUses: 1 })).body;
  await member.goto(inv.url);
  await member.getByLabel('Display name').fill('Friend');
  await member.getByLabel('Login').fill('friend');
  await member.getByLabel('Password').fill(PASSWORD);
  await member.getByRole('button', { name: 'Create account' }).click();
  await member.waitForURL(`${BASE}/`);
}

await owner.goto(`${BASE}/s/${serverId}/c/${general.id}`);
await member.goto(`${BASE}/s/${serverId}/c/${general.id}`);
await owner.locator('#composer').waitFor();
await member.locator('#composer').waitFor();
await owner.waitForTimeout(800); // let both hubs subscribe

// 1. Send with mention → member receives live, highlighted as mention.
const stamp = Date.now().toString(36);
await owner.locator('#composer').fill(`hey @friend ranked tonight? ${stamp}`);
await owner.keyboard.press('Escape'); // close mention suggestions if open
await owner.locator('#composer').press('Enter');
const live = member.locator('article.msg', { hasText: stamp });
await live.waitFor({ timeout: 5000 });
check(true, 'member received owner message in realtime');
check(await live.locator('.mention').innerText() === '@Friend', 'mention rendered with display name');
check(await live.evaluate((el) => el.classList.contains('me-mention')), 'message highlighted as mentioning me');

// 2. Typing indicator.
await member.locator('#composer').click();
await member.keyboard.type('sure', { delay: 40 });
await owner.getByText('is typing…').waitFor({ timeout: 5000 });
check(true, 'owner sees typing indicator');

// 3. Reply from member.
await live.hover();
await live.getByRole('button', { name: 'Reply' }).click();
await member.locator('#composer').fill(`count me in ${stamp}`);
await member.locator('#composer').press('Enter');
const reply = owner.locator('article.msg', { hasText: `count me in ${stamp}` });
await reply.waitFor({ timeout: 5000 });
check(await reply.locator('.replyref').count() === 1, 'reply reference shown to owner');

// 4. Reaction from member → owner sees count.
const byBody = (page, text) => page.locator('article.msg').filter({ has: page.locator('.mtext', { hasText: text }) });
const ownerMsg = byBody(owner, `ranked tonight? ${stamp}`);
const memberMsg = byBody(member, `ranked tonight? ${stamp}`);
await memberMsg.hover();
await memberMsg.getByRole('button', { name: 'Add reaction' }).first().click();
await memberMsg.getByRole('button', { name: 'React 🔥' }).click();
await ownerMsg.locator('.react', { hasText: '🔥' }).waitFor({ timeout: 5000 });
check(true, 'owner sees member reaction live');

// 5. Edit by owner → member sees "(edited)".
await ownerMsg.hover();
await ownerMsg.getByRole('button', { name: 'Edit' }).click();
await owner.getByLabel('Edit message').fill(`hey @friend ranked tonight at 9? ${stamp}`);
await owner.getByLabel('Edit message').press('Enter');
await byBody(member, `at 9? ${stamp}`).getByText('(edited)').waitFor({ timeout: 5000 });
check(true, 'member sees the edit live');

// 6. Unread badge: member moves to #clips, owner posts in #general.
await member.goto(`${BASE}/s/${serverId}/c/${clips.id}`);
await member.locator('#composer').waitFor();
await member.waitForTimeout(800);
await owner.locator('#composer').fill(`badge check ${stamp}`);
await owner.locator('#composer').press('Enter');
const badge = member.locator(`a.ch[href$="/c/${general.id}"] .cnt`);
await badge.waitFor({ timeout: 5000 });
check(Number(await badge.innerText()) >= 1, 'member sees unread badge on #general');
await member.screenshot({ path: `${outDir}/chat-member-badge.png` });
await member.locator(`a.ch[href$="/c/${general.id}"]`).click();
await member.locator('article.msg', { hasText: `badge check ${stamp}` }).waitFor();
await member.waitForTimeout(1200);
check(await badge.count() === 0, 'badge clears after reading');

// 7. Delete by owner → disappears for member.
const toDelete = owner.locator('article.msg', { hasText: `badge check ${stamp}` });
await toDelete.hover();
await toDelete.getByRole('button', { name: 'Delete' }).click({ modifiers: ['Shift'] });
await member.locator('article.msg', { hasText: `badge check ${stamp}` }).waitFor({ state: 'detached', timeout: 5000 });
check(true, 'delete propagates live');

await owner.screenshot({ path: `${outDir}/chat-owner.png` });
await member.screenshot({ path: `${outDir}/chat-member.png` });
console.log('ok');
await browser.close();
