# Release checklist — blockers first

## Blockers (all must pass; no exceptions)

**Data integrity**

- [ ] Library exported and database backup taken; restore rehearsed
- [ ] Import rehearsal: row counts, ids, ratings, watched dates, tombstones and metadata match the baseline in `migration-plan.md`
- [ ] Zero duplicate groups; zero out-of-range ratings; zero watched/date inconsistencies
- [ ] Deleted records stay deleted across two devices
- [ ] Concurrent-edit test: a stale update returns `conflict` and changes nothing

**Permissions**

- [ ] RLS test suite passes against a copy of production policies (owner, viewer, anonymous, second user)
- [ ] A viewer cannot write by any route (UI, direct API call, stale cache)
- [ ] Unknown/failed role resolves to viewer
- [ ] Sign-out then sign-in as another account shows none of the previous library

## Quality

- [ ] `npm run check` and `npm run build` green in CI
- [ ] Playwright flows: sign-in, browse, add/edit/delete (owner), read-only (viewer), sign-out
- [ ] Lighthouse/PWA audit; keyboard and screen-reader pass
- [ ] Performance: 3,000+ titles scroll smoothly on a mid-range phone (try `?scenario=large` while on mock data)
- [ ] Real-browser layout pass at 320, 390, 768 and 1280 px: no horizontal scroll, tap targets at least 40 px, the floating "Add movie" button sits inside the viewport (jsdom cannot catch this; see F8)
- [ ] Every state reviewed in a browser: loading, empty, load error, no results, view-only, validation errors, edit conflict

## Deployment

- [ ] Environment validated in preview (`VITE_*` only; no secrets in the bundle)
- [ ] Previous deployment kept and rollback rehearsed
- [ ] Monitoring/error reporting live; first-hour checks scheduled

## M3 gates (data layer)

- [ ] Full-library rehearsal: `rehearse-migration.mjs --apply` on the dev project reports "every row, field and timestamp matches"; keep the backup file and report
- [ ] Backup replay (`--from-backup`) into an emptied dev project also matches
- [ ] All exported rows load through `rowToMovie` with no rejection
- [ ] Production counts, latest `updated_at` and migration list unchanged after the rehearsal (read-only check)
- [ ] Decisions recorded: F1 (root fail-open role), F2 (`NULLS NOT DISTINCT`), F6 (hide `next/`), F9 (normalized_title backfill), F10 (title cleanup)
- [ ] Two real devices: edit on one, confirm the other reports a conflict instead of overwriting
- [ ] Recovery email link works end to end on the preview URL (redirect URL allow-listed in Supabase Auth)
- [ ] Sign out with an unsaved form open: the choice (discard or stay) is understood and acceptable

## M3.1 gates (from the M3 review)

- [x] Migration history compared with production, canonical baseline chosen, nothing deleted: `docs/migration-baseline.md`
- [x] Fresh-database build tested (PGlite from the literal files in CI; Supabase replay in a rolled-back transaction)
- [ ] **Before cutover:** `supabase db reset` (or a fresh scratch project) with the literal files, then compare `next/scripts/schema-fingerprint.sql`
- [x] RLS adversarial suite: 41/41 on the development project and in CI (`next/scripts/rls-adversarial.sql`)
- [ ] **Before cutover:** run the suite again on the target project after the migration, never on production data
- [x] Release gate: sign-in A → data → sign-out → reload → sign-in B shows nothing of A (`releaseGate.test.tsx`)
- [ ] **Before cutover:** the same flow by hand with two real accounts on the preview URL (real Supabase Auth; the sandbox cannot reach it)
- [x] Role refresh strategy documented and tested
- [x] Multi-page list under concurrent writes and the `MAX_PAGES` guard tested
- [x] Duplicate scan covers every candidate; the database index is documented as the final authority

## M4 gates (cached reads, cross-device, PWA)

- [x] Saved library is per account, validated on read, replaced atomically, wiped on sign-out / revocation / account change
- [x] Offline start-up shows the saved copy with a visible banner; writes are hidden and online-only
- [x] Release gate extended to IndexedDB: sign-out → reload → other account leaves nothing of A anywhere
- [x] Cross-device: add, edit, rating, delete, a device that was away, a stale edit, a viewer — on real Postgres
- [x] Service worker unit-tested in isolation and mutation-tested (16 + 5 mutants)
- [x] Real Chromium against the production build: install, offline reload, expired token offline, revoked session, account switch, update flow, Cache Storage scan (`npm run e2e`, 32 checks; also the `e2e` CI job)
- [x] `check:bundle` also scans `sw.js`
- [ ] **Before cutover:** see the `e2e` job of `next-ci` pass on GitHub (added in M4.1; it has not run on GitHub yet)
- [ ] **Before cutover, by hand, on the preview URL with real Supabase and real flight mode:** sign in → open library → airplane mode → reload → banner and library appear → airplane mode off → banner clears; then sign out and confirm DevTools → Application shows no `cinemavault-next:*` database
- [ ] **Before cutover, by hand:** install the app (Chrome desktop or Android), open it offline; on iOS use Share → Add to Home Screen
- [ ] **Before cutover:** confirm the host serves `sw.js` and `index.html` with `Cache-Control: no-cache` (`next/vercel.json`)
- [ ] Decide whether to split the 877 kB bundle (Dexie added ~100 kB) before cutover

## M4.1 gates (from the M4 review)

- [x] Movie rows with no meta record are deleted; an empty database is just "no copy" (regression tests, mutation-tested)
- [x] Snapshot checksum covers every persisted field; format version 2; a change to each field is detected
- [x] Playwright is a pinned devDependency (1.64.1, in the lockfile); the E2E script no longer relies on a global install
- [x] The disabled E2E assertion is replaced by a real one (same controller, new worker only waiting, same bundle) and shown to fail when activation is forced
- [x] `pwaStore.start()` teardown removes every listener it adds and clears the hourly check, including when stopped before registration resolves
- [ ] **A green run of `next-ci` (both jobs) on GitHub.** Not possible from the build sandbox; the workflow is committed in the zip

## M5.1 gates (Discover, TMDB, posters, recommendations)

- [x] Recommendation rules ported from the old engine as a pure module, statistically tested, `current` never repeats
- [x] History and lookups live in the account's own database; release gate scans them in IndexedDB; sign-out wipes them
- [x] TMDB proxy: auth against the deployment's own project, allow-lists, key never exposed, mutation-tested
- [x] Posters never break a card (offline, blocked, malformed, unknown title, service not set up)
- [x] Discover, Genres and Home covered in integration tests and in real Chromium (online and offline)
- [ ] **Before cutover:** set `TMDB_API_KEY` (and `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, or rely on the `VITE_` pair) in Vercel for the `next/` project, redeploy, and open a title: a real poster must appear. The sandbox cannot reach TMDB, so the real service has not been exercised
- [ ] **Before cutover:** confirm `/api/tmdb` answers 401 without a token and 200 with one on the preview URL
- [ ] **Before cutover:** decide whether a Content-Security-Policy is wanted (`img-src` must allow `image.tmdb.org`)

## M5.1.1 gates (from the M5.1 review)

- [ ] **P1, before any preview or cutover:** the Vercel project that serves CinemaVault Next has **Root Directory = `next`**. Only one project exists today (`cinemavault`, serving the old app from the repository root, so it uses the legacy `api/tmdb.js`). Create a separate project for `next/` rather than changing that one
- [ ] **P1:** `npm run check:deployment -- https://<preview-url> --token <access token of a test user on THAT project's Supabase>` passes all six checks. It fails with "Root Directory is not next" if the legacy proxy is answering
- [x] Duplicate / missing `path` is a 400 (regression tests, mutation-tested)
- [x] Result matching rejects unconvincing titles; remakes resolved by year; film vs series; "Matched on TMDB as …" shown
- [x] Shared lookups survive one subscriber leaving (unit + integration)
- [x] Answer size measured in bytes, streamed, with early refusal
- [ ] Confirm on the preview with real TMDB: a handful of real titles (a remake, a series, a title with punctuation) show the right poster. The sandbox cannot reach TMDB, so thresholds (0.9 / 0.75) are tuned on constructed cases only

## M5.2 gates (statistics, settings, Discover controls)

- [x] Statistics computed by a pure, tested module; empty library, deleted titles, bad dates and bad ratings handled
- [x] Display name: validation, own-row-only update proven on real RLS (PGlite), role cannot change
- [x] Password change and reset link; sign out of all devices; this device always signed out
- [x] Clear suggestion history / saved lookups / hidden titles; in-flight lookups cannot undo a clear
- [x] Films/Series filter, "Not now" (IndexedDB v3, tested upgrade from v2), stale-history cutoff, fact-based explanations
- [x] Statistics and "Not now" checked in real Chromium, online and (statistics) offline
- [ ] **Manual:** "Sign out of all devices" with two real browsers on the real project: the second must be signed out after its next refresh
- [ ] **Manual:** change the password on a preview with real Supabase; confirm whether the project requires re-authentication ("secure password change") and that the error message is clear
- [ ] **Moved to M5.3 (below):** performance run, accessibility audit, production deployment rehearsal; Android packaging stays deferred

## M5.3 gates (large libraries, accessibility, mobile navigation)

- [x] `npm run perf`: 5,000 titles, phone width, 4x CPU throttle: sign-in to library, saved copy complete, search typing, "Show more", reload from the saved copy, all inside the script's budgets (numbers in `docs/architecture.md`, M5.3)
- [x] Library cards are memoised; secondary screens and the add/edit dialogs load on first use and are precached, so they still open offline
- [x] A screen that fails to render or load shows a recoverable error (Reload, Go home) inside the shell, with no technical detail on screen
- [x] `npm run a11y`: axe (WCAG 2.0/2.1/2.2 A and AA) on every screen and dialog at 390 px and 1280 px, zero violations; skip link; dialog focus in, trapped, and returned to the opener; no sideways scrolling at 320 px; all five section tabs visible at 320 px
- [x] Card accessible names contain their visible text (WCAG label-in-name); status ("Watched", rating) is read after the title
- [x] Skip link no longer adds a history entry (it used to make Back, and so closing a dialog, drop keyboard focus)
- [ ] **Manual:** screen-reader pass (VoiceOver on iPhone, TalkBack on Android, NVDA on Windows): sign in, add a title, open and close a title, Discover, Settings. Automated rules find only part of the problems; this is not replaced by `npm run a11y`
- [ ] **Manual:** the same 5,000-title run on a real mid-range phone (the script throttles a desktop CPU, which is an approximation)
- [ ] **Manual:** production deployment rehearsal on a Vercel preview of `next/` (Root Directory `next`): follow `docs/deployment-rehearsal.md` (check:deployment, sign in, PWA install, flight mode, rollback)
- [ ] **Deferred on purpose:** Android packaging, until the web release has passed the manual items above
