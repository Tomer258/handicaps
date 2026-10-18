// Dev smoke for S7d: breakpoints (members aside / overlay / drawer with rail), global shortcuts (Ctrl+Shift+M/D),
// mobile voice pill and bottom-sheet soundboard, and no horizontal overflow at 390 px.
// Usage: node scripts/smoke-responsive.mjs <out-dir>   (needs compose livekit + API + ng serve; user tomer)
import { chromium } from '@playwright/test';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone', 'camera'] });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error' && !/40[149]|rtc\/v1/.test(m.text())) console.log('console error:', m.text()); });
page.on('pageerror', (e) => console.log('page error:', e.message));

function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}
const visible = (sel) => page.locator(sel).first().isVisible();
const settle = () => page.waitForTimeout(350);

await page.goto(`${BASE}/login`);
await page.getByLabel('Login').fill('tomer');
await page.getByLabel('Password').fill('correct horse battery');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL(`${BASE}/`);
const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
const serverId = me.servers[0].id;
const detail = await page.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), serverId);
const general = detail.channels.find((c) => c.name === 'general');
const lounge = detail.channels.find((c) => c.name === 'Lounge');
await page.goto(`${BASE}/s/${serverId}/c/${general.id}`);
await page.locator('#composer').waitFor();

// 1. lg: members aside in the layout.
check(await visible('hx-member-list.members:not(.overlay)'), '1440: member list docked');

// 2. md: hidden by default, toggle overlays, Esc closes.
await page.setViewportSize({ width: 1200, height: 800 });
await settle();
check(await page.locator('hx-member-list').count() === 0, '1200: member list hidden by default');
await page.getByRole('button', { name: 'Toggle member list' }).click();
await settle();
check(await visible('hx-member-list.members.overlay'), '1200: toggle shows it as an overlay');
await page.keyboard.press('Escape');
await settle();
check(await page.locator('hx-member-list').count() === 0, 'Esc closes the member overlay');

// 3. Shortcuts work outside voice too (state carried into the next join) and while typing.
await page.locator('#composer').click();
const panelMute = page.locator('hx-user-panel').getByRole('button', { name: /^(Mute|Unmute)$/ });
const before = await panelMute.getAttribute('aria-pressed');
await page.keyboard.press('Control+Shift+M');
await settle();
check(await panelMute.getAttribute('aria-pressed') !== before, 'Ctrl+Shift+M toggles mute (focus in composer)');
await page.keyboard.press('Control+Shift+M');
await settle();
const deafen = page.locator('hx-user-panel').getByRole('button', { name: /^(Deafen|Undeafen)$/ });
await page.keyboard.press('Control+Shift+D');
await settle();
check(await deafen.getAttribute('aria-pressed') === 'true', 'Ctrl+Shift+D deafens');
await page.keyboard.press('Control+Shift+D');
await settle();
check(await deafen.getAttribute('aria-pressed') === 'false' && (await panelMute.getAttribute('aria-pressed')) === before, 'Ctrl+Shift+D again restores');

// 4. xs: drawer with the server rail.
await page.setViewportSize({ width: 390, height: 844 });
await settle();
check(!(await visible('nav.rail')), '390: rail hidden');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check(overflow <= 0, `390: no horizontal overflow (${overflow})`);
await page.getByRole('button', { name: 'Open channels' }).click();
await settle();
check(await visible('nav.rail') && await page.locator('hx-channel-sidebar.open').isVisible(), 'menu opens the drawer with rail + channels');
await page.screenshot({ path: `${outDir}/mobile-drawer.png` });
await page.keyboard.press('Escape');
await settle();
check(!(await page.locator('hx-channel-sidebar.open').count()), 'Esc closes the drawer');

// 5. Join voice on mobile → pill above the composer; soundboard opens as a bottom sheet.
await page.goto(`${BASE}/s/${serverId}/v/${lounge.id}`);
await page.getByRole('button', { name: 'Join voice' }).click();
await page.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 15000 });
await page.getByRole('toolbar', { name: 'Voice controls' }).getByRole('button', { name: /Soundboard/ }).first().click();
const sheet = page.getByRole('dialog', { name: 'Soundboard' });
await sheet.waitFor();
const box = await sheet.boundingBox();
check(Math.abs(box.y + box.height - 844) < 2 && box.width >= 388, `soundboard is a bottom sheet (${Math.round(box.width)}×${Math.round(box.height)} at y=${Math.round(box.y)})`);
await page.waitForTimeout(400);
await page.screenshot({ path: `${outDir}/mobile-soundboard.png` });
await page.keyboard.press('Escape');
await sheet.waitFor({ state: 'detached' });
// In-app navigation (a reload would end the call): drawer → #general.
await page.getByRole('button', { name: 'Open channels' }).click();
await page.locator(`hx-channel-sidebar a.ch[href$="/c/${general.id}"]`).click();
const pill = page.getByRole('region', { name: 'Voice controls (compact)' });
await pill.waitFor({ timeout: 15000 });
check(await pill.textContent().then((t) => t.includes('Lounge')), 'voice pill shows the connected channel above the composer');
await pill.getByRole('button', { name: 'Mute' }).click();
check(await pill.getByRole('button', { name: 'Unmute' }).getAttribute('aria-pressed') === 'true', 'pill mute works');
await pill.getByRole('button', { name: 'Unmute' }).click();
await page.screenshot({ path: `${outDir}/mobile-pill.png` });
await pill.getByRole('button', { name: 'Disconnect from voice' }).click();
await pill.waitFor({ state: 'detached' });
check(true, 'pill disconnect leaves voice');

await browser.close();
console.log('responsive smoke passed');
