# CinemaVault Next — architecture

Source of truth: the blueprint (`cinemavault_upgrade.md`). This file records what is **actually built** and the decisions that matter.

## Status

| Milestone                                                     | State                                                                                                                                                                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 Foundation                                                 | Built: app shell, typed domain, validation, fail-closed permissions, env validation, CI                                                                                                  |
| M2 UI                                                         | Built on a mock repository (no production connection): library, cards, search/filter/sort, add/edit/delete, rating with clear, view-only mode, loading/empty/error states, phone layouts |
| M3 Data (Supabase repositories, Dexie cache, import adapters) | Not started — contract only (`data/repositories/movieRepository.ts`)                                                                                                                     |
| M4 Security & recovery                                        | Not started                                                                                                                                                                              |
| M5 Cutover                                                    | Not started                                                                                                                                                                              |

## Layers

`features/` (UI) → `data/repositories` (contract) → `data/mappers` / `data/local` → `services/` (Supabase, TMDB proxy). `domain/` is pure TypeScript and depends on nothing.

## Decisions

1. **Parallel app in `next/`.** The root app stays deployable and unchanged until cutover.
2. **One migration history** at `/supabase/migrations`. `next/` never adds a second set.
3. **Online-first.** The cloud is canonical; the local cache speeds reads and is scoped per user (`cacheDatabaseName`). No offline editing in M1–M3.
4. **Authorization lives in Postgres RLS.** `resolveRole`/`can` only decide what the UI shows, and they fail closed.
5. **Results, not exceptions, for mutations** (`domain/result.ts`): every write has a defined failure state (`forbidden`, `conflict`, `network`, ...).
6. **Optimistic concurrency.** Updates carry `expectedUpdatedAt`; a mismatch is a `conflict`, never a silent overwrite.
7. **Soft deletes propagate.** Records are tombstoned (`deletedAt`) so other devices remove them.
8. **Identity** is `(owner, normalizedTitle, mediaType, year)` with `normalizeTitle` byte-compatible with the old app (pinned by parity tests).
9. **Secrets** never use the `VITE_` prefix; TMDB stays behind a server proxy.

## Not yet decided (needs an owner decision before M3)

- Whether to add `NULLS NOT DISTINCT` to the identity index (see migration-plan F2).
- Conflict UX: prompt the user vs. keep-newest with an audit entry.

## M2: what the UI is built on

- **Nothing in M2 reaches Supabase, the network or browser storage.** Screens depend only on the `MovieRepository` contract through `useMovieRepository()`. `data/mock/` holds an in-memory implementation that enforces the same rules the real one must: viewer writes are `forbidden`, input is re-validated, duplicate identity is rejected, updates and deletes are version-checked, delete is a soft delete and frees the identity.
- **Mock session.** `app/session.ts` supplies a role; Settings → "Preview as" switches it. The mock repository reads the role on every call, so view-only is enforced by the repository as well as hidden in the UI. M3 swaps in the real profile through `resolveRole` (fail-closed) and the Supabase repository; no screen changes.
- **Preview flags** (mock data only, read once at startup): `?scenario=empty|error|slow|large` (large = 3,243 synthetic titles, the production scale) and `?as=viewer`.
- **URL is state.** Filters live in the query string (`?q=&type=&status=&rating=&genre=&sort=`); invalid values fall back to defaults. Dialogs are routes (`/library/new`, `/library/:id`, `/library/:id/edit`), so they deep-link and the back button closes them.
- **Two kinds of `conflict`**, told apart by `AppError.reason`: `duplicate_identity` (shown on the Title field) and `stale_version` (shown as an explicit choice: load latest, or overwrite deliberately).
- **The edit form keeps the version it opened with**, never the live cache. A background refresh must not silently re-base a form, or a stale save would overwrite another device's change. A regression test covers this.
- **Rendering budget.** The grid renders 48 cards and grows by "Show more". Measured in Chromium on 3,243 titles: first render about 0.8 s, 48 cards in the DOM, re-filter about 50–100 ms. The production JS bundle is 523 kB (163 kB gzip) and Vite warns above 500 kB. Route-level code splitting is deferred until the real data layer lands.
- Posters are deterministic placeholders; since M5.1 a TMDB poster is drawn over them when one is available (see M5.1).

## M2 hardening (review round 2)

- **Cache integrity.** A successful create, update or delete never seeds the library cache. It cancels any in-flight list request (whose snapshot predates the write), patches the cache only if one already exists, and always refetches. Opening `/library/new` and saving before the first list arrives can no longer produce a one-title library, even briefly. The regression test records every state the cache ever holds, so a transient bad state fails it even if a refetch would repair it.
- **One navigation guard.** `useUnsavedChangesGuard` sits on the router (`useBlocker`) plus `beforeunload`, so Escape, the close button, a backdrop click, Cancel, browser Back and Forward, links elsewhere in the app, and closing the tab all go through a single confirmation. Tested for each, in three cases (stay, leave, nothing typed).
- **Overwrite after a conflict** is never silent and never against an unseen version. Before retrying it re-fetches the stored record, validates it with the full record schema, and compares it with the version the banner described. If it changed again, nothing is saved and the new differences are shown. A failed lookup is reported as a failure, not as "deleted"; a deleted title is never resurrected. The banner lists which fields changed elsewhere and which the user edited. The repository's own version check still guards the final write.
- **Private cache is scoped by account.** Private queries are keyed `['u', userId, …]` (`app/privateKey.ts`). `PrivateCacheGuard` cancels and removes every private query that belongs to another account when the session's user changes, and the mock gives each account its own repository. Tests cover: separate data per account, the old account's cache removed from memory, and loading (not stale titles) shown during the switch.

### M3 must carry these forward

1. The real session supplies `userId` from the authenticated user; sign-out must call `queryClient.clear()` and clear the Dexie cache (`cacheDatabaseName(userId)` already scopes it).
2. The Supabase repository's `update`/`remove` must put `expectedUpdatedAt` in the `WHERE` clause and treat zero affected rows as `stale_version` (or `not_found` after a follow-up read). The overwrite flow relies on this to close the gap between its read and its write.
3. Keep `?scenario=` previews and the mock repository after the real data layer lands, for regression tests (per review). They are selected only in the mock provider, never in production wiring.
4. Authorization remains Postgres RLS. The keys, guard and role checks here are convenience and hygiene, not security.

## M3: a real backend behind the same interface

- **Backend selection** (`services/env.ts → resolveBackend`). `supabase` when the configuration is valid; `mock` only when explicitly requested (`VITE_DATA_SOURCE=mock`, refused when `VITE_APP_ENV=production`) or on the dev server with _no_ Supabase variables at all; otherwise `misconfigured`, which renders an error instead of quietly showing sample data. A non-production build pointed at a production project ref is rejected by `parseEnv` (`PRODUCTION_PROJECT_REFS`).
- **Authentication** (`services/auth`, `app/auth`). `AuthService` is the only thing that knows about Supabase Auth; changes arrive through `subscribe` only. The adapter never awaits inside `onAuthStateChange`, holds a `SIGNED_IN` for one tick so `PASSWORD_RECOVERY` can win (the library is never flashed to someone choosing a new password), and signs out with `scope: 'local'`. `AuthProvider` is a four-state machine (`loading | signed_out | recovery | signed_in`). Sign-in errors are generic; sign-up for an existing address looks identical to a new one. The return-to path after sign-in is an allow-list.
- **Authorization.** On a real backend the role is loaded from `profiles` through `resolveRole`, which fails closed: a missing row, a failed request or an unexpected shape all mean `viewer`, the app waits for the first answer, and an unverified role shows an alert with Retry. The repository also checks the role before any request. Postgres RLS is the actual control.
- **Repository** (`data/supabase`). Implements `MovieRepository` unchanged. Lists by keyset pagination on `id` (the server caps a response at 1,000 rows), `update`/`remove` are single statements guarded by `updated_at = expected`, and zero affected rows is diagnosed as `not_found`, `stale_version` or `forbidden`. A row that fails the strict mapper fails the whole list loudly.
- **Timestamps are opaque.** `updated_at` is the version token and Postgres keeps microseconds; JavaScript `Date` does not. Values are passed through verbatim and only validated. (3,156 of the 3,251 production rows carry sub-millisecond stamps.)
- **Identity.** Production holds two spellings of `normalized_title` (finding F9). Duplicate checks compare `comparableTitle()` (lower-case, accent-free, letters and digits only); updates never rewrite a stored `normalized_title` unless the title itself changed.
- **Account isolation.** An `ActiveUserStore` outside React carries the current account and an `epoch` that increases on every change (A→B→A are different sessions). `attachPrivateCacheGuard` removes foreign private queries synchronously, `queryClient.clear()` runs on sign-out, and a cache-event backstop removes any private entry that appears for a non-active user. Every mutation captures its origin; `guarded()` refuses to send if the session already ended and discards the result if it ends while the request is in flight (`session_changed`). The signed-in tree is keyed by user id.
- **Testing layers.** One repository contract runs on the mock, on a PostgREST emulator and on real Postgres (PGlite with the real migrations and RLS). Auth and account switching run through the full production wiring with fake services. Real-Supabase checks run on the development project (below and `migration-plan.md`).

## M3.1: review fixes

### Environments (read this before pointing anything at a database)

```
DEVELOPMENT (what exists today)
  CinemaVault Next (next/) ──► Development Supabase project (rgcicevuflinfhalyomp)
                                 · a rehearsal COPY of the library, never the real one
                                 · schema built from supabase/migrations

FUTURE PRODUCTION (not done; gated by docs/release-checklist.md)
  CinemaVault Next ──► validated migration process ──► Production Supabase (qhopjfqpnmoinggejgvt)
                          · backup taken and verified
                          · rehearsed on development, digests compared
                          · schema fingerprint and RLS adversarial suite pass

TODAY, PRODUCTION IS ONLY EVER READ (by the rehearsal script, with SELECT) AND IS STILL SERVED
BY THE UNCHANGED ROOT APP.  `parseEnv` refuses a production project ref.
```

### Role refresh during a live session

The database (row-level security) is the real authority, so a stale role in the UI is a usability
problem, never a security bypass. The UI follows the database like this:

| When                                                | What happens                                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Sign-in, reload, session restoration                | The profile is read; the app shows "Checking your permissions…" until it answers                            |
| Tab regains focus and the answer is > 60 s old      | Read again in the background (React Query `staleTime` 60 s, `refetchOnWindowFocus`)                         |
| A write is refused by the server as `forbidden`     | The profile is invalidated and re-read at once, so the UI drops to viewer without waiting                   |
| The person presses "Refresh permissions" (Settings) | Read again immediately                                                                                      |
| Any read fails, or the row is missing or malformed  | **Viewer**, with a visible "couldn't verify your permissions" notice and Retry (`resolveRole` fails closed) |

A demoted owner's UI can stay stale in a tab that is never left (no focus event fires), but the first refused
write corrects it at once, and switching away and back after a minute does too. Changing it sooner is a
trade-off against polling the profile table; polling was deliberately not added. A promotion appears on the same triggers. Tests: `tests/integration/roleRefresh.test.tsx`.
The `isCurrent()` guard on that invalidate is defence in depth (sign-out already clears the cache) and is not
independently provable by a test.

### Duplicate detection: who is the authority

1. **The database unique index is the final authority**:
   `(owner_id, normalized_title, media_type, year) WHERE deleted_at IS NULL`.
2. `findDuplicate` in the repository is a friendly early warning that names the existing title. It now pages through
   **every** candidate with the same media type and year (keyset on `id`, `MAX_PAGES` cap with an explicit error),
   so a library with more than 1,000 candidates in one year no longer hides a duplicate. Tested with 1,300 candidates.
3. Known gaps the index alone does not close (decisions pending): year-less titles are distinct to the index
   (F2, `NULLS NOT DISTINCT`), and stored `normalized_title` values use two spellings (F9, backfill).
4. Before the library grows beyond a personal/shared one: store one canonical normalized title, compute it with a
   single database function used by both the index and the client, and cover the intended rules in one unique index.

### `list()` under concurrent writes

`list()` pages by `id` (keyset), not by offset or by sort order. A row that exists for the whole listing appears
exactly once. It is **not a snapshot**: a row inserted, soft-deleted or edited mid-listing may or may not be seen,
depending on where its id falls relative to the cursor, and the reconcile step after every write refetches. The
previous comment claimed more than that. Tested in `tests/unit/supabaseConcurrency.test.ts` (inserts, soft-deletes and
edits between pages over 2,300 rows; the `MAX_PAGES` guard with an endless stub).

## M4: online-first, with a saved copy for reading offline

Scope, as set in the M4 request: **online-first writes, cached offline reads.** There is no offline editing, no mutation
queue, no conflict-resolution UI and no tombstone sync. Every write needs the server, and the server (RLS plus the
`expectedUpdatedAt` version check) stays the only authority.

### The saved library (`src/data/local`)

- **One IndexedDB database per account**: `cinemavault-next:<user-uuid>` (Dexie, `version(1)`: `movies` keyed by `id`,
  `meta` keyed by `key`). Isolation is structural: Account B's code never opens A's database, so there is no
  "filter by user" to get wrong.
- **One snapshot, replaced atomically.** `write` clears and refills `movies` and writes `meta`
  `{formatVersion, userId, savedAt, count, checksum}` in a single transaction. There is no partial library on disk.
- **Reads distrust the disk.** `read` returns a snapshot only if the format version matches, `userId` matches the database
  it was found in, `count` matches, every row passes `movieSchema`, a 53-bit checksum over **every persisted field** of every
  row (rows in id order, fields in schema order, JSON-encoded so `null` and `"null"` differ) matches, the snapshot is not
  older than 30 days (`MAX_CACHE_AGE_MS`) and not dated more than 5 minutes in the future. On any doubt the database is
  **deleted** and `null` is returned; the app simply loads from the server. Movie rows with **no** meta record are also doubtful
  (our own writes commit both together) and are deleted; a database with neither is just "no copy" and is left alone. Cache
  methods never throw. The checksum catches accidental damage; it is not tamper-proof (whoever can edit IndexedDB can edit the
  checksum beside it), which is why the copy is not a security boundary (T23).
- **Ordering.** Saves are fire-and-forget; a per-account generation counter plus a monotonic `takenAt` mean a slow, older
  answer can never overwrite a newer snapshot (found by the cross-device test, fixed, mutation-tested).
- **Schema changes** bump `CACHE_FORMAT_VERSION` or the Dexie version. Because the snapshot is disposable (the server has
  everything), the migration for a format change is "discard and reload", which is what an unknown version already does.

Format history: **1** (checksum over `id:updatedAt` only) was replaced by **2** (all fields) in M4.1; a version-1 snapshot is
discarded and reloaded, as any unknown version is.

### Loading (`loadLibrary`)

The server's answer wins and replaces the saved copy. Only a **network** failure (or the server not answering within 8 s
when a copy exists) falls back to the saved copy. `forbidden`, `unauthenticated`, `unknown` and `validation` are **never**
papered over with old data. The origin (`network` or `cache`, plus `savedAt`) lives in its own private query
(`librarySourceKey`) so the movie data keeps its type. While the saved copy is shown a gold status banner says so, with the
age and a _Try again_ button, and Add / Edit / Delete / rate are hidden (`useWriteAccess`). A form that was already open is
never taken away. Coming back online refetches immediately (`refetchOnReconnect: 'always'`).

`createQueryClient` sets `networkMode: 'always'` for queries and mutations. The TanStack default would _pause_ a query while
the browser reports offline (the saved copy would never be offered) and would _queue_ a mutation made offline and replay it
later, which is an accidental offline write queue. Neither is wanted. The Supabase client is created with `db.retry: false`:
PostgREST's own back-off (1 + 2 + 4 s) stacked on the app's retry made an offline start-up take about 15 s; the app's single
retry, skipped when `navigator.onLine` is false, is now the only one.

### Who is "signed in" when the server cannot be asked

At start-up supabase-js refreshes an expired token over the network. Offline that fails, and it reports `INITIAL_SESSION`
with no session while leaving the stored session in place. `readStoredIdentity` (zod-validated `{user:{id,email?},
refresh_token}` from the auth storage key) lets the app carry on as that account, read-only, from that account's saved copy.
It **authorizes nothing**: role is unverified (viewer), writes are hidden and refused, and the first successful contact
with the server decides. A revoked session ends in sign-out and a wipe (covered in the browser test).

### When the saved copy is removed

| Event                                                 | What happens                                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Sign-out (`actions.signOut`)                          | `retainOnly(null)`: every saved library on the device is deleted                                                   |
| Server ends the session (definitive `user === null`)  | same                                                                                                               |
| Active account changes (A → B)                        | `retainOnly(B)`: A's database is deleted                                                                           |
| App start with no answer from auth yet                | **nothing** — the store is null before auth answers; wiping here would delete the very copy offline start-up needs |
| Corrupt, unknown-version, expired or foreign snapshot | that account's database is deleted on read                                                                         |

### Service worker and PWA (`pwa/sw.template.js`, `vite-plugins/pwa.ts`, `src/pwa`)

- **App shell only.** Precache = every hashed JS/CSS file, icons, manifest and `index.html`, listed exactly by a Vite plugin
  after the bundle is written (`dist/sw.js`); the version is a hash of those files, the cache is `cv-shell-<version>`.
- **Never caches at run time.** Navigations go network-first and fall back to the saved `index.html` only when the network
  itself fails (a 4xx/5xx from the server is shown as is). Precached files are served from the cache. Everything else —
  non-GET, cross-origin (Supabase, fonts, TMDB), `/api/*` — is untouched. Nothing a server returned is ever written to Cache
  Storage, so an auth redirect with a code, a token or a library can never land there (asserted in unit tests and by scanning
  Cache Storage in Chromium).
- **Install is atomic and activation is the user's choice.** A shell file that fails (or redirects) fails the whole install and
  the old worker keeps running. There is no automatic `skipWaiting`: the page shows "A new version … is ready — Reload", and only
  that button sends `SKIP_WAITING`; the page reloads on the resulting `controllerchange`. The first install claims the page
  silently and never reloads it. Activation deletes older `cv-shell-*` caches. Updates are checked when the app returns to the
  foreground and hourly.
- **Registration only in production builds**, so `vite dev` is never served stale code.
- **Install support**: manifest (`id`, PNG icons 192/512, maskable 512, SVG), `apple-touch-icon`, iOS meta tags; the browser's
  install prompt is held back and offered as an _Install app_ button in Settings.
- **Hosting contract** (`next/vercel.json`): `sw.js`, `index.html` and the manifest are `no-cache`; real files are served before the
  SPA rewrite. A host that long-caches `sw.js` breaks updates.
- **Kill switch.** To remove the worker from every device, deploy a `sw.js` that deletes `cv-shell-*` caches and calls
  `registration.unregister()`; devices pick it up on the next update check.

### Cross-device behaviour (Device A → Cloud → Device B)

Tested on real Postgres (PGlite with the repo's migrations and RLS): each device has its own IndexedDB and connection. Add,
edit, rating change and delete on A reach B after B's next load; a device that was away catches up and its stale saved copy
never wins over the server; B's stale edit is refused with a conflict; a viewer on another device sees the owner's changes;
and a UI-level two-device flow passes. Version tokens (`updatedAt`) are treated as opaque.

### Limits to know

- First ever open still needs one online visit (the worker and the library have to be fetched once).
- Fonts come from Google Fonts and are not cached; offline the system font stack is used. Posters and trailer links need a network the first time (they are kept on the device afterwards); _Discover_ itself works from the saved library.
- Browsers may evict site storage (Safari after about 7 days without use for non-installed sites). The app then behaves as a
  first visit: it needs the network once.
- Single JS chunk of ~877 kB (261 kB gzip), up from Dexie. Not split yet.
- Real Supabase Auth and a real flight-mode toggle have not been run from the build sandbox; the browser test uses a fake
  Supabase server and drops every connection. The offline start-up path relies on supabase-js behaviour that is verified in
  Chromium against that fake and by reading the library source, so it needs the manual check in `release-checklist.md`.

## M5.1: Discover, posters and recommendations

No database or schema change: posters and TMDB details are looked up at run time and kept per account on the device.

### Recommendations (`src/domain/recommend.ts`, pure)

- Eligible = not watched and not deleted. Global mode picks a genre by weight, then a title; genre mode is uniform inside the genre.
- Genre weight = `max(0.05, backlog^0.6 × 0.42^min(recent picks of that genre, 3))`, where "recent" is the last 12 suggestions. Titles shown in the last 6 are avoided.
- `avoid` (titles already shown on this visit) is a soft preference, relaxed in tiers; `current` (the title on screen) is never repeated unless it is the only candidate. Both are injected, as is the random source, so tests are exact and statistical.
- A title with no genre belongs to "Uncategorized". A genre with nothing left falls back to the balanced pick.

### On the device (`src/data/local/deviceData.ts`, `dexieLibraryCache.ts`, schema v2)

- Same per-account database as the saved library, two new tables: `history` (movie id, genres, kind, time; newest 40) and `metadata` (key → value, newest 6,000).
- They are wiped with the database (sign-out, revocation, account change). A saved library that fails validation deletes the whole database, history and lookups included: they are conveniences, never sources of truth.
- Metadata keys contain library titles, so they are private exactly like the library; history holds ids and genres only.
- Every method is total: no IndexedDB, a full disk or a wiped account is "nothing saved", never an exception.

### TMDB (`api/tmdb.ts`, `src/services/tmdb`)

- **Proxy** (Vercel function). `TMDB_API_KEY`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` are server variables (the `VITE_` pair is accepted as a fallback). The sign-in check goes to _this deployment's own_ project (not a hard-coded one), is remembered for 60 s per token (hashed), and answers 503 — not 401 — when the auth server cannot be reached.
- Allow-list: `GET /search/multi` (`query` 1-100 characters, `page` 1-5, `language`; **exactly one** `path` parameter) and `GET /(movie|tv)/<id>/videos`. Unknown, repeated or invalid parameters are rejected; `include_adult=false` is forced. A 401/403 from TMDB (our key is wrong) is reported as 502 so the browser never mistakes it for "signed out". The key is redacted from any answer, never put in a URL when a v4 token is used, and the user's token is never sent to TMDB.
- **Client** (`tmdbClient`): zod-validates answers and drops malformed entries, keeps movies and shows only, maps failures to `signed_out | not_configured | rate_limited | unavailable`.
- **Lookup service** (`metadataService`): 30-day cache for a found title, 7 days for "nothing found", failures are never stored; at most 4 requests at once; identical requests share one flight (per account). A caller's `AbortSignal` only ends _that caller's wait_: the shared request is never cancelled by one subscriber leaving (a closed detail view must not take the poster from the card still waiting for the same lookup), and its answer is still stored; after `not_configured` it stops asking for 5 minutes and after `rate_limited` for 30 seconds. Trailers are looked up only on demand (detail view, Discover), never in bulk.
- **UI**: `Poster` always draws the placeholder first and puts the image over it, so a blocked, slow or offline image leaves a good card. `useMovieMetadata` keeps lookups under the account's private query key and turns every failure into "no poster".
- Images load straight from `image.tmdb.org` with `referrerpolicy=no-referrer`. The service worker ignores cross-origin requests, so they are never cached. TMDB sees the visitor's IP address and which poster files are requested.

### Screens

- **Discover**: one suggestion with its reason, overview and trailer link, "Pick another", genre chips (only genres with something unwatched), and "Suggested lately". Reads the library only, so it works from the saved copy offline. A suggestion that was watched or deleted meanwhile is replaced by a notice.
- **Genres**: every genre with its total and unwatched counts, links to the filtered library (`/library?genre=`) and to Discover (`/discover?genre=`).
- **Home** shows the backlog and a Discover shortcut. It never records a suggestion.

### Limits to know

- Sample-data mode (no Supabase) has no history, lookups or posters.
- The proxy has no rate limiting of its own beyond TMDB's.
- There is no Content-Security-Policy yet (`img-src` would need `image.tmdb.org`); tracked for the hardening milestone.
- Stats, Settings/profile, performance with 3,000+ titles, accessibility, deployment rehearsal and Capacitor packaging are later M5 steps.

### M5.1.1: review fixes

- **Which proxy is deployed.** The repository holds two: `next/api/tmdb.ts` (this app) and the older root `api/tmdb.js`, which hard-codes the _production_ Supabase project. Vercel serves the one that sits under the project's **Root Directory**, which must be `next` for CinemaVault Next. The new proxy marks every answer with `X-CinemaVault-Proxy: next-1`; `npm run check:deployment -- <url> [--token <jwt>]` fails when that marker is missing ("Root Directory is not `next`"), and then checks 401 without a token, 200 with one, and 400 for a bad path, a duplicate `path` and an extra parameter. The legacy file is untouched: the old app still uses it.
- **Matching** (`src/services/tmdb/title.ts`). A TMDB result is accepted only if its title (any of title, name, original title, original name) is the same title once accents, punctuation, `&` and a leading article are ignored (letter-pair Dice ≥ 0.9), or close (≥ 0.75) _and_ released in the entry's year. Among acceptable results: right year, then right kind (film/series), then has a poster, then closer title, then TMDB's order. No convincing match means the placeholder, remembered as "nothing found" for 7 days. The library entry is never changed by a TMDB match; the detail view shows "Matched on TMDB as …" whenever TMDB's title differs. Cache keys are now `tmdb:v2:<title>|<year>|<kind>` so no match made by the older rule survives.
- **Answer size** is counted in bytes while streaming, refused early on `Content-Length`, and reading stops at the limit.

## M5.2: statistics, settings and Discover controls

### Statistics (`src/domain/stats.ts`, `src/features/statistics`)

`computeStats(library, now)` is a pure function over the library the app already holds, so the page works from the saved copy offline. Deleted titles are ignored everywhere. Watched-by-month covers exactly the last 12 months (oldest first, zeros included); a watched title without a readable `watchedOn` is counted as watched but left out of the date charts rather than guessed. Ratings outside 0–5 or non-numeric are ignored; the average is to one decimal. Every figure is printed as text; the bars are decoration (`aria-hidden`).

### Settings and profile

- **Display name** (`src/domain/profile.ts`): trimmed, repeated spaces collapsed, empty means "none", at most 40 visible characters, and control, zero-width and bidi-override characters are _refused_ (not silently stripped). ZWJ/ZWNJ stay allowed (emoji, Indic and Persian scripts). Saved through `ProfileRepository.updateDisplayName`, which asks for the row back so a refused update (row-level security answers "0 rows") is reported as an error instead of "saved". Tested against real RLS in PGlite: own row only, the role column cannot be changed.
- **Password**: change in place (same validation as recovery) or send a reset link. Neutral wording for the link.
- **Sign out of all devices**: `signOut({ scope: 'global' })`. This device is always signed out and wiped, whatever the server said; the result only reports whether the other devices could be told.
- **On this device**: shows and clears the suggestion history, the hidden titles, and the saved poster/trailer lookups. `MetadataService.clear` also bumps a per-account epoch so a lookup already in flight does not write its answer back after "clear".

### Discover controls (`src/features/discover`, `src/domain/recommend.ts`)

The engine's own rules are unchanged. The hook narrows the library _before_ the engine sees it:

- **Films / Series** (`?type=movie|tv` also accepted); a genre that has nothing left in the chosen type is dropped, not silently ignored; counts exclude hidden titles.
- **Not now**: hides a title for 7 days. Stored per account in IndexedDB schema **v3** (`snoozed`: `movieId`, `until`; ids and a time only). Expired rows are deleted on the next write; capped at 500. Works for the current visit even where the device keeps nothing.
- **Stale history**: entries older than 30 days, unreadable, or dated in the future (wrong clock) no longer steer picks or appear under "Suggested lately".
- **Why this one**: up to three facts derived from the library (time on the list, how much of the genre is watched, runtime for films). Nothing is invented.
- Empty states say what is going on (no unwatched series; everything hidden) and offer the way out.

## M5.3: large libraries, error screens and accessibility

### Measured (`npm run perf`, 5,000 titles, 390 px wide, 4x CPU throttle, headless Chromium)

| Step                                               | Result                             |
| -------------------------------------------------- | ---------------------------------- |
| Typing a search                                    | about 0.6 s                        |
| "Show more" pressed 20 times                       | 8.4 s before; 5.8–6.8 s after memo |
| Reload from the saved copy                         | about 2.2 s                        |
| Sorting, searching, statistics, checksum (compute) | a few milliseconds each            |

The cost was rendering, not computing, so the fixes are in rendering: `MovieCard` is `memo`-ised (an unchanged title is not re-rendered when another is added to the page) and the list stays paged ("Show more") instead of virtualised. Virtualisation was not needed at 5,000 titles and would have complicated keyboard and screen-reader navigation; revisit if real-device numbers say otherwise. The script's budgets are loose on purpose (they catch a regression, not a 10% change).

### Screens load on first use

Discover, Genres, Statistics, Settings and the add/edit dialogs are lazy routes (`lazy:` in `src/app/router.tsx`); Home, Library and the detail dialog stay in the first download. The service worker precaches every emitted JavaScript file, so a lazy screen still opens offline (covered by the offline E2E). One vendor chunk is still above 500 kB; splitting it is a later, measured change.

### When a screen fails (`src/app/RouteError.tsx`)

A render error or a failed chunk download shows an alert with Reload and "Go to home". It sits inside the shell, so the navigation still works. The page shows no message, stack or path; the details go to the console only.

### Accessibility (`npm run a11y`)

- Cards: the link's accessible name is its visible text (title, year, genre); badges are `aria-hidden`; status (series, watched / to watch, rating) is visually hidden text after the title. This satisfies label-in-name; tests find cards with `tests/cardName.ts`.
- Statistics tiles use a valid description list; the brand link is named by its text.
- Skip link moves focus to `<main tabindex="-1">` without a history entry. A `#main-content` entry made Back (and so closing a title dialog) leave focus on the page body.
- Phone navigation: the five sections share one row equally and fit at 320 px; with very large text the row scrolls rather than clips.
- Not covered by automation: reading order, wording, and real screen-reader behaviour. See the manual items in the release checklist.

## M6: transfer, offline editing, cutover tooling, hardening

### Export / import (`src/domain/transfer.ts`, `src/features/settings`)

JSON (canonical field order, SHA-256 over the content) and CSV export; CSV cells that start with `= + - @ tab CR` are prefixed so a spreadsheet shows text, not a formula. Import reads JSON or CSV (an `.xlsx` must be saved as CSV first), builds a **preview** (new, duplicates incl. the F9/F2 spellings, invalid rows with reasons, JSON checksum result) and then only **adds** via `createMany`. Limits: 5 MB, 10,000 rows. Nothing is merged, overwritten or deleted by importing.

### Offline editing (`src/domain/outbox.ts`, `src/data/sync`, `src/features/sync`)

Online-first stays the rule. A write is **queued on the device** only when (a) the server cannot be reached, or (b) the screen is showing the saved copy, or (c) that title already has a queued change (order must be kept).

- **One entry per title** (`coalesce`): create+edit → one create; create+delete → nothing; edit+edit → one edit with the *oldest* base version and the newest values; edit+delete → one delete. An entry waiting for a decision refuses further changes to that title.
- **Idempotent replay** (`flushOutbox`): a create carries a client-generated id (a repeat is a primary-key conflict that is recognised as "already saved"); an edit/delete carries `baseUpdatedAt` and is refused by the server if the title moved on; an edit whose values the server already holds is treated as done (lost reply); deleting something already gone is done. Only connection problems stop a run; a change the server refuses is kept as **"Needs review"** and never blocks the rest. If the title changed again *while* sending, the newer change stays and is re-based.
- **Never overwrites silently.** A conflict becomes a decision in the "Sync issues" dialog: *Keep my version* (re-sent against the server's current version) / *Use the other version* (discard mine). Duplicates and deleted-elsewhere have their own wording.
- **Display only:** the queue is laid over the list by a `select` in `useMoviesQuery`; the loaded and saved copies stay server-pure, so optimistic data is never persisted as if confirmed.
- **When it runs** (`SyncProvider`): on start, on `online`, when the tab becomes visible, every 30 s while changes wait, and after each queued change; never when `navigator.onLine` is false; one sender at a time (one follow-up run at most).
- **Storage:** Dexie schema v4 adds `outbox` (keyed by title id) and `session` (last confirmed role) to the per-account database, so both are wiped with it. A damaged or expired saved *library* no longer takes the queue with it.
- **Offline role:** the last role the server confirmed is kept (max 30 days) and used **only** when the role lookup fails with a network error; any other failure is still fail-closed (viewer). It is a UI convenience: RLS decides at replay.
- **Sign-out:** with unsent changes the sign-out asks first. A sign-out ended by the *server* (revoked session) still wipes the account's database, queue included — see decision in `release-checklist.md`.

### Cutover tooling (`scripts/data-gate.mjs`, `scripts/rehearsal-lib.mjs`, `docs/cutover-runbook.md`)

A read-only integrity gate (13 hard checks and 3 informational notes, the same duplicate rule as the app) with optional "identical to this backup" proof; the existing rehearsal tool copies, reads back and compares every field on the **development** project only. The runbook turns these into go/no-go rows, a timed cutover table, a smoke test and a rollback table.

### Hardening (`docs/hardening.md`)

Content-Security-Policy and headers from one module (`security/policy.mjs`, synced into `vercel.json`, enforced in the E2E); TMDB proxy rate limits (per address, per user; per instance); third-party code split into five cached vendor files with size budgets in `check:bundle`; an app-level `ErrorBoundary` and a scrubbed, pluggable `errorReporter` hook (no vendor wired).
