// Dev smoke for link previews: real public pages get a card (YouTube with a play badge, image proxied through the API),
// <wrapped> links and internal addresses do not. Needs internet access from the API.
// Usage: node scripts/smoke-link-preview.mjs <out-dir>   (needs API + ng serve; user tomer)
import { chromium } from '@playwright/test';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on('pageerror', (e) => console.log('page error:', e.message));
const external = [];
page.on('request', (r) => { if (!r.url().startsWith(BASE) && !r.url().startsWith('data:') && !/fonts\.(googleapis|gstatic)/.test(r.url())) external.push(r.url()); });

function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}
async function api(method, path, body) {
  return page.evaluate(async ([method, path, body]) => {
    const xsrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1] ?? '');
    const r = await fetch(`/api/v1${path}`, { method, headers: { 'content-type': 'application/json', 'X-XSRF-TOKEN': xsrf }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
  }, [method, path, body]);
}

await page.goto(`${BASE}/login`);
await page.getByLabel('Login').fill('tomer');
await page.getByLabel('Password').fill('correct horse battery');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL(`${BASE}/`);
const me = (await api('GET', '/auth/me')).body;
const serverId = me.servers[0].id;
const general = (await api('GET', `/servers/${serverId}`)).body.channels.find((c) => c.name === 'general');
await page.goto(`${BASE}/s/${serverId}/c/${general.id}`);
await page.locator('#composer').waitFor();

const stamp = Date.now().toString(36);
const say = (body) => api('POST', `/channels/${general.id}/messages`, { clientMessageId: crypto.randomUUID(), body });
await say(`gh ${stamp} https://github.com/livekit/livekit`);
await say(`yt ${stamp} https://www.youtube.com/watch?v=dQw4w9WgXcQ`);
await say(`quiet ${stamp} <https://github.com/livekit/livekit> and http://127.0.0.1:5080/healthz`);

const msg = (label) => page.locator('article.msg', { hasText: `${label} ${stamp}` });
const gh = msg('gh').locator('[data-testid=link-preview]');
await gh.waitFor({ timeout: 20000 });
check(/livekit/i.test(await gh.locator('.lp-title').innerText()), 'GitHub link shows a card with the repo title');
const yt = msg('yt').locator('[data-testid=link-preview]');
await yt.waitFor({ timeout: 20000 });
check(await yt.locator('.lp-play').count() === 1, 'YouTube link shows a video card with a play badge');
await yt.locator('.lp-media img').evaluate((img) => img.complete || new Promise((r) => { img.onload = r; img.onerror = r; }));
check(await yt.locator('.lp-media img').evaluate((img) => img.naturalWidth > 0 && img.getAttribute('src').startsWith('/api/v1/link-previews/image')), 'thumbnail loads through the same-origin image proxy');
await page.waitForTimeout(3000);
check(await msg('quiet').locator('[data-testid=link-preview]').count() === 0, '<wrapped> links and internal addresses get no card');
check(external.length === 0, `the browser never contacted another site (${external.slice(0, 3).join(', ')})`);
await yt.scrollIntoViewIfNeeded();
await page.waitForTimeout(1000); // async image decode
await page.screenshot({ path: `${outDir}/link-previews.png` });

console.log('ok');
await browser.close();
