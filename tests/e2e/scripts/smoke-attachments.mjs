// Dev smoke for S7b attachments + avatars against the real asset-validator: image upload via the picker (re-encoded to
// WebP), text file via paste-free picker, drag & drop, send with attachments, friend sees inline image + file card,
// image viewer, rejected types, avatar upload shown to the friend, avatar removal.
// Usage: node scripts/smoke-attachments.mjs <out-dir>   (needs compose asset-validator + API + ng serve; users tomer & friend)
import { chromium } from '@playwright/test';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const PASSWORD = 'correct horse battery';
const browser = await chromium.launch();

async function newPage(name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/40[149]|422/.test(m.text())) console.log(`[${name}] console error:`, m.text()); });
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

/** A real PNG drawn on a canvas (the validator decodes it with ffmpeg). */
async function makePng(page, w, h, color) {
  const url = await page.evaluate(([w, h, color]) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = color; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff'; g.fillRect(w / 4, h / 4, w / 2, h / 2);
    return c.toDataURL('image/png');
  }, [w, h, color]);
  return Buffer.from(url.split(',')[1], 'base64');
}

const owner = await newPage('owner');
const friend = await newPage('friend');
await login(owner, 'tomer');
await login(friend, 'friend');
const me = await owner.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
const serverId = me.servers[0].id;
const detail = await owner.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), serverId);
const general = detail.channels.find((c) => c.name === 'general');
await owner.goto(`${BASE}/s/${serverId}/c/${general.id}`);
await friend.goto(`${BASE}/s/${serverId}/c/${general.id}`);
await owner.locator('#composer').waitFor();
await friend.locator('#composer').waitFor();

// 1. Picker: one image + one text file; the image goes through the validator.
const png = await makePng(owner, 1600, 900, '#3a7bd5');
const stamp = Date.now();
await owner.getByTestId('attach-input').setInputFiles([
  { name: `shot-${stamp}.png`, mimeType: 'image/png', buffer: png },
  { name: `notes-${stamp}.txt`, mimeType: 'text/plain', buffer: Buffer.from('hello from the smoke ✓\nline 2\n') },
]);
const chips = owner.locator('.composer .chip');
await chips.nth(1).waitFor();
check(await chips.count() === 2, 'two attachment chips shown');
await owner.locator('.composer .chip[data-state="ready"]').nth(1).waitFor({ timeout: 30000 });
check(await owner.locator('.composer .chip').first().textContent().then((t) => t.includes(`shot-${stamp}.webp`)), 'image chip shows the normalized .webp name once ready');

// 2. Rejected type is refused client-side.
await owner.getByTestId('attach-input').setInputFiles([{ name: 'evil.html', mimeType: 'text/html', buffer: Buffer.from('<script>1</script>') }]);
await owner.getByText('only images and plain text files can be shared').waitFor();
check(await chips.count() === 2, 'html file refused before upload');

// 3. Send with a caption.
await owner.locator('#composer').fill(`attachments ${stamp}`);
await owner.keyboard.press('Enter');
const row = friend.locator('article.msg', { hasText: `attachments ${stamp}` });
await row.waitFor({ timeout: 10000 });
const img = row.locator('button.att-img img');
await img.waitFor();
await friend.waitForFunction((sel) => { const i = document.querySelector(sel); return i && i.complete && i.naturalWidth > 0; }, `#${await row.getAttribute('id')} button.att-img img`);
const nat = await img.evaluate((i) => [i.naturalWidth, i.naturalHeight]);
check(nat[0] === 1600 && nat[1] === 900, `friend loads the inline image (${nat.join('×')})`);
check(await row.locator('.att-file').textContent().then((t) => t.includes(`notes-${stamp}.txt`)), 'friend sees the text file card');
const dl = await row.locator('.att-file a').getAttribute('href');
const head = await friend.evaluate(async (u) => { const r = await fetch(u); return [r.status, r.headers.get('content-disposition'), r.headers.get('x-content-type-options')]; }, dl);
check(head[0] === 200 && head[1].startsWith('attachment') && head[2] === 'nosniff', 'text download is attachment + nosniff');
check(await owner.locator('.composer .chip').count() === 0, 'composer tray cleared after send');

// 4. Image viewer.
await row.locator('button.att-img').click();
await friend.getByTestId('viewer-image').waitFor();
check(await friend.getByRole('dialog').textContent().then((t) => t.includes('shared by')), 'image viewer opens with "shared by"');
await friend.screenshot({ path: `${outDir}/attach-viewer.png` });
await friend.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
await friend.getByTestId('viewer-image').waitFor({ state: 'detached' });
check(true, 'viewer closes');

// 5. Drag & drop an image onto the channel.
const dropPng = await makePng(owner, 300, 300, '#d53a7b');
const dt = await owner.evaluateHandle((b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const d = new DataTransfer();
  d.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
  return d;
}, dropPng.toString('base64'));
const target = owner.locator('hx-message-list');
await target.dispatchEvent('dragenter', { dataTransfer: dt });
await owner.getByTestId('drop-zone').waitFor();
check(true, 'drop zone appears while dragging files');
await target.dispatchEvent('drop', { dataTransfer: dt });
await owner.locator('.composer .chip[data-state="ready"]').waitFor({ timeout: 30000 });
check(await owner.getByTestId('drop-zone').count() === 0, 'dropped image uploaded and drop zone hidden');
await owner.keyboard.press('Enter'); // attachment-only message (composer focused after drop)
await owner.locator('.composer .chip').waitFor({ state: 'detached', timeout: 10000 });
await friend.locator('article.msg button.att-img[aria-label="Open image dropped.webp"]').last().waitFor({ timeout: 10000 });
check(true, 'attachment-only message delivered');
await owner.screenshot({ path: `${outDir}/attach-channel.png` });

// 6. Avatar: upload → visible to the friend (member list + message gutter), then remove.
await owner.getByRole('button', { name: 'User settings' }).click();
await owner.getByRole('navigation', { name: 'Settings sections' }).waitFor();
await owner.getByTestId('avatar-input').setInputFiles([{ name: 'me.png', mimeType: 'image/png', buffer: await makePng(owner, 800, 500, '#e8a33d') }]);
await owner.getByTestId('account-avatar').locator('img').waitFor({ timeout: 30000 });
const avatarId = (await owner.evaluate(async () => (await fetch('/api/v1/auth/me')).json())).user.avatarAssetId;
check(!!avatarId, 'avatar asset set on the profile');
const avatarImg = friend.locator(`img[src="/api/v1/avatars/${avatarId}"]`).first();
await avatarImg.waitFor({ timeout: 10000 });
const avSize = await avatarImg.evaluate(async (i) => { await i.decode(); return [i.naturalWidth, i.naturalHeight]; });
check(avSize[0] === 256 && avSize[1] === 256, `friend sees the new avatar, center-cropped to ${avSize.join('×')}`);
await owner.getByRole('button', { name: 'Remove', exact: true }).click();
await owner.getByTestId('account-avatar').locator('img').waitFor({ state: 'detached' });
await friend.locator(`img[src="/api/v1/avatars/${avatarId}"]`).first().waitFor({ state: 'detached', timeout: 10000 });
check(true, 'avatar removal reaches the friend');

await browser.close();
console.log('attachments smoke passed');
