// Dev smoke: the PC refuses "clean" system-audio capture (Chrome throws NotReadableError when audio processing is
// turned off). The Go Live dialog stays open and retries in compatibility mode (browser-default audio); when that
// fails too, it shows the browser's error and shares without sound.
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
  // window.__failCompat: also fail browser-default audio (audio: true).
  await ctx.addInitScript(() => {
    const orig = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = (c) => {
      const clean = c && typeof c.audio === 'object';
      const compat = c && c.audio === true;
      if (clean) window.__cleanAudio = c.audio;
      if (clean || (compat && window.__failCompat)) return Promise.reject(new DOMException('Could not start audio source', 'NotReadableError'));
      return orig(c);
    };
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

  const dialog = page.getByRole('dialog', { name: /Go live in/ });
  const stop = dock.getByRole('button', { name: 'Stop sharing your screen' });

  // 1. Clean capture fails → compatibility mode goes live with one click.
  await dock.getByRole('button', { name: 'Share your screen' }).click();
  await dialog.getByRole('button', { name: 'Choose what to share' }).click();
  await dialog.getByRole('alert').getByText("couldn't start this PC's sound in high-quality mode").waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/share-audio-failed.png` });
  await dialog.getByRole('button', { name: 'Try again with sound' }).click();
  await stop.waitFor({ timeout: 20000 });
  const asked = await page.evaluate(() => window.__cleanAudio);
  check(asked?.restrictOwnAudio === true && asked.echoCancellation === false && asked.channelCount === 2,
    'clean capture asks for stereo sound without the browser’s own (per-process loopback)');
  check(true, 'after a clean-capture failure, "Try again with sound" goes live in compatibility mode');
  await stop.click();
  await dock.getByRole('button', { name: 'Share your screen' }).waitFor();

  // 2. Both modes fail → the browser's words, and video-only still works.
  // Compatibility mode worked above, so it is remembered: the next share asks for browser-default audio first.
  check(await page.evaluate(() => JSON.parse(localStorage.getItem('hangar.mediaPrefs')).screenAudioCompat === true), 'the working compatibility mode is remembered');
  await page.evaluate(() => { window.__failCompat = true; });
  await dock.getByRole('button', { name: 'Share your screen' }).click();
  await dialog.getByRole('button', { name: 'Choose what to share' }).click();
  await dialog.getByRole('alert').getByText('NotReadableError: Could not start audio source').waitFor({ timeout: 10000 });
  check(true, 'when compatibility mode fails too, the dialog quotes the browser and suggests a tab');
  await page.screenshot({ path: `${outDir}/share-audio-failed-compat.png` });
  await dialog.getByRole('button', { name: 'Share without sound' }).click();
  await stop.waitFor({ timeout: 20000 });
  check(true, '"Share without sound" goes live with video only');
  await stop.click();
  await page.evaluate(() => localStorage.removeItem('hangar.mediaPrefs'));
  console.log('share-audio smoke passed');
} finally {
  await browser.close();
}
