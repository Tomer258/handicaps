// Dev smoke for two-step login: friend enrols an authenticator from the QR/key in My account, signs out, signs back in
// with a code, then with a recovery code, and finally turns it off again (so other smokes keep logging in normally).
// Usage: node scripts/smoke-2fa.mjs <out-dir>   (needs API + ng serve; user friend)
import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

const [, , outDir = '../../.tmp/shots'] = process.argv;
const BASE = 'http://localhost:4200';
const PASSWORD = 'correct horse battery';
const browser = await chromium.launch();

function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}

function base32(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s.replace(/\s/g, '')) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret, offsetSteps = 0) {
  const step = Math.floor(Date.now() / 30000) + offsetSteps;
  const counter = Buffer.alloc(8);
  counter.writeBigInt64BE(BigInt(step));
  const h = createHmac('sha1', base32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}

const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
page.on('pageerror', (e) => console.log('page error:', e.message));

async function passwordStep() {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Login').fill('friend');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
async function openAccount() {
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
  await page.goto(`${BASE}/s/${me.servers[0].id}`);
  await page.getByRole('button', { name: 'User settings' }).click();
  await page.getByRole('navigation', { name: 'Settings sections' }).waitFor();
}

let enabled = false;
try {
  await passwordStep();
  await page.waitForURL(`${BASE}/`);
  await openAccount();
  await page.getByRole('button', { name: 'Set up' }).click();
  const qr = page.getByRole('img', { name: 'QR code for your authenticator app' });
  await qr.waitFor();
  check((await qr.locator('path').getAttribute('d')).length > 1000, 'QR code is drawn');
  const secret = (await page.getByTestId('totp-secret').textContent()).trim();
  check(/^[A-Z2-7 ]{32,}$/.test(secret), 'manual key is shown in groups');
  await page.screenshot({ path: `${outDir}/2fa-setup.png` });

  await page.getByLabel('2. Enter the 6-digit code it shows').fill(totp(secret));
  await page.getByRole('button', { name: 'Turn on' }).click();
  const list = page.getByTestId('recovery-codes');
  await list.waitFor();
  enabled = true;
  const codes = (await list.locator('li').allTextContents()).map((c) => c.trim());
  check(codes.length === 10 && codes.every((c) => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c)), 'ten recovery codes are shown once');
  await page.screenshot({ path: `${outDir}/2fa-codes.png` });
  await page.getByRole('button', { name: 'I saved them' }).click();
  await page.getByText('10 recovery codes left').waitFor();
  check(true, 'account shows two-step login on');

  // Sign out → password → code.
  await page.getByRole('button', { name: 'Log out' }).click();
  await page.waitForURL(/\/login/);
  await passwordStep();
  await page.getByRole('heading', { name: 'Two-step login' }).waitFor();
  check(page.url().includes('/login'), 'password alone does not sign in');
  await page.getByLabel('Code').fill('000000' === totp(secret, 1) ? '111111' : '000000');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('alert').waitFor();
  check(true, 'a wrong code is refused with a message');
  await page.screenshot({ path: `${outDir}/2fa-login.png` });
  await page.getByLabel('Code').fill(totp(secret, 1)); // the next step: the one used to enrol is spent
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(`${BASE}/`);
  check(true, 'authenticator code signs in');

  // Recovery code path.
  await openAccount();
  await page.getByRole('button', { name: 'Log out' }).click();
  await page.waitForURL(/\/login/);
  await passwordStep();
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await page.getByLabel('Recovery code').fill(codes[0]);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(`${BASE}/`);
  check(true, 'a recovery code signs in');

  await openAccount();
  await page.getByText('9 recovery codes left').waitFor();
  check(true, 'the used recovery code is gone');
  await page.getByRole('button', { name: 'Turn off' }).click();
  await page.getByLabel('Enter your password to turn off two-step login').fill(PASSWORD);
  await page.getByRole('button', { name: 'Turn off' }).last().click();
  await page.getByRole('button', { name: 'Set up' }).waitFor();
  enabled = false;
  check(true, 'two-step login turned off with the password');
  console.log('2fa smoke passed');
} finally {
  if (enabled) {
    // Leave friend usable for the other smokes even if a step failed (possibly signed out by then): reset in the dev DB.
    execSync(`docker exec hangar-dev-postgres-1 psql -U hangar -d hangar -tAc "update users set totp_secret=null, two_factor_enabled_at=null, totp_last_step=null, recovery_code_hashes=null where normalized_login='friend'"`, { stdio: 'ignore' });
    console.log('(reset friend\'s two-step login in the dev database)');
  }
  await browser.close();
}
