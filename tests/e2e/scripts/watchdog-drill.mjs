// Authorization watchdog drill (dev): two browsers in voice through the Caddy gate; the API is killed, the watchdog
// trips (flag → gate 503, LiveKit rooms deleted), the API comes back, the watchdog reopens and voice works again.
// Prereqs (from the repo root):
//   mkdir -p .tmp/watchdog; gate container per infra/caddy/Caddyfile.gate-dev (mounts .tmp/watchdog)
//   LIVEKIT_API_KEY=hangar-dev LIVEKIT_API_SECRET=hangar-dev-secret-local-only-0123456789abcdef API_URL=http://localhost:5080 \
//     LIVEKIT_URL=http://localhost:7880 FLAG_PATH=.tmp/watchdog/closed HEARTBEAT_PATH=.tmp/watchdog/heartbeat \
//     TRIP_AFTER=15 RECOVER_AFTER=8 INTERVAL=2 python -I workers/auth-watchdog/watchdog.py
//   compose livekit + ng serve. This script starts/kills/restarts the API itself (PublicUrl → the gate).
// Usage: cd tests/e2e && node scripts/watchdog-drill.mjs
import { chromium } from '@playwright/test';
import { spawn, execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, openSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const FLAG = resolve(ROOT, '.tmp/watchdog/closed');
const BASE = 'http://localhost:4200';
const API = 'http://localhost:5080';
const GATE = 'http://localhost:7890';
const LK = { url: 'http://localhost:7880', key: 'hangar-dev', secret: 'hangar-dev-secret-local-only-0123456789abcdef' };

function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return (Date.now() - t0) / 1000;
    await sleep(500);
  }
  throw new Error(`FAILED: timed out waiting for ${what}`);
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
async function participantsInRooms() {
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
  spawn('dotnet', ['run', '--no-build', '--project', 'apps/api/src/Hangar.Api'], {
    cwd: ROOT, detached: true, stdio: ['ignore', log, log],
    env: { ...process.env, Hangar__LiveKit__PublicUrl: 'ws://localhost:7890' },
  }).unref();
  await until('API to start', apiUp, 90000);
}
const killApi = () => execSync('taskkill /F /IM Hangar.Api.exe', { stdio: 'ignore' });

check(!existsSync(FLAG), 'watchdog flag absent at start (voice open)');
if (!(await apiUp())) await startApi();

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
async function inVoice(login) {
  const page = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`);
  return page;
}
async function joinLounge(page) {
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
  const serverId = me.servers[0].id;
  const detail = await page.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), serverId);
  const lounge = detail.channels.find((c) => c.name === 'Lounge');
  await page.goto(`${BASE}/s/${serverId}/v/${lounge.id}`);
  await page.getByRole('button', { name: 'Join voice' }).click();
  await page.getByRole('toolbar', { name: 'Voice controls' }).waitFor({ timeout: 20000 });
}

const owner = await inVoice('tomer');
const friend = await inVoice('friend');
await joinLounge(owner);
await joinLounge(friend);
await until('both participants in LiveKit', async () => (await participantsInRooms()) >= 2, 15000);
check(true, 'two clients connected through the gate');

// 1. API dies: media keeps flowing at first, then the watchdog closes voice.
killApi();
const tripped = await until('watchdog flag', () => existsSync(FLAG), 45000);
check(tripped >= 10, `watchdog waits out its window before closing (${tripped.toFixed(1)} s after the API died)`);
const emptied = await until('LiveKit rooms to empty', async () => (await participantsInRooms()) === 0, 15000);
check(true, `all participants disconnected (${emptied.toFixed(1)} s after the flag)`);
check((await fetch(`${GATE}/rtc/validate?access_token=x`)).status === 503, 'gate answers 503 on signaling while closed');
await sleep(6000);
check((await participantsInRooms()) === 0, 'clients cannot reconnect while closed');

// 2. API returns: voice reopens after the recovery window, and joining works again.
await startApi();
const reopened = await until('watchdog to reopen', () => !existsSync(FLAG), 60000);
check(true, `watchdog reopened voice ${reopened.toFixed(1)} s after the API was healthy`);
check((await fetch(`${GATE}/rtc/validate?access_token=x`)).status === 403, 'gate back to admission (garbage token → 403)');
await owner.reload();
await joinLounge(owner);
await until('owner back in LiveKit', async () => (await participantsInRooms()) >= 1, 15000);
check(true, 'rejoin works after recovery');

await browser.close();
console.log('watchdog drill passed');
