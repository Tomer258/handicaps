// Dev smoke for States 15: when a friend drops unexpectedly (browser crash / network loss: no clean leave) their card stays dimmed with
// "Reconnecting…" while the server still holds their lease, then leaves when the grace ends. A deliberate leave
// removes the card right away without the reconnecting state.
// Usage: node scripts/smoke-reconnect.mjs <out-dir>   (needs compose livekit + API + ng serve; users tomer & friend)
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
async function session(login, b = browser) {
  const page = await (await b.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone'] })).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`);
  return page;
}

try {
  const owner = await session('tomer');
  const me = await owner.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
  const serverId = me.servers[0].id;
  const detail = await owner.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), serverId);
  const lounge = detail.channels.find((c) => c.name === 'Lounge');
  const join = async (p) => {
    await p.goto(`${BASE}/s/${serverId}/v/${lounge.id}`);
    await p.getByRole('button', { name: 'Join voice' }).click();
    await p.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 20000 });
  };
  await join(owner);

  // Control: a deliberate leave never shows "reconnecting".
  let friend = await session('friend');
  const friendName = (await friend.evaluate(async () => (await fetch('/api/v1/auth/me')).json())).user.displayName;
  await join(friend);
  const card = owner.locator('button.pcard', { hasText: friendName });
  await card.waitFor({ timeout: 15000 });
  await friend.getByRole('toolbar', { name: 'Voice controls' }).getByRole('button', { name: 'Disconnect', exact: true }).click();
  await card.waitFor({ state: 'detached', timeout: 15000 });
  await owner.waitForTimeout(2500);
  check(await owner.getByText('disconnected unexpectedly').count() === 0, 'a deliberate leave removes the card without "reconnecting"');
  await friend.context().close();

  // Unexpected drop: the friend's whole browser process dies, so no pagehide/unload handler can release the lease
  // (closing a tab is a deliberate leave: pagehide sends DELETE /voice/{lease} with keepalive).
  const server = await chromium.launchServer({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  friend = await session('friend', await chromium.connect(server.wsEndpoint()));
  await join(friend);
  await card.waitFor({ timeout: 15000 });
  const t0 = Date.now();
  await server.kill(); // force-kills the browser process
  await owner.getByText(`${friendName} disconnected unexpectedly — reconnecting…`).waitFor({ timeout: 40000 });
  const ghost = owner.locator('button.pcard[aria-label$="reconnecting"]', { hasText: friendName });
  check(await ghost.count() === 1, `the dropped friend's card stays, marked reconnecting (${((Date.now() - t0) / 1000).toFixed(1)} s after the drop)`);
  await owner.screenshot({ path: `${outDir}/voice-reconnecting.png` });
  await ghost.waitFor({ state: 'detached', timeout: 90000 });
  check(true, `the card leaves when the server's grace ends (${((Date.now() - t0) / 1000).toFixed(1)} s after the drop)`);
  console.log('reconnect smoke passed');
} finally {
  await browser.close();
}
