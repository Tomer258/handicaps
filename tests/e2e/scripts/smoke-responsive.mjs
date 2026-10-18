// Dev smoke for Responsive.dc.html: docked soundboard (Concept B) at ≥ 1280 — replaces the member list at lg, sits
// beside it at xl, falls back to a popover below 1280 — and the phone rules (no streaming out, bottom-sheet soundboard).
// Usage: node scripts/smoke-responsive.mjs <out-dir>   (needs compose livekit + API + ng serve; user tomer)
import { chromium } from '@playwright/test';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}

try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] })).newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Login').fill('tomer');
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`);
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
  const serverId = me.servers[0].id;
  const detail = await page.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), serverId);
  const lounge = detail.channels.find((c) => c.name === 'Lounge');
  await page.goto(`${BASE}/s/${serverId}/v/${lounge.id}`);
  await page.getByRole('button', { name: 'Join voice' }).click();
  const dock = page.getByRole('toolbar', { name: 'Voice controls' });
  await dock.waitFor({ timeout: 20000 });

  const members = page.getByRole('complementary', { name: 'Members' });
  const docked = page.getByRole('complementary', { name: 'Soundboard' });
  const popover = page.getByRole('dialog', { name: 'Soundboard' });

  // lg: docking replaces the member list.
  await dock.getByRole('button', { name: 'Soundboard' }).click();
  await popover.getByRole('button', { name: 'Dock soundboard to the side' }).click();
  await docked.waitFor({ timeout: 5000 });
  check(await members.count() === 0, '1440: the docked soundboard takes the member list\'s place');
  await page.screenshot({ path: `${outDir}/responsive-docked-lg.png` });

  // xl: both fit.
  await page.setViewportSize({ width: 1700, height: 950 });
  await members.waitFor({ timeout: 5000 });
  check(await docked.count() === 1, '1700: members and the docked soundboard sit side by side');
  await page.screenshot({ path: `${outDir}/responsive-docked-xl.png` });

  // md: never docked — the same soundboard shows as a popover.
  await page.setViewportSize({ width: 1150, height: 800 });
  await popover.waitFor({ timeout: 5000 });
  check(await docked.count() === 0, '1150: the soundboard falls back to a popover');
  await page.setViewportSize({ width: 1440, height: 900 });
  await docked.getByRole('button', { name: 'Undock soundboard' }).click();
  await popover.waitFor({ timeout: 5000 });
  check(true, 'undocking turns it back into a popover');
  await popover.getByRole('button', { name: 'Close soundboard' }).click();

  // xs: phone — no streaming out; soundboard is a bottom sheet.
  await page.setViewportSize({ width: 390, height: 844 });
  const share = dock.getByRole('button', { name: 'Share your screen' });
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('[role=toolbar] button')].find((x) => x.getAttribute('aria-label') === 'Share your screen');
    return b?.disabled && /wider/.test(b.title);
  }, null, { timeout: 5000 });
  check(true, '390: streaming out is off with an explanation');
  await dock.getByRole('button', { name: 'Soundboard' }).click();
  await popover.waitFor({ timeout: 5000 });
  const box = await popover.boundingBox();
  check(box && Math.abs(box.y + box.height - 844) < 2 && box.width >= 388, '390: the soundboard opens as a bottom sheet');
  await page.waitForTimeout(600); // drawer slide + sheet fade-in
  await page.screenshot({ path: `${outDir}/responsive-sheet-xs.png` });
  console.log('responsive smoke passed');
} finally {
  await browser.close();
}
