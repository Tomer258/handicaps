// Dev smoke for invites: quick Invite dialog (link reused, copy, new link with settings), invite landing page (inviter,
// member count, sign-in link, already-signed-in state, dead link), "Manage invites" list (used up, who joined) and the
// joined member's profile ("invited by").
// Usage: node scripts/smoke-invite.mjs   (needs API + ng serve; owner tomer; creates one member per run)
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:4200';
const browser = await chromium.launch();

function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('✓', msg);
}

try {
  const ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const owner = await ownerCtx.newPage();
  owner.on('pageerror', (e) => console.log('[owner] page error:', e.message));
  await owner.goto(`${BASE}/login`);
  await owner.getByLabel('Login').fill('tomer');
  await owner.getByLabel('Password').fill('correct horse battery');
  await owner.getByRole('button', { name: 'Sign in' }).click();
  await owner.waitForURL(`${BASE}/`);
  const me = await owner.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
  const serverId = me.servers[0].id;
  const detail = await owner.evaluate(async (id) => (await fetch(`/api/v1/servers/${id}`)).json(), serverId);
  const general = detail.channels.find((c) => c.name === 'general');
  await owner.goto(`${BASE}/s/${serverId}/c/${general.id}`);

  // Quick dialog: a link at once, reused on reopen.
  const sidebar = owner.getByRole('navigation', { name: 'Channels' });
  await sidebar.getByRole('button', { name: 'Invite friends' }).click();
  const dialog = owner.getByRole('dialog', { name: 'Invite friends' });
  const field = dialog.getByTestId('invite-link');
  await owner.waitForFunction(() => document.querySelector('[data-testid=invite-link]')?.value.includes('/invite/'));
  const first = await field.inputValue();
  check(/\/invite\/[\w-]+$/.test(first), 'the Invite dialog makes a link right away');
  check((await dialog.getByTestId('invite-summary').textContent()).includes('5 more people'), 'default link works for 5 people');
  await dialog.getByRole('button', { name: 'Copy' }).click();
  await dialog.getByRole('button', { name: 'Copied' }).waitFor();
  check(await owner.evaluate(() => navigator.clipboard.readText()) === first, 'Copy puts the link on the clipboard');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await sidebar.getByRole('button', { name: 'Invite friends' }).click();
  await owner.waitForFunction(() => document.querySelector('[data-testid=invite-link]')?.value.includes('/invite/'));
  check(await field.inputValue() === first, 'reopening the dialog reuses the still-active link');

  // New link with settings.
  await dialog.getByRole('button', { name: 'Link settings' }).click();
  check(await dialog.getByLabel('Expires after').inputValue() === '168' && await dialog.getByLabel('Max uses').inputValue() === '5',
    'link settings show the current link’s settings (7 days, 5 people)');
  await dialog.getByLabel('Max uses').selectOption('1');
  await dialog.getByLabel('Note (only admins see it)').fill('Smoke friend');
  await dialog.getByRole('button', { name: 'Make a new link with these settings' }).click();
  await owner.waitForFunction((old) => {
    const v = document.querySelector('[data-testid=invite-link]')?.value;
    return v && v !== old && v.includes('/invite/');
  }, first);
  const link = await field.inputValue();
  check((await dialog.getByTestId('invite-summary').textContent()).includes('1 more person'), 'a new single-use link replaces it');
  await dialog.getByRole('button', { name: 'Done' }).click();

  // The owner opening their own link is told they're already in.
  const ownerTab = await ownerCtx.newPage();
  await ownerTab.goto(link);
  await ownerTab.getByTestId('invite-signed-in').waitFor();
  check(await ownerTab.getByRole('button', { name: 'Sign out and create another account' }).count() === 1,
    'a signed-in member opening the link is told they are already in');
  await ownerTab.close();

  // A friend opens it: who invited, how many members, sign-in link; registers.
  const friendCtx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const friend = await friendCtx.newPage();
  friend.on('pageerror', (e) => console.log('[friend] page error:', e.message));
  await friend.goto(link);
  const from = await friend.getByTestId('invite-from').textContent();
  check(from.includes(me.user.displayName) && /\d+ members? already here/.test(from), `the invite page says who invited and how many are here ("${from.trim()}")`);
  check(await friend.getByRole('link', { name: 'Sign in' }).count() === 1, 'the invite page links to sign-in for existing accounts');
  const login = 'inv' + Math.floor(Math.random() * 1e6);
  await friend.getByLabel('Display name').fill('Invite Smoke');
  await friend.getByLabel('Login').fill(login);
  await friend.getByLabel('Password').fill('correct horse battery');
  await friend.getByRole('button', { name: 'Create account' }).click();
  await friend.waitForURL(`${BASE}/`);
  check(true, 'the friend registers with the link');

  // The used link is dead for the next person.
  const late = await (await browser.newContext()).newPage();
  await late.goto(link);
  await late.getByRole('heading', { name: "This invite doesn't work anymore" }).waitFor();
  check(true, 'a used-up link says it no longer works');

  // Manage invites: the used link with who joined.
  await sidebar.getByRole('button', { name: 'Invite friends' }).click();
  await dialog.getByRole('button', { name: 'Manage invites' }).click();
  const ended = owner.getByTestId('ended-invite-row').filter({ hasText: 'Smoke friend' }).first();
  await ended.waitFor();
  const endedText = await ended.textContent();
  check(endedText.includes('Used up') && endedText.includes('Joined: Invite Smoke') && endedText.includes(`by ${me.user.displayName}`),
    'Manage invites lists the used link, who made it and who joined');
  await owner.keyboard.press('Escape');

  // The new member's profile says who invited them.
  await owner.reload();
  const members = owner.getByRole('complementary', { name: 'Members' });
  await members.getByRole('button', { name: /^Invite Smoke, / }).first().click();
  const joined = await owner.getByTestId('profile-joined').textContent();
  check(joined.includes(`invited by ${me.user.displayName}`), `the member's profile says who invited them ("${joined.trim()}")`);
  console.log('invite smoke passed');
} finally {
  await browser.close();
}
