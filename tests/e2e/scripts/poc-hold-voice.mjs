// Drill helper: signs two accounts in, joins the first voice channel and stays there, reporting when each client is
// dropped and when it can rejoin. For gate-watchdog.sh rehearsals (two clients in voice while the API is stopped).
// Usage: node scripts/poc-hold-voice.mjs <base-url> <login-a> <login-b> <password> [seconds=400]
import { chromium } from '@playwright/test';

const [, , BASE, loginA, loginB, PASSWORD, secs = '400'] = process.argv;
const browser = await chromium.launch({
  args: ['--ignore-certificate-errors', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;

async function hold(login) {
  const page = await (await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['microphone'] })).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`);
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
  const detail = await page.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), me.servers[0].id);
  const voice = detail.channels.find((c) => c.type === 'voice');
  await page.goto(`${BASE}/s/${me.servers[0].id}/v/${voice.id}`);
  await page.getByRole('button', { name: 'Join voice' }).click();
  const dock = page.getByRole('toolbar', { name: 'Voice controls' });
  await dock.waitFor({ timeout: 30000 });
  console.log(`[${at()}] ${login} in voice`);
  await dock.waitFor({ state: 'detached', timeout: 0 }).catch(() => {});
  console.log(`[${at()}] ${login} dropped from voice`);
}

await Promise.all([hold(loginA), hold(loginB)]);
await new Promise((r) => setTimeout(r, Number(secs) * 1000 - (Date.now() - t0)));
await browser.close();
