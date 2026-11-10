// Dev smoke for S5 against real LiveKit: camera + screen share with publication reservations, explicit video
// subscription on the viewer side, live banner, stream view, roster flags, stop sharing.
// Usage: node scripts/smoke-stream.mjs <out-dir>   (needs compose livekit + API + ng serve; users tomer & friend)
import { chromium } from '@playwright/test';

const [, , outDir] = process.argv;
const BASE = 'http://localhost:4200';
const PASSWORD = 'correct horse battery';
const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--auto-select-desktop-capture-source=Entire screen',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

async function newPage(name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone', 'camera'] });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('401') && !m.text().includes('404')) console.log(`[${name}] console error:`, m.text()); });
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

/** Waits until a <video> inside the locator renders real frames. */
async function waitForFrames(locator, timeout = 20000) {
  await locator.locator('video').first().waitFor({ timeout });
  await locator.page().waitForFunction(
    (el) => [...el.querySelectorAll('video')].some((v) => v.videoWidth > 0 && v.readyState >= 2),
    await locator.elementHandle(),
    { timeout },
  );
}

async function roster(page, serverId) {
  return page.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}/voice`)).json(), serverId);
}

const owner = await newPage('owner');
const friend = await newPage('friend');
await login(owner, 'tomer');
await login(friend, 'friend');

const me = await owner.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
const serverId = me.servers[0].id;
const detail = await owner.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), serverId);
const lounge = detail.channels.find((c) => c.name === 'Lounge');

// 1. Both join Lounge.
for (const p of [owner, friend]) {
  await p.goto(`${BASE}/s/${serverId}/v/${lounge.id}`);
  await p.getByRole('button', { name: 'Join voice' }).click();
  await p.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 15000 });
}
await owner.locator('.pcard', { hasText: 'Friend' }).waitFor({ timeout: 10000 });
check(true, 'both connected');

// 2. Camera: reservation → granted source → publish; friend receives video in the participant card.
const ownerDock = owner.getByRole('toolbar', { name: 'Voice controls' });
await ownerDock.getByRole('button', { name: 'Turn camera on' }).click();
await ownerDock.getByRole('button', { name: 'Turn camera off' }).waitFor({ timeout: 15000 });
check(true, 'owner camera published');
await waitForFrames(friend.locator('.pcard', { hasText: 'Tomer' }));
check(true, 'friend renders owner camera frames (explicit subscription)');

// 3. Screen share through the Go live dialog.
await ownerDock.getByRole('button', { name: 'Share your screen' }).click();
const dialog = owner.getByRole('dialog', { name: /Go live in/ });
await dialog.waitFor();
await dialog.getByRole('radio', { name: /Sharp/ }).click();
await dialog.getByRole('radio', { name: /Smooth/ }).click();
await dialog.getByRole('button', { name: 'Limit to 720p' }).click();
await dialog.getByTestId('share-plan').getByText(/720p · \d+/).waitFor({ timeout: 5000 });
check(true, `the dialog says what this PC will send: ${(await dialog.getByTestId('share-plan').innerText()).replace(/\s+/g, ' ')}`);
await dialog.getByRole('button', { name: 'Choose what to share' }).click();
await ownerDock.getByRole('button', { name: 'Stop sharing your screen' }).waitFor({ timeout: 20000 });
check(true, 'owner is live (screen reservation granted and published)');

// 4. Roster flags propagate (webhook / reconciler).
await owner.waitForFunction(async (id) => {
  const r = await (await fetch(`/api/v1/servers/${id}/voice`)).json();
  return JSON.stringify(r).includes('"screen":true') || JSON.stringify(r).includes('"screenSharing":true') || JSON.stringify(r).includes('"streaming":true');
}, serverId, { timeout: 15000, polling: 500 }).catch(async () => console.log('roster:', JSON.stringify(await roster(owner, serverId))));
const r1 = JSON.stringify(await roster(owner, serverId));
check(/"(screen|screenSharing|streaming)":true/.test(r1) && /"camera(On)?":true/.test(r1), 'server roster shows camera + screen flags');

// 5. Friend sees the live banner, watches the stream.
await friend.getByText(/live right now/).waitFor({ timeout: 10000 });
check(true, 'friend sees live banner');
await friend.getByRole('button', { name: /^Watch Tomer$/ }).click();
const stage = friend.locator('.tile.prim').first();
await waitForFrames(stage);
check(true, 'friend renders owner screen share frames in stream view');
const statsTag = stage.getByTestId('stream-stats');
await statsTag.waitFor({ timeout: 8000 });
await friend.waitForFunction(() => / [1-9]\d* fps$/.test(document.querySelector('[data-testid=stream-stats]')?.textContent?.trim() ?? ''), null, { timeout: 8000 });
const statsText = (await statsTag.textContent()).trim();
check(/^\d+p · \d+ fps$/.test(statsText), `viewer sees the stream's resolution and fps quietly in the corner (${statsText}; ${await statsTag.getAttribute('title')})`);

// Click the badge: live network numbers from WebRTC getStats, for the viewer (received) and the streamer (sent).
await statsTag.click();
const panel = stage.getByTestId('stream-stats-panel');
await friend.waitForFunction(() => /Bitrate\s*[1-9][\d.]* (k|M)bps/.test(document.querySelector('[data-testid=stream-stats-panel]')?.textContent ?? ''), null, { timeout: 8000 });
const viewerPanel = (await panel.innerText()).replace(/\s+/g, ' ');
check(/Packet loss/.test(viewerPanel) && /Ping/.test(viewerPanel) && /Dropped/.test(viewerPanel), `viewer's stats panel is live: ${viewerPanel}`);
check(/Transport\s*(UDP|TCP|Relay)/.test(viewerPanel), 'viewer sees how the media travels (transport row)');
const t0 = Date.now();
await friend.waitForFunction(() => (document.querySelector('.tile.prim video')?.videoHeight ?? 0) > 360, null, { timeout: 30000 });
check(true, `the watched tile receives the main layer, not the thumbnail (${await stage.locator('video').evaluate((v) => v.videoHeight)}p after ${Date.now() - t0} ms)`);
const ownStage = owner.locator('.tile.prim').first();
await ownStage.getByTestId('stream-stats').click({ timeout: 8000 });
await owner.waitForFunction(() => /Sending\s*\d+p[\s\S]*Bitrate\s*[1-9]/.test(document.querySelector('[data-testid=stream-stats-panel]')?.textContent ?? ''), null, { timeout: 8000 });
const ownPanel = (await ownStage.getByTestId('stream-stats-panel').innerText()).replace(/\s+/g, ' ');
check(/Limited by/.test(ownPanel), `streamer's panel shows what is sent and what limits it: ${ownPanel}`);
check(/Encoder\s*(Hardware|Software|\w)/.test(ownPanel) && /Transport/.test(ownPanel), 'streamer sees the encoder in use and the transport');
await friend.screenshot({ path: `${outDir}/stream-friend.png` });
await owner.screenshot({ path: `${outDir}/stream-owner.png` });
await friend.getByRole('button', { name: 'Close stream stats' }).click();
await panel.waitFor({ state: 'detached', timeout: 3000 });
check(true, 'the stats panel closes');

// 6. Stop sharing → viewer falls back to the voice grid, flag clears.
await ownerDock.getByRole('button', { name: 'Stop sharing your screen' }).click();
await friend.getByRole('button', { name: 'Back to voice' }).waitFor({ state: 'detached', timeout: 15000 });
check(true, 'viewer returns to the voice grid when the stream ends');
await owner.waitForFunction(async (id) => !/"(screen|screenSharing|streaming)":true/.test(JSON.stringify(await (await fetch(`/api/v1/servers/${id}/voice`)).json())),
  serverId, { timeout: 15000, polling: 500 });
check(true, 'screen flag cleared on the server');

// 7. Camera off + leave.
await ownerDock.getByRole('button', { name: 'Turn camera off' }).click();
await ownerDock.getByRole('button', { name: 'Turn camera on' }).waitFor({ timeout: 10000 });
await ownerDock.getByRole('button', { name: 'Disconnect' }).click();
await friend.locator('.pcard', { hasText: 'Tomer' }).waitFor({ state: 'detached', timeout: 15000 });
check(true, 'camera off and leave work');

await browser.close();
console.log('stream smoke OK');
