// Dev smoke for message search (Ctrl K): free text across channels, highlight, from:/in: filters, Hebrew,
// jump to a hit in another channel and to an old hit that needs older history paged in, Escape closes.
// Usage: node scripts/smoke-search.mjs <out-dir>   (needs API + ng serve; users tomer & friend)
import { chromium } from '@playwright/test';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const browser = await chromium.launch();

function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}

async function session(login) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => console.log(`[${login}] page error:`, e.message));
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`);
  return page;
}
const api = (page, method, path, body) => page.evaluate(async ([method, path, body]) => {
  const xsrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1] ?? '');
  const r = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
}, [method, path, body]);
const say = (page, channelId, body) => api(page, 'POST', `/channels/${channelId}/messages`, { clientMessageId: crypto.randomUUID(), body });

const owner = await session('tomer');
const friend = await session('friend');
const me = (await api(owner, 'GET', '/auth/me')).body;
const serverId = me.servers[0].id;
const detail = (await api(owner, 'GET', `/servers/${serverId}`)).body;
const general = detail.channels.find((c) => c.name === 'general');
const clips = detail.channels.find((c) => c.name === 'clips');

const tag = 'srch' + Date.now().toString(36);
await say(friend, clips.id, `${tag} ranked tonight at nine?`);
await say(owner, general.id, `${tag} I'm in`);
await say(friend, general.id, `${tag} שלום לכולם`);

await owner.goto(`${BASE}/s/${serverId}/c/${general.id}`);
await owner.locator('#composer').waitFor();

// 1. Ctrl K opens the panel with focus in the input; free text finds hits in every visible channel.
await owner.keyboard.press('Control+K');
const input = owner.getByRole('dialog', { name: 'Search messages' }).getByRole('textbox', { name: 'Search messages' });
await input.waitFor();
check(await input.evaluate((el) => el === document.activeElement), 'Ctrl K opens search with focus in the input');
await input.fill(tag);
const hits = owner.locator('button.search-hit');
await owner.waitForFunction(() => document.querySelectorAll('button.search-hit').length === 3);
check(true, 'three hits across #general and #clips');
check(await hits.first().locator('mark').first().textContent() === tag, 'matched text is highlighted');
check(await owner.getByText('3 results').isVisible(), 'summary counts results');

// 2. Filters via hint chips / syntax, Hebrew text.
await input.fill(`from:friend ${tag}`);
await owner.waitForFunction(() => document.querySelectorAll('button.search-hit').length === 2);
check(await owner.getByText(/2 results from Friend/).isVisible(), 'from: filter narrows to the author');
await input.fill(`in:clips ${tag}`);
await owner.waitForFunction(() => document.querySelectorAll('button.search-hit').length === 1);
check(true, 'in: filter narrows to one channel');
await input.fill('לכולם');
await owner.waitForFunction(() => [...document.querySelectorAll('button.search-hit')].some((b) => b.textContent.includes('שלום לכולם')));
check(true, 'Hebrew search works');

// 3. Jump to a hit in another channel.
await input.fill(`${tag} ranked`);
await owner.waitForFunction(() => {
  const b = document.querySelectorAll('button.search-hit');
  return b.length === 1 && b[0].textContent.includes('ranked');
});
await hits.first().click();
await owner.waitForFunction((id) => location.pathname.endsWith(`/c/${id}`), clips.id);
const target = owner.locator('article.msg', { hasText: `${tag} ranked tonight` });
await target.waitFor();
await owner.waitForFunction(() => document.querySelector('article.msg.hl') !== null, null, { timeout: 5000 });
check(await target.evaluate((el) => el.classList.contains('hl')), 'clicking a hit opens its channel and highlights the message');
await owner.screenshot({ path: `${outDir}/search.png` });

// 4. Old hit: 120 newer messages after it → history is paged in until it is found.
const deep = (await api(owner, 'POST', `/servers/${serverId}/channels`, { name: `search-${tag}`, type: 'text' })).body;
check(!!deep?.id, 'scratch channel created');
await say(owner, deep.id, `${tag} needle in the haystack`);
for (let i = 0; i < 120; i++) await say(owner, deep.id, `filler ${i}`);
await input.fill(`${tag} needle`);
// Step 3 also left exactly one hit, so wait for the needle itself rather than the count.
await owner.waitForFunction(() => {
  const b = document.querySelectorAll('button.search-hit');
  return b.length === 1 && b[0].textContent.includes('needle');
});
await hits.first().click();
await owner.waitForFunction((id) => location.pathname.endsWith(`/c/${id}`), deep.id);
const needle = owner.locator('article.msg', { hasText: `${tag} needle in the haystack` });
await needle.waitFor({ timeout: 15000 });
await owner.waitForFunction(() => document.querySelector('article.msg.hl') !== null, null, { timeout: 15000 });
check(await needle.isVisible(), 'old hit is paged in, scrolled into view and highlighted');

// 5. Escape closes; the scratch channel is archived again.
await input.focus();
await owner.keyboard.press('Escape');
await owner.getByRole('dialog', { name: 'Search messages' }).waitFor({ state: 'detached' });
check(true, 'Escape closes search');
const del = await api(owner, 'DELETE', `/channels/${deep.id}`);
check(del.status === 204, 'scratch channel archived');

await browser.close();
console.log('search smoke passed');
