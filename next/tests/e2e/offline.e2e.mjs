// Real-Chromium end-to-end check of the M4 offline story, against the PRODUCTION build served the
// way a host serves it, with the service worker really installed and a fake Supabase server.
//
//   npx playwright install chromium     (once; CI does this with --with-deps)
//   npm run e2e                         (not part of `npm run check`)
//
// E2E_CHROMIUM_PATH=/path/to/chrome uses an existing browser instead of Playwright's own download.
//
// Offline is simulated twice over — Playwright's offline switch AND both servers dropping every
// connection — so a request from the page or from the service worker cannot sneak through.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFakeSupabase, movieRow } from './fakeSupabase.mjs';
import { createStaticServer } from './staticServer.mjs';

import { chromium } from 'playwright';
const appRoot = resolve(import.meta.dirname, '../..');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const within = async (promise, ms, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

function build(outDir, supabaseUrl, appEnv) {
  const viteCli = resolve(appRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  execFileSync(process.execPath, [viteCli, 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: appRoot,
    stdio: 'pipe',
    env: {
      ...process.env,
      VITE_SUPABASE_URL: supabaseUrl,
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_e2e_not_a_real_key_0000',
      VITE_APP_ENV: appEnv,
    },
  });
}

const work = mkdtempSync(join(tmpdir(), 'cv-e2e-'));
const supabase = createFakeSupabase();
const alice = supabase.addUser('alice@test.dev', 'pw-alice-1', [
  'Alice Film One',
  'Alice Film Two',
]);
alice.movies.push(
  movieRow(alice.id, 'Alice Pending', {
    watched: false,
    watched_on: null,
    user_rating: null,
    genre: 'Comedy',
  }),
);
const bob = supabase.addUser('bob@test.dev', 'pw-bob-1', ['Bob Film One']);
const bobPending = movieRow(bob.id, 'Bob Pending', {
  watched: false,
  watched_on: null,
  user_rating: null,
});
bob.movies.push(bobPending);
const supabasePort = await supabase.listen();
const supabaseUrl = `http://127.0.0.1:${supabasePort}`;

build(join(work, 'v1'), supabaseUrl, 'development');
build(join(work, 'v2'), supabaseUrl, 'preview'); // different bytes => a different worker version
// A stand-in for the /api/tmdb function: signed-in callers only, one known title.
const tmdbCalls = [];
const tmdbApi = (req, res, url) => {
  tmdbCalls.push({ path: url.pathname, query: url.search, auth: req.headers.authorization });
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!/^Bearer \S+$/.test(req.headers.authorization ?? ''))
    return json(401, { code: 'unauthenticated' });
  const query = url.searchParams.get('query') ?? '';
  const known = query === 'Alice Film One';
  return json(200, {
    results: known
      ? [
          {
            id: 4242,
            media_type: 'movie',
            title: query,
            release_date: '2020-05-05',
            poster_path: '/alice1.jpg',
            overview: 'A film about Alice, from TMDB.',
            vote_average: 7.7,
          },
        ]
      : [],
  });
};
const web = createStaticServer(join(work, 'v1'), tmdbApi);
const webPort = await web.listen();
const base = `http://127.0.0.1:${webPort}`;

const browser = await chromium.launch(
  process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {},
);
const context = await browser.newContext();
// 1x1 PNG standing in for image.tmdb.org (the sandbox has no route to the real host).
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const imageRequests = [];
await context.route('https://image.tmdb.org/**', (route) => {
  imageRequests.push(route.request().url());
  return route.fulfill({ contentType: 'image/png', body: PIXEL });
});
const page = await context.newPage();
const consoleErrors = [];
page.on('pageerror', (error) => consoleErrors.push(String(error)));
if (process.env.E2E_VERBOSE) {
  page.on('console', (m) => console.log(`  [console.${m.type()}] ${m.text().slice(0, 200)}`));
  page.on('requestfailed', (r) =>
    console.log(`  [request failed] ${r.url().slice(0, 100)} ${r.failure()?.errorText}`),
  );
}

const offline = async () => {
  supabase.setDown(true);
  web.setDown(true);
  await context.setOffline(true);
};
const online = async () => {
  supabase.setDown(false);
  web.setDown(false);
  await context.setOffline(false);
};
const text = (selector = 'body') => page.locator(selector).innerText();
const has = async (needle) => (await text()).includes(needle);
const waitText = (needle, ms = 15000) =>
  page.waitForFunction((n) => document.body.innerText.includes(n), needle, { timeout: ms });
const waitGone = (needle, ms = 15000) =>
  page.waitForFunction((n) => !document.body.innerText.includes(n), needle, { timeout: ms });
const swReady = () =>
  page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    return navigator.serviceWorker.controller !== null;
  });
const databases = () =>
  page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).filter(Boolean));
const cacheDump = () =>
  page.evaluate(async () => {
    const out = {};
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      out[name] = {};
      for (const request of await cache.keys()) {
        out[name][new URL(request.url).pathname] = await (await cache.match(request)).text();
      }
    }
    return out;
  });
const idbRows = (dbName, store) =>
  page.evaluate(
    ([name, table]) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(table)) {
            db.close();
            resolve(null);
            return;
          }
          const all = db.transaction(table).objectStore(table).getAll();
          all.onsuccess = () => {
            db.close();
            resolve(all.result);
          };
          all.onerror = () => reject(all.error);
        };
      }),
    [dbName, store],
  );
const signIn = async (email, password) => {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in')); // Home, or where we came from
  await page.goto(`${base}/library`);
};

try {
  // --- 1. Online: sign in, library loads, worker installs --------------------------------
  await page.goto(base);
  await page.waitForURL('**/sign-in');
  await signIn('alice@test.dev', 'pw-alice-1');
  await waitText('Alice Film One');
  check(
    'online sign-in shows the library',
    (await has('Alice Film Two')) && !(await has('as saved')),
  );
  check('no "saved copy" banner while online', !(await has('showing your library as saved')));

  // --- 1b. Posters: looked up through the proxy with the user's token, kept on the device ---
  await page.waitForSelector('a[href^="/library/"]:has(h3:text-is("Alice Film One")) img', {
    timeout: 15000,
  });
  await page.waitForFunction(
    () => {
      const img =
        [...document.querySelectorAll('a[href^="/library/"]')]
          .find((a) => a.querySelector('h3')?.textContent === 'Alice Film One')
          ?.querySelector('img') ?? null;
      return img !== null && img.complete && img.naturalWidth > 0;
    },
    undefined,
    { timeout: 15000 },
  );
  const poster = await page.evaluate(() => {
    const img =
      [...document.querySelectorAll('a[href^="/library/"]')]
        .find((a) => a.querySelector('h3')?.textContent === 'Alice Film One')
        ?.querySelector('img') ?? null;
    return {
      src: img.src,
      drawn: img.complete && img.naturalWidth > 0,
      policy: img.referrerPolicy,
    };
  });
  check(
    'poster from the TMDB proxy is drawn over the placeholder (small size, no referrer)',
    poster.src === 'https://image.tmdb.org/t/p/w342/alice1.jpg' &&
      poster.drawn &&
      poster.policy === 'no-referrer',
    JSON.stringify(poster),
  );
  check(
    'only the proxy was asked, with the user’s token, for allowed paths',
    tmdbCalls.length > 0 &&
      tmdbCalls.every(
        (c) =>
          c.path === '/api/tmdb' &&
          /^Bearer \S+$/.test(c.auth ?? '') &&
          c.query.startsWith('?path=%2Fsearch%2Fmulti&query='),
      ),
    JSON.stringify(tmdbCalls.slice(0, 2)),
  );
  const aliceDbName = `cinemavault-next:${alice.id}`;
  await page.waitForFunction(
    (name) =>
      new Promise((resolve) => {
        const open = indexedDB.open(name);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('metadata')) {
            db.close();
            resolve(false);
            return;
          }
          const count = db.transaction('metadata').objectStore('metadata').count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result >= 3);
          };
        };
      }),
    aliceDbName,
    { timeout: 15000 },
  );
  check('lookups are kept on the device, in Alice’s own database', true);
  const callsBeforeReload = tmdbCalls.length;

  await page.reload(); // the first load is not controlled; this one is
  await waitText('Alice Film One');
  await page.waitForSelector('a[href^="/library/"]:has(h3:text-is("Alice Film One")) img', {
    timeout: 15000,
  });
  check(
    'after a reload the poster comes from the device: no new proxy calls',
    tmdbCalls.length === callsBeforeReload,
    `${callsBeforeReload} -> ${tmdbCalls.length}`,
  );
  check('service worker installed and controlling the page', await swReady());

  const aliceDb = `cinemavault-next:${alice.id}`;
  check(
    'library saved on the device in Alice’s own database',
    (await databases()).includes(aliceDb),
  );

  const dump = await cacheDump();
  const shellNames = Object.keys(dump);
  check(
    'exactly one shell cache, named after the version',
    shellNames.length === 1 && /^cv-shell-[0-9a-f]{12}$/.test(shellNames[0]),
  );
  const stored = JSON.stringify(dump);
  const session = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('cinemavault-next-auth')),
  );
  const secrets = [
    'Alice Film',
    'Alice Pending',
    'alice@test',
    alice.id,
    session.access_token,
    session.refresh_token,
  ];
  check(
    'Cache Storage holds the app shell only — no titles, email, user id or session tokens',
    secrets.every((secret) => !stored.includes(secret)),
  );
  check(
    'shell includes index.html and the bundle',
    '/index.html' in dump[shellNames[0]] &&
      Object.keys(dump[shellNames[0]]).some((p) => p.startsWith('/assets/')),
  );

  const listed = JSON.parse(
    /const PRECACHE = (\[.*?\]);/s.exec(await (await fetch(`${base}/sw.js`)).text())[1],
  );
  await page.goto(`${base}/settings?probe=1`); // ordinary navigations must not add entries
  const keysNow = Object.keys((await cacheDump())[shellNames[0]]).sort();
  check(
    'shell cache holds exactly the precache list — nothing added by browsing',
    JSON.stringify(keysNow) === JSON.stringify([...listed].sort()),
    keysNow.join(','),
  );
  await page.goto(`${base}/library`);
  await waitText('Alice Film One');

  // --- 1c. Discover online: a suggestion appears and is remembered on the device -----------
  await page.goto(`${base}/discover`);
  await page.getByRole('button', { name: 'Pick another' }).waitFor({ timeout: 15000 });
  check(
    'Discover suggests the only unwatched title',
    (await page.getByRole('article', { name: 'Suggested title' }).locator('h2').innerText()) ===
      'Alice Pending',
  );
  await page.waitForFunction(
    (name) =>
      new Promise((resolve) => {
        const open = indexedDB.open(name);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('history')) {
            db.close();
            resolve(false);
            return;
          }
          const count = db.transaction('history').objectStore('history').count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result >= 1);
          };
        };
      }),
    aliceDbName,
    { timeout: 10000 },
  );
  const history = await idbRows(aliceDbName, 'history');
  check(
    'what Discover showed is remembered on the device (ids and genres, no titles)',
    history.length >= 1 && !JSON.stringify(history).includes('Alice Pending'),
    JSON.stringify(history),
  );

  // "Not now" hides the only suggestion for a week, saves that on the device (no titles), and can be undone
  await page.getByRole('button', { name: 'Not now' }).click();
  await page.getByText('Everything that fits is hidden for now').waitFor({ timeout: 10000 });
  const snoozed = await idbRows(aliceDbName, 'snoozed');
  check(
    '"Not now" is remembered on the device as an id and a time, never a title',
    snoozed.length === 1 && !JSON.stringify(snoozed).includes('Alice Pending'),
    JSON.stringify(snoozed),
  );
  await page.getByRole('button', { name: 'Show hidden titles' }).click();
  await page.getByRole('button', { name: 'Pick another' }).waitFor({ timeout: 10000 });
  check(
    'showing hidden titles brings the suggestion back',
    (await idbRows(aliceDbName, 'snoozed')).length === 0,
  );

  // Statistics: computed from the library
  await page.goto(`${base}/stats`);
  await page.getByRole('heading', { name: 'Your taste, in numbers.' }).waitFor({ timeout: 15000 });
  await waitText('Watched, last 12 months');
  check(
    'Statistics page shows the library totals',
    (await text()).toLowerCase().includes('in the vault') && (await has('Watchlist backlog')),
  );
  await page.goto(`${base}/library`);
  await waitText('Alice Film One');

  // --- 2. Offline reload: the app opens and shows the saved library ----------------------
  await offline();
  await page.reload();
  await waitText('Alice Film One');
  await waitText('showing your library as saved');
  check('offline reload opens the app (service worker) and shows the saved library', true);
  check(
    'offline: banner says it is a saved copy and that writes need a connection',
    await has('need a connection'),
  );
  const addVisible = await page.getByRole('link', { name: /add/i }).count();
  check('offline: add entry point is hidden', addVisible === 0, `found ${addVisible}`);
  await page.goto(`${base}/settings`);
  await waitText('Keep the vault yours');
  check('offline: a deep link to another route also opens', true);
  await page.goto(`${base}/discover`);
  await page.getByRole('button', { name: 'Pick another' }).waitFor({ timeout: 15000 });
  check(
    'offline: Discover still suggests from the saved library, and says it is a saved copy',
    (await page.getByRole('article', { name: 'Suggested title' }).locator('h2').innerText()) ===
      'Alice Pending' && (await has('showing your library as saved')),
  );
  await page.goto(`${base}/stats`);
  await page.getByRole('heading', { name: 'Your taste, in numbers.' }).waitFor({ timeout: 15000 });
  await waitText('Watchlist backlog');
  check(
    'offline: Statistics still works from the saved library',
    (await text()).toLowerCase().includes('in the vault'),
  );
  await page.goto(`${base}/library`);
  await waitText('Alice Film One');

  // --- 3. Another device changes data; this one catches up on reconnect -------------------
  alice.movies[0].title = 'Alice Film One (renamed on device A)';
  alice.movies[0].updated_at = '2026-11-03T10:00:00.000000+00:00';
  alice.movies.push(movieRow(alice.id, 'Alice Film Three'));
  await page.goto(`${base}/library`).catch(() => undefined);
  await page.waitForTimeout(500);
  check(
    'offline: still the old saved copy (no invented data)',
    (await has('Alice Film One')) && !(await has('Alice Film Three')),
  );
  await online();
  await page.getByRole('button', { name: 'Try again' }).first().click();
  await waitText('Alice Film Three');
  await waitGone('showing your library as saved');
  check(
    'back online: device A’s rename and add arrive; banner clears',
    (await has('renamed on device A')) && (await has('Alice Film Three')),
  );
  alice.movies = alice.movies.filter((m) => m.title !== 'Alice Film Two');
  await page.reload();
  await waitText('Alice Film Three');
  check('a deletion on device A disappears here after a reload', !(await has('Alice Film Two')));

  // --- 4. Expired access token while offline: still restored from the saved copy ----------
  await page.evaluate(() => {
    const raw = localStorage.getItem('cinemavault-next-auth');
    const session = JSON.parse(raw);
    session.expires_at = Math.floor(Date.now() / 1000) - 600;
    localStorage.setItem('cinemavault-next-auth', JSON.stringify(session));
  });
  await offline();
  await page.reload();
  await within(waitText('Alice Film Three', 40000), 45000, 'expired-token offline restore');
  check(
    'expired token + offline: the saved library still opens',
    await has('showing your library as saved'),
  );
  check('…and the device is still signed in as Alice', (await databases()).includes(aliceDb));
  await online();

  // --- 5. Server revokes the session: the next online start signs out and wipes the copy --
  supabase.revokeSessions('alice@test.dev');
  await page.reload();
  await page.waitForURL('**/sign-in', { timeout: 30000 });
  await page.waitForFunction(
    (name) => indexedDB.databases().then((d) => !d.some((x) => x.name === name)),
    aliceDb,
    { timeout: 10000 },
  );
  check(
    'revoked session: signed out and Alice’s saved library wiped',
    !(await databases()).includes(aliceDb),
  );
  check('revoked session: no private text left on the sign-in page', !(await has('Alice Film')));

  // --- 6. Sign out, switch account: nothing of Alice reaches Bob --------------------------
  await signIn('alice@test.dev', 'pw-alice-1');
  await waitText('Alice Film Three');
  await page.goto(`${base}/settings`);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL('**/sign-in');
  await page.waitForFunction(
    (name) => indexedDB.databases().then((d) => !d.some((x) => x.name === name)),
    aliceDb,
    { timeout: 10000 },
  );
  check('sign-out wipes the saved library', !(await databases()).includes(aliceDb));
  check(
    'sign-out removes the stored session',
    await page.evaluate(() => localStorage.getItem('cinemavault-next-auth') === null),
  );

  await offline();
  await page.reload();
  await page.waitForURL('**/sign-in');
  check('offline after sign-out: sign-in page, never a library', !(await has('Alice Film')));
  await online();

  await signIn('bob@test.dev', 'pw-bob-1');
  await waitText('Bob Film One');
  const bobDb = `cinemavault-next:${bob.id}`;
  const names = await databases();
  check('Bob sees only Bob’s titles', !(await has('Alice')));
  await page.goto(`${base}/discover`);
  await page.getByRole('button', { name: 'Pick another' }).waitFor({ timeout: 15000 });
  check(
    'Bob’s Discover suggests Bob’s title and shows nothing of Alice’s history',
    (await page.getByRole('article', { name: 'Suggested title' }).locator('h2').innerText()) ===
      'Bob Pending' && !(await has('Alice')),
  );
  await page.goto(`${base}/library`);
  await waitText('Bob Film One');
  check(
    'only Bob’s database exists on the device',
    names.includes(bobDb) && !names.some((n) => n.includes(alice.id)),
  );
  await offline();
  await page.reload();
  await waitText('showing your library as saved');
  check(
    'offline as Bob: Bob’s saved library, nothing from Alice',
    (await has('Bob Film One')) && !(await has('Alice')),
  );
  await online();
  await page.reload();
  await waitText('Bob Film One');
  await waitGone('showing your library as saved');

  // --- 7. A new deploy: offered, never forced, applied on request -------------------------
  web.setRoot(join(work, 'v2'));
  const before = Object.keys(await cacheDump());
  await page.evaluate(() => {
    window.__controllerBefore = navigator.serviceWorker.controller;
    window.__scriptBefore = document.querySelector('script[src]')?.getAttribute('src');
  });
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration.update();
  });
  await waitText('A new version of CinemaVault is ready');
  const waitingState = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return {
      sameController: navigator.serviceWorker.controller === window.__controllerBefore,
      controllerState: navigator.serviceWorker.controller?.state,
      newWorkerWaiting: registration?.waiting != null,
      sameScript:
        document.querySelector('script[src]')?.getAttribute('src') === window.__scriptBefore,
    };
  });
  check(
    'new deploy: the old version keeps running until asked (same controller, new worker only waiting, same bundle)',
    waitingState.sameController &&
      waitingState.controllerState === 'activated' &&
      waitingState.newWorkerWaiting &&
      waitingState.sameScript,
    JSON.stringify(waitingState),
  );
  const stillOld = Object.keys(await cacheDump());
  check(
    'new shell downloaded next to the old one (two shell caches while waiting)',
    stillOld.length === 2,
    stillOld.join(','),
  );
  let navigations = 0;
  const countNavigation = (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  };
  page.on('framenavigated', countNavigation);
  await page.getByRole('button', { name: 'Reload' }).click();
  // Done = one cache left AND the reloaded page shows the library; then let anything late settle.
  await page.waitForFunction(
    () =>
      caches.keys().then((k) => k.length === 1 && document.body.innerText.includes('Bob Film One')),
    null,
    { timeout: 20000 },
  );
  await page.waitForTimeout(1500);
  page.off('framenavigated', countNavigation);
  check(
    'the update reloads the page exactly once',
    navigations === 1,
    `navigations: ${navigations}`,
  );
  await waitText('Bob Film One');
  const after = Object.keys(await cacheDump());
  check(
    'after Reload: only the new shell cache remains',
    after.length === 1 && after[0] !== before[0],
    `${before} -> ${after}`,
  );
  check('the library survives an app update', await has('Bob Film One'));
  check('banner gone after the update', !(await has('A new version of CinemaVault is ready')));

  // --- 8. No credentials in what we ship --------------------------------------------------
  const sw = await (await fetch(`${base}/sw.js`)).text();
  check('sw.js contains no keys, tokens or emails', !/eyJ|sb_|bob@|alice@|access_token/.test(sw));

  check(
    'no uncaught page errors during the run',
    consoleErrors.length === 0,
    consoleErrors.join('\n'),
  );
} catch (error) {
  check(`run aborted: ${error instanceof Error ? error.message : String(error)}`, false);
  await page.screenshot({ path: join(work, 'failure.png'), fullPage: true }).catch(() => undefined);
  console.error('Failure screenshot:', join(work, 'failure.png'));
  console.error(
    'Page text at failure:\n' + (await text().catch(() => '(unavailable)')).slice(0, 600),
  );
} finally {
  await browser.close();
  await web.close();
  await supabase.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed === 0) rmSync(work, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}
