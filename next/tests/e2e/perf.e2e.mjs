// Real-Chromium performance probe with a LARGE library (default 5,000 titles) against the
// production build, with the CPU slowed down to roughly a mid-range phone.
//
//   npm run perf                      (not part of `npm run check`; CI runs it as a budget check)
//   PERF_TITLES=3000 PERF_CPU=6 npm run perf
//
// It prints a table and fails when a budget is exceeded. The budgets are deliberately generous:
// they catch a regression to "the page freezes", not a few milliseconds.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createFakeSupabase, movieRow } from './fakeSupabase.mjs';
import { createStaticServer } from './staticServer.mjs';

const appRoot = resolve(import.meta.dirname, '../..');
const TITLES = Number(process.env.PERF_TITLES ?? 5000);
const CPU = Number(process.env.PERF_CPU ?? 4);

const GENRES = ['Drama', 'Thriller', 'Comedy', 'Sci-Fi', 'Crime', 'Animation', 'Horror', 'Romance'];
const WORDS = [
  'Dark',
  'Night',
  'Last',
  'Silent',
  'River',
  'Winter',
  'Golden',
  'Lost',
  'City',
  'Road',
];
// A fixed pseudo-random order so runs are comparable.
let seed = 12345;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const work = mkdtempSync(join(tmpdir(), 'cv-perf-'));
const supabase = createFakeSupabase();
const user = supabase.addUser('perf@test.dev', 'pw-perf-1', []);
for (let i = 0; i < TITLES; i += 1) {
  const watched = rand() < 0.6;
  user.movies.push(
    movieRow(user.id, `${WORDS[i % 10]} ${WORDS[Math.floor(rand() * 10)]} ${String(i)}`, {
      media_type: rand() < 0.2 ? 'tv' : 'movie',
      year: 1950 + Math.floor(rand() * 76),
      genre: `${GENRES[Math.floor(rand() * 8)]}, ${GENRES[Math.floor(rand() * 8)]}`,
      runtime_minutes: 70 + Math.floor(rand() * 100),
      watched,
      watched_on: watched
        ? `20${String(15 + Math.floor(rand() * 11))}-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)}`
        : null,
      user_rating: watched ? Math.floor(rand() * 10) / 2 : null,
      created_at: new Date(Date.UTC(2020, 0, 1) + i * 3_600_000).toISOString(),
    }),
  );
}
const supabasePort = await supabase.listen();
execFileSync('npx', ['vite', 'build', '--outDir', join(work, 'app'), '--emptyOutDir'], {
  cwd: appRoot,
  stdio: 'pipe',
  env: {
    ...process.env,
    VITE_SUPABASE_URL: `http://127.0.0.1:${supabasePort}`,
    VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_perf_not_a_real_key_0000',
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
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

const rows = [];
const record = (name, ms, budget, note = '') =>
  rows.push({ name, ms: Math.round(ms), budget, note });
const nodes = () => page.evaluate(() => document.getElementsByTagName('*').length);
const heapMb = async () => {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Math.round((metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0) / 1e6);
};
await cdp.send('Performance.enable');
const timed = async (fn) => {
  const start = Date.now();
  await fn();
  return Date.now() - start;
};

try {
  await page.goto(base);
  await page.waitForURL('**/sign-in');
  await page.getByLabel('Email').fill('perf@test.dev');
  await page.getByLabel('Password').fill('pw-perf-1');
  const cold = await timed(async () => {
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'));
    await page.goto(`${base}/library`);
    await page.waitForFunction(
      (n) => document.body.innerText.includes(`${n} titles`),
      String(TITLES),
      {
        timeout: 120000,
      },
    );
  });
  record(`sign in → library of ${String(TITLES)} on screen`, cold, 30000);
  record('DOM nodes on the first page', await nodes(), 6000, 'count, not ms');

  // The saved copy is written after the first paint; wait for it, then time a reload from it.
  const dbName = (
    await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))
  ).find((n) => n?.startsWith('cinemavault-next:'));
  const savedAt = await timed(() =>
    page.waitForFunction(
      (name) =>
        new Promise((resolve) => {
          const open = indexedDB.open(name);
          open.onsuccess = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains('meta')) {
              db.close();
              resolve(false);
              return;
            }
            const get = db.transaction('meta').objectStore('meta').get('library');
            get.onsuccess = () => {
              db.close();
              resolve(Boolean(get.result));
            };
            get.onerror = () => {
              db.close();
              resolve(false);
            };
          };
          open.onerror = () => resolve(false);
        }),
      dbName,
      { timeout: 120000, polling: 250 },
    ),
  );
  record('saved copy complete after first paint', savedAt, 30000);

  // Search: type, then wait until the count reflects the filter.
  const search = page.locator('#library-search');
  const typed = await timed(async () => {
    await search.pressSequentially('dark night', { delay: 0 });
    await page.waitForFunction(
      (n) => {
        const m = document.body.innerText.match(/(\d+) of (\d+) titles/);
        return m !== null && Number(m[1]) < n;
      },
      TITLES,
      { timeout: 30000 },
    );
  });
  record('type "dark night" → filtered list shown', typed, 3000);
  await search.fill('');
  await page.waitForFunction(
    (n) =>
      document.body.innerText.includes(`${n} titles`) &&
      !/\d+ of \d+ titles/.test(document.body.innerText),
    String(TITLES),
    { timeout: 30000 },
  );

  // Show more x20 (48 each): the DOM grows; how much does it cost?
  const more = await timed(async () => {
    for (let i = 0; i < 20; i += 1) {
      const button = page.getByRole('button', { name: /Show more/ });
      await button.click();
    }
  });
  record('"Show more" ×20 (≈1,000 cards)', more, 20000);
  record('DOM nodes after ×20', await nodes(), 40000, 'count, not ms');
  record('JS heap after ×20 (MB)', await heapMb(), 400, 'MB');

  for (const [label, link, text, budget] of [
    ['open Statistics', 'Stats', 'Watchlist backlog', 8000],
    ['open Genres', 'Genres', 'Genres', 8000],
    ['open Discover', 'Discover', 'Pick another', 12000],
  ]) {
    const ms = await timed(async () => {
      await page
        .getByRole('navigation', { name: 'Primary' })
        .getByRole('link', { name: link, exact: true })
        .click();
      await page.waitForFunction((t) => document.body.innerText.includes(t), text, {
        timeout: 60000,
      });
    });
    record(`${label} (client-side navigation)`, ms, budget);
  }

  // Reload offline-ish: the saved copy is read back (no network): how long to first card?
  supabase.setDown(true);
  const reload = await timed(async () => {
    await page.goto(`${base}/library`);
    await page.waitForSelector('a[href^="/library/"]', { timeout: 60000 });
  });
  record('reload with the server unreachable → first card', reload, 15000, 'from the saved copy');
  supabase.setDown(false);
  record('page errors', errors.length, 0, 'count');
} finally {
  await browser.close();
  await supabase.close?.();
  await web.close?.();
}

let failed = 0;
console.log(`\n${String(TITLES)} titles, CPU ${String(CPU)}x slower, 390×844 viewport`);
for (const r of rows) {
  const ok = r.ms <= r.budget;
  if (!ok) failed += 1;
  console.log(
    `${ok ? 'ok  ' : 'OVER'}  ${r.name.padEnd(52)} ${String(r.ms).padStart(7)}   (budget ${String(r.budget)}${r.note ? `; ${r.note}` : ''})`,
  );
}
process.exit(failed === 0 ? 0 : 1);
