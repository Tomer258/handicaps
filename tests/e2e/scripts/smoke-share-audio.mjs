// Dev smoke: Windows refuses system-audio capture (Chrome throws NotReadableError when audio is requested). The Go
// Live dialog stays open, explains it, and one click shares without sound.
// Usage: node scripts/smoke-share-audio.mjs <out-dir>   (needs compose livekit + API + ng serve; user tomer)
import { chromium } from '@playwright/test';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen'],
});
function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone'] });
  await ctx.addInitScript(() => {
    const orig = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = (c) =>
      c && c.audio ? Promise.reject(new DOMException('Could not start audio source', 'NotReadableError')) : orig(c);
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Login').fill('tomer');
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`);
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
  const detail = await page.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), me.servers[0].id);
  const lounge = detail.channels.find((c) => c.name === 'Lounge');
  await page.goto(`${BASE}/s/${me.servers[0].id}/v/${lounge.id}`);
  await page.getByRole('button', { name: 'Join voice' }).click();
  const dock = page.getByRole('toolbar', { name: 'Voice controls' });
  await dock.waitFor({ timeout: 20000 });

  await dock.getByRole('button', { name: 'Share your screen' }).click();
  const dialog = page.getByRole('dialog', { name: /Go live in/ });
  await dialog.getByRole('button', { name: 'Choose what to share' }).click();
  await dialog.getByRole('alert').getByText("Windows wouldn't let the browser capture this PC's sound").waitFor({ timeout: 10000 });
  check(await dialog.getByRole('button', { name: 'Include system audio' }).getAttribute('aria-pressed') === 'false', 'sound failure keeps the dialog open with audio switched off');
  await page.screenshot({ path: `${outDir}/share-audio-failed.png` });
  await dialog.getByRole('button', { name: 'Share without sound' }).click();
  await dock.getByRole('button', { name: 'Stop sharing your screen' }).waitFor({ timeout: 20000 });
  check(true, '"Share without sound" goes live with video only');
  await dock.getByRole('button', { name: 'Stop sharing your screen' }).click();
  console.log('share-audio smoke passed');
} finally {
  await browser.close();
}
