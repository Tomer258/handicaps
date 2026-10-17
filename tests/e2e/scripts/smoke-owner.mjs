// Dev smoke: redeem the owner bootstrap link from the API log, then screenshot the shell.
// Usage: node scripts/smoke-owner.mjs <api-log-path> <out-dir>
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const [, , logPath, outDir] = process.argv;
const log = fs.readFileSync(logPath, 'utf8');
const links = [...log.matchAll(/(http:\/\/localhost:4200\/invite\/[A-Za-z0-9_-]+)/g)].map((m) => m[1]);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('console error:', m.text()); });

if (links.length) {
  await page.goto(links.at(-1));
  await page.getByLabel('Display name').fill('Tomer');
  await page.getByLabel('Login').fill('tomer');
  await page.getByLabel('Password').fill('correct horse battery');
  await page.screenshot({ path: `${outDir}/01-invite.png` });
  await page.getByRole('button', { name: 'Create account' }).click();
} else {
  await page.goto('http://localhost:4200/login');
  await page.getByLabel('Login').fill('tomer');
  await page.getByLabel('Password').fill('correct horse battery');
  await page.screenshot({ path: `${outDir}/01-login.png` });
  await page.getByRole('button', { name: 'Sign in' }).click();
}
await page.waitForURL('http://localhost:4200/');
await page.screenshot({ path: `${outDir}/02-home.png` });
await page.locator('a.card').first().click();
await page.waitForURL(/\/s\/.+\/c\/.+/);
await page.waitForTimeout(500);
await page.screenshot({ path: `${outDir}/03-server.png` });
console.log('ok', page.url());
await browser.close();
