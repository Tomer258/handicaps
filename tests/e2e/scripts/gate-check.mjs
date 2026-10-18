// Verifies the Caddy forward_auth gate in front of LiveKit signaling (infra/caddy/Caddyfile.gate-dev on :7890):
// a live lease's token passes; foreign Origin, garbage tokens, admin/Twirp paths and a token replayed after leaving
// are refused on every signaling route.
// Usage: node scripts/gate-check.mjs   (needs the gate container, API on :5080 with PublicUrl ws://localhost:7890, ng serve)
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:4200';
const GATE = process.env.GATE ?? 'http://localhost:7890';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();

function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}
const call = (method, path, body) => page.evaluate(async ([method, path, body]) => {
  const xsrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1] ?? '');
  const r = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
}, [method, path, body]);
const gate = async (path, headers = {}) => (await fetch(GATE + path, { headers })).status;

await page.goto(`${BASE}/login`);
await page.getByLabel('Login').fill('tomer');
await page.getByLabel('Password').fill('correct horse battery');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL(`${BASE}/`);
const me = (await call('GET', '/auth/me')).body;
const detail = (await call('GET', `/servers/${me.servers[0].id}`)).body;
const lounge = detail.channels.find((c) => c.name === 'Lounge');

const join = await call('POST', `/channels/${lounge.id}/voice/join`, { requestId: crypto.randomUUID(), priorLeaseId: null });
check(join.status === 200 && join.body.url.startsWith('ws://localhost:7890'), `join returns the gated URL (${join.body?.url})`);
const token = join.body.token;
const q = `?access_token=${encodeURIComponent(token)}`;

check(await gate(`/rtc/validate${q}`) === 200, 'live lease token passes the gate (/rtc/validate → LiveKit 200)');
check(await gate(`/rtc/validate${q}`, { Origin: 'https://evil.example' }) === 403, 'foreign Origin refused');
check(await gate('/rtc/validate?access_token=not-a-jwt') === 403, 'garbage token refused');
check(await gate('/rtc/validate') === 403, 'missing token refused');
check(await gate('/twirp/livekit.RoomService/ListRooms') === 404, 'Twirp/admin API not exposed through the gate');
check(await gate('/') === 404, 'other paths not exposed');

check((await call('DELETE', `/voice/${join.body.leaseId}`)).status === 204, 'leave ends the lease');
for (const path of ['/rtc', '/rtc/validate', '/rtc/v1', '/rtc/v1/validate']) {
  check(await gate(`${path}${q}`) === 403, `token replayed after leaving is refused on ${path}`);
}

await browser.close();
console.log('gate check passed');
