// Restart/outage drill (dev stack, roadmap Phase 7): two browsers chatting and in voice while we
//   1. restart the API            → voice keeps flowing, realtime chat resumes without a reload, sessions survive
//   2. stop PostgreSQL for ~20 s  → voice keeps flowing, API reports 503 then recovers by itself
//   3. restart the SFU (LiveKit)  → clients see the loss, rejoin works, stale leases are cleaned up
//   4. restart the sound publisher → the soundboard works again afterwards
// Prereqs: compose (postgres, livekit, sound-publisher, asset-validator) + ng serve. The script (re)starts the API itself.
// Usage: cd tests/e2e && node scripts/resilience-drill.mjs
import { chromium } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { openSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const BASE = 'http://localhost:4200';
const API = 'http://localhost:5080';
const LK = { url: 'http://localhost:7880', key: 'hangar-dev', secret: 'hangar-dev-secret-local-only-0123456789abcdef' };
const C = { pg: 'hangar-dev-postgres-1', lk: 'hangar-dev-livekit-1', pub: 'hangar-dev-sound-publisher-1' };

function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}
const RUN = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn().catch(() => false)) return (Date.now() - t0) / 1000;
    await sleep(500);
  }
  throw new Error(`FAILED: timed out waiting for ${what}`);
}
const docker = (args) => execSync(`docker ${args}`, { stdio: 'ignore' });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
async function participants() {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: LK.key, sub: 'drill', nbf: now - 5, exp: now + 60, video: { roomList: true } })}`;
  const jwt = `${body}.${createHmac('sha256', LK.secret).update(body).digest('base64url')}`;
  const r = await fetch(`${LK.url}/twirp/livekit.RoomService/ListRooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` }, body: '{}',
  });
  return ((await r.json()).rooms ?? []).reduce((n, room) => n + (room.num_participants ?? 0), 0);
}

const apiUp = async () => (await fetch(`${API}/healthz`).catch(() => null))?.ok === true;
async function startApi() {
  const log = openSync(resolve(ROOT, '.tmp/api.log'), 'a');
  spawn('dotnet', ['run', '--no-build', '--project', 'apps/api/src/Hangar.Api'], { cwd: ROOT, detached: true, stdio: ['ignore', log, log] }).unref();
  await until('API to start', apiUp, 90000);
}
const killApi = () => execSync('taskkill /F /IM Hangar.Api.exe', { stdio: 'ignore' });

if (!(await apiUp())) await startApi();
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

async function login(name) {
  const page = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Login').fill(name);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`);
  return page;
}

try {
  const owner = await login('tomer');
  const friend = await login('friend');
  const me = await owner.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
  const serverId = me.servers[0].id;
  const detail = await owner.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), serverId);
  const lounge = detail.channels.find((c) => c.name === 'Lounge');
  const general = detail.channels.find((c) => c.name === 'general');

  // Friend reads #general; owner sits in voice (the voice view) — both stay on these pages for the whole drill.
  await friend.goto(`${BASE}/s/${serverId}/c/${general.id}`);
  await friend.locator('#composer').waitFor();
  const joinVoice = async (p) => {
    await p.getByRole('button', { name: 'Join voice' }).click();
    await p.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 20000 });
  };
  await owner.goto(`${BASE}/s/${serverId}/v/${lounge.id}`);
  await joinVoice(owner);
  // The friend joins voice from the sidebar without leaving the text channel.
  const friendVoice = await login('friend');
  await friendVoice.goto(`${BASE}/s/${serverId}/v/${lounge.id}`);
  await joinVoice(friendVoice);
  await until('two participants in LiveKit', async () => (await participants()) >= 2, 15000);
  check(true, 'baseline: two people in voice, one reading #general');

  const say = async (text) => {
    const r = await owner.evaluate(async ([ch, body]) => {
      const xsrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1] ?? '');
      const res = await fetch(`/api/v1/channels/${ch}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-XSRF-TOKEN': xsrf },
        body: JSON.stringify({ clientMessageId: crypto.randomUUID(), body }) });
      return res.status;
    }, [general.id, text]);
    return r;
  };
  const friendSees = (text, ms = 30000) => friend.getByText(text).waitFor({ timeout: ms });

  // 1. API restart.
  killApi();
  const t0 = Date.now();
  await sleep(3000);
  check((await participants()) >= 2, 'voice keeps flowing while the API is down');
  await startApi();
  console.log(`  API back after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  check(await until('API session to survive', async () => (await say(`after api restart ${RUN}`)) === 201, 20000) >= 0, 'session cookie still valid after restart (persisted keys)');
  await friendSees(`after api restart ${RUN}`);
  check(true, 'realtime chat resumes for the friend without a reload');
  check((await participants()) >= 2, 'nobody was dropped from voice');

  // 2. Database outage.
  docker(`stop ${C.pg}`);
  await sleep(2000);
  check((await fetch(`${API}/healthz`)).status === 503, 'health check reports 503 while PostgreSQL is down');
  const during = await say(`during db outage ${RUN}`);
  check(during === 503, `writes fail cleanly with 503 during the outage (HTTP ${during})`);
  // The friend types during the outage: the client keeps it and delivers it by itself afterwards.
  await friend.locator('#composer').click();
  await friend.keyboard.type(`typed during the outage ${RUN}`);
  await friend.keyboard.press('Enter');
  await sleep(16000);
  check((await participants()) >= 2, 'voice keeps flowing through a 20 s database outage');
  docker(`start ${C.pg}`);
  const healed = await until('API to heal', apiUp, 60000);
  check(true, `API recovered on its own ${healed.toFixed(1)} s after PostgreSQL returned`);
  await until('writes to work again', async () => (await say(`after db outage ${RUN}`)) === 201, 30000);
  await friendSees(`after db outage ${RUN}`);
  check(true, 'chat works again after the outage, no restart needed');
  await until('the queued message to be delivered', async () => {
    const page = await owner.evaluate(async (ch) => (await fetch(`/api/v1/channels/${ch}/messages?limit=20`)).json(), general.id);
    return page.messages.some((m) => m.body === `typed during the outage ${RUN}`);
  }, 40000);
  check(true, 'a message typed during the outage is delivered automatically');

  // 3. SFU restart.
  docker(`restart ${C.lk}`);
  await until('LiveKit back', async () => (await participants()) >= 0, 60000);
  // Each client either reconnects by itself (livekit-client full reconnect) or shows "Join voice" — both are fine,
  // as long as everyone ends up back in the room and the server roster agrees.
  const t3 = Date.now();
  const rejoined = new Set();
  while ((await participants().catch(() => 0)) < 2) {
    if (Date.now() - t3 > 90000) throw new Error('FAILED: clients did not get back into voice after the SFU restart');
    for (const [name, p] of [['owner', owner], ['friend', friendVoice]]) {
      if (await p.getByRole('button', { name: 'Join voice' }).isVisible()) {
        await joinVoice(p);
        rejoined.add(name);
      }
    }
    await sleep(1000);
  }
  await until('both back in LiveKit', async () => (await participants()) >= 2, 30000);
  check(rejoined.size === 0, `both clients rejoined on their own after the SFU restart (${((Date.now() - t3) / 1000).toFixed(1)} s; manual rejoin needed: ${[...rejoined].join(', ') || 'none'})`);
  await sleep(20000); // let a reconcile pass run against the restarted SFU
  check((await participants()) >= 2, 'still both in voice after reconciliation');
  const roster = await owner.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}/voice`)).json(), serverId);
  check(roster.length === 2, `voice roster has exactly the two live members (${roster.length})`);

  // 4. Sound publisher restart.
  docker(`restart ${C.pub}`);
  await sleep(5000);
  const sb = (p) => p.getByRole('toolbar', { name: 'Voice controls' }).getByRole('button', { name: 'Soundboard' });
  await sb(owner).click();
  await sb(friendVoice).click();
  const pop = owner.getByRole('dialog', { name: 'Soundboard' });
  await pop.getByRole('button', { name: 'All', exact: true }).click();
  const tile = pop.locator('.stile').first();
  if (await tile.count()) {
    const t1 = Date.now();
    for (let i = 0; ; i++) {
      await tile.click();
      const ok = await friendVoice.getByRole('dialog', { name: 'Soundboard' }).getByText('played by Tomer').waitFor({ timeout: 8000 }).then(() => true, () => false);
      if (ok) break;
      if (i === 5) throw new Error('FAILED: soundboard did not recover after the publisher restart');
      await sleep(3000);
    }
    check(true, `soundboard plays again (${((Date.now() - t1) / 1000).toFixed(1)} s after the publisher came back)`);
  } else {
    console.log('  (no sounds uploaded — skipped the soundboard check)');
  }
  console.log('resilience drill passed');
} finally {
  await browser.close();
}
