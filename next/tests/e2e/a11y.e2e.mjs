// Accessibility audit in real Chromium against the production build: axe-core (WCAG 2.0/2.1/2.2
// A and AA rules) on every screen at phone and desktop width, plus the keyboard behaviours that
// automated rules cannot judge (skip link, dialog focus handling) and reflow at 320 px.
//
//   npm run a11y        (not part of `npm run check`)
//
// Automated rules find roughly a third of real problems. This does NOT replace a pass with a
// screen reader (VoiceOver, TalkBack, NVDA); see docs/release-checklist.md.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright';
import { createFakeSupabase, movieRow } from './fakeSupabase.mjs';
import { createStaticServer } from './staticServer.mjs';

const appRoot = resolve(import.meta.dirname, '../..');
const work = mkdtempSync(join(tmpdir(), 'cv-a11y-'));
const viteCli = resolve(appRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const supabase = createFakeSupabase();
const user = supabase.addUser('a11y@test.dev', 'pw-a11y-1', []);
const rows = [
  ['Parasite', 'Thriller, Drama', true, 4.5, 'movie'],
  ['Amélie', 'Comedy, Romance', true, 4, 'movie'],
  ['Dark', 'Sci-Fi, Thriller', false, null, 'tv'],
  ['Heat', 'Crime', false, null, 'movie'],
  ['Spirited Away', 'Animation', true, 5, 'movie'],
  ['The Bear', 'Drama, Comedy', false, null, 'tv'],
];
for (const [title, genre, watched, rating, kind] of rows) {
  user.movies.push(
    movieRow(user.id, title, {
      genre,
      watched,
      watched_on: watched ? '2026-08-01' : null,
      user_rating: rating,
      media_type: kind,
    }),
  );
}
const supabasePort = await supabase.listen();
execFileSync(process.execPath, [viteCli, 'build', '--outDir', join(work, 'app'), '--emptyOutDir'], {
  cwd: appRoot,
  stdio: 'pipe',
  env: {
    ...process.env,
    VITE_SUPABASE_URL: `http://127.0.0.1:${supabasePort}`,
    VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_a11y_not_a_real_key_0000',
    VITE_APP_ENV: 'development',
  },
});
const web = createStaticServer(join(work, 'app'), (_req, res) => {
  res.writeHead(501, { 'Content-Type': 'application/json' });
  res.end('{"code":"not_configured"}');
});
const base = `http://127.0.0.1:${await web.listen()}`;
const browser = await chromium.launch(
  process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {},
);

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.log(`FAIL  ${message}`);
};
const pass = (message) => console.log(`PASS  ${message}`);

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
async function audit(page, label) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  if (violations.length === 0) return pass(`axe: ${label}`);
  for (const v of violations) {
    fail(`axe: ${label} — ${v.id} (${v.impact}) ×${String(v.nodes.length)}: ${v.help}`);
    for (const node of v.nodes.slice(0, 2)) {
      console.log(`        ${node.target.join(' ')}\n        ${node.html.slice(0, 140)}`);
      console.log(`        ${(node.any[0] ?? node.all[0] ?? node.none[0])?.message ?? ''}`);
    }
  }
}
const settle = (page) => page.waitForTimeout(400);

async function run(viewport, name) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  for (const path of ['/sign-in', '/sign-up', '/forgot-password']) {
    await page.goto(`${base}${path}`);
    await page.getByRole('heading', { level: 1 }).waitFor();
    await settle(page);
    await audit(page, `${path} [${name}]`);
  }
  await page.goto(`${base}/sign-in`);
  await page.getByLabel('Email').fill('a11y@test.dev');
  await page.getByLabel('Password').fill('pw-a11y-1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'));
  await page.getByRole('heading', { level: 1 }).first().waitFor();

  const screens = [
    ['/', 'Home', null],
    ['/library', 'Library', 'Parasite'],
    ['/genres', 'Genres', 'Thriller'],
    ['/discover', 'Discover', 'Pick another'],
    ['/stats', 'Stats', 'Watchlist backlog'],
    ['/settings', 'Settings', 'Account'],
  ];
  for (const [path, label, waitFor] of screens) {
    await page.goto(`${base}${path}`);
    if (waitFor)
      await page.getByText(waitFor, { exact: false }).first().waitFor({ timeout: 15000 });
    await settle(page);
    await audit(page, `${label} [${name}]`);
  }

  // Dialogs: detail, add, edit.
  await page.goto(`${base}/library`);
  await page.getByRole('link', { name: /^Parasite/ }).click();
  await page.getByRole('dialog').waitFor();
  await settle(page);
  await audit(page, `title details dialog [${name}]`);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByRole('link', { name: /Add movie/ }).click();
  await page.getByRole('dialog').waitFor();
  await settle(page);
  await audit(page, `add title dialog [${name}]`);
  await page.keyboard.press('Escape');
  await context.close();
  if (errors.length) fail(`page errors [${name}]: ${errors.join(' | ')}`);
}

await run({ width: 390, height: 844 }, 'phone 390px');
await run({ width: 1280, height: 800 }, 'desktop 1280px');

// --- Keyboard behaviours -------------------------------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${base}/sign-in`);
  await page.getByLabel('Email').fill('a11y@test.dev');
  await page.getByLabel('Password').fill('pw-a11y-1');
  await page.keyboard.press('Enter');
  await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'));
  await page.goto(`${base}/library`);
  await page.getByRole('link', { name: /^Parasite/ }).waitFor();

  // Skip link is the first stop and lands on main content.
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => document.activeElement?.textContent?.trim());
  first === 'Skip to content'
    ? pass('first Tab stop is the skip link')
    : fail(`first Tab stop was "${first}"`);
  await page.keyboard.press('Enter');
  const inMain = await page.evaluate(
    () => document.activeElement?.id === 'main-content' && location.hash === '',
  );
  inMain
    ? pass('the skip link jumps to the main content')
    : fail('skip link did not move focus to main without adding a history entry');

  // Opening a title from the keyboard: focus goes into the dialog, stays there, Escape returns it.
  const card = page.getByRole('link', { name: /^Parasite/ });
  await card.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await page.waitForTimeout(300);
  const insideOnOpen = await page.evaluate(
    () => document.activeElement?.closest('[role="dialog"]') !== null,
  );
  insideOnOpen
    ? pass('focus moves into the dialog when it opens')
    : fail('focus stayed behind the dialog');
  let escaped = false;
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(
      () => document.activeElement?.closest('[role="dialog"]') !== null,
    );
    if (!inside) {
      escaped = true;
      break;
    }
  }
  escaped
    ? fail('Tab moved focus out of the open dialog')
    : pass('Tab stays inside the open dialog (25 presses)');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  // React restores focus a moment after the dialog leaves the page; give it that moment.
  await page
    .waitForFunction(
      () => document.activeElement?.closest('a[href^="/library/"]') !== null,
      undefined,
      {
        timeout: 3000,
      },
    )
    .catch(() => undefined);
  const back = await page.evaluate(() => document.activeElement?.textContent?.slice(0, 40));
  /Parasite/.test(back ?? '')
    ? pass('closing the dialog returns focus to the title that opened it')
    : fail(`focus went to "${back}" after closing`);
  await context.close();
}

// --- Reflow: no sideways scrolling at 320 px (WCAG 1.4.10) ----------------------------------
{
  const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
  const page = await context.newPage();
  await page.goto(`${base}/sign-in`);
  await page.getByLabel('Email').fill('a11y@test.dev');
  await page.getByLabel('Password').fill('pw-a11y-1');
  await page.keyboard.press('Enter');
  await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'));
  for (const path of ['/', '/library', '/genres', '/discover', '/stats', '/settings']) {
    await page.goto(`${base}${path}`);
    await page.waitForTimeout(700);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    overflow <= 0
      ? pass(`no horizontal scrolling at 320px: ${path}`)
      : fail(`${path} is ${String(overflow)}px wider than a 320px screen`);
  }
  // Every section tab must be visible without scrolling the navigation row sideways.
  const navHidden = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Primary"]');
    return nav ? nav.scrollWidth - nav.clientWidth : -1;
  });
  navHidden === 0
    ? pass('all five section tabs fit at 320px')
    : fail(`the section tabs overflow their row by ${String(navHidden)}px at 320px`);
  await context.close();
}

await browser.close();
await supabase.close();
await web.close();
console.log(
  failures === 0
    ? '\nAll accessibility checks passed.'
    : `\n${String(failures)} accessibility problem(s).`,
);
process.exit(failures === 0 ? 0 : 1);
