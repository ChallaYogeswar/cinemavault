# CinemaVault Next

Parallel TypeScript rewrite of CinemaVault. **The root-level app (`index.html`, `app.js`, `src/`, `api/`) is untouched and is still what production serves.** Nothing in `next/` writes to production, and `parseEnv` refuses a production Supabase project.

Stack: React 19 · Vite · TypeScript (strict) · Tailwind CSS v4 · React Router · TanStack Query · Zod · Supabase JS (auth + data) · Vitest + React Testing Library · PGlite (real PostgreSQL in tests).

## Which database does this talk to?

```
DEVELOPMENT ENVIRONMENT (today)
  CinemaVault Next ──► Development Supabase project
                         a rehearsal copy of the library, schema from /supabase/migrations

FUTURE PRODUCTION (not started; gated by /docs/release-checklist.md)
  CinemaVault Next ──► validated migration process ──► Production Supabase
                         backup verified · rehearsed on development · digests compared
                         schema fingerprint and RLS adversarial suite pass
```

Production is only ever **read** (the rehearsal script, `SELECT` only). Never put the production URL or key in `.env.local`; the app refuses it. M3 is real: sign-in, per-account cache isolation, owner/viewer roles from the `profiles` table, and Supabase repositories. They run against the **development** project only.

## Run it (independent of the old app)

```bash
cd next
npm ci                         # exact versions from package-lock.json
cp .env.example .env.local     # fill in a DEVELOPMENT Supabase project (not production)
npm run dev                    # http://localhost:5173
```

With no Supabase variables the dev server uses an in-memory mock backend (`VITE_DATA_SOURCE=mock` forces it, except when `VITE_APP_ENV=production`). Any other build without Supabase variables shows a configuration error instead of silently using mock data.

Quality gates (also run by CI in `.github/workflows/next-ci.yml`):

| Command                | What it checks                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`    | strict TypeScript (incl. `noUncheckedIndexedAccess`)                                                                                                        |
| `npm run lint`         | ESLint, type-aware, no floating promises                                                                                                                    |
| `npm run format:check` | Prettier                                                                                                                                                    |
| `npm test`             | unit, component, integration, real-Postgres contract, RLS adversarial and release-gate tests                                                                |
| `npm run build`        | production build                                                                                                                                            |
| `npm run check:bundle` | fails if a real server credential is in `dist/` (including `sw.js`)                                                                                         |
| `npm run e2e`          | real Chromium against the production build with a fake Supabase (Playwright is a devDependency; run `npx playwright install chromium` once; not in `check`) |
| `npm run perf`         | 5,000-title run in real Chromium (phone width, throttled CPU) with time budgets; not in `check`                                                             |
| `npm run a11y`         | axe on every screen and dialog (390 and 1280 px), skip link, dialog focus, 320 px reflow; not in `check`                                                    |
| `npm run check`        | typecheck + lint + format + tests                                                                                                                           |

## Run the old app

From the repository root, exactly as before, for example `python3 -m http.server 8000` and open http://localhost:8000. It has no build step and does not depend on `next/`.

## Environment variables

See `.env.example`. Only **public** values may use the `VITE_` prefix, because Vite ships them to every visitor.

| Variable                        | Required | Notes                                                                       |
| ------------------------------- | -------- | --------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL`             | yes      | https URL (http only for localhost) of the **development** project          |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | yes      | publishable/anon key only                                                   |
| `VITE_APP_ENV`                  | no       | `development` (default), `preview`, `production`                            |
| `VITE_DATA_SOURCE`              | no       | `mock` forces the in-memory backend; refused when `VITE_APP_ENV=production` |

`src/services/env.ts` refuses a service-role/secret key, any `VITE_*` variable named like a secret (`SERVICE_ROLE`, `SECRET`, `PRIVATE`, `PASSWORD`, `TMDB`) and the production project ref. The TMDB key stays server-side (`TMDB_API_KEY` in Vercel). `.env*` is git-ignored except `.env.example`.

## Layout

```
src/domain/       pure rules: movie model, validation (Zod), identity/duplicates, fail-closed permissions
src/data/         repository contract, mock + Supabase repositories, DB-row mappers, per-user cache keys
src/data/local/   the saved library on the device (Dexie, one database per account) and `loadLibrary`
src/pwa/          service-worker registration, update banner, install card
pwa/              service-worker template (the Vite plugin in vite-plugins/ fills in the file list and version)
src/services/     env validation, auth service
src/app/          providers: auth state machine, session/role, cache guard, router
src/features/     screens
src/components/   layout and shared UI
tests/            unit/ integration/ fakes/ e2e/ (browser run, `npm run e2e`)
scripts/          rehearse-migration.mjs, rls-adversarial.sql, schema-fingerprint.sql, check-bundle.mjs, generate-icons.mjs
```

## Offline and install (M4)

Signed in, the app saves your last loaded library on this device (one IndexedDB database per account). If the server
cannot be reached it shows that copy under a clear banner; adding, editing and deleting need a connection. Signing out
removes the saved copy. Production builds also install a service worker that keeps the app itself available offline
(the app shell only; no data). Details and limits: `/docs/architecture.md` (M4).

```bash
npm run build && npm run preview     # the worker only exists in production builds
npx playwright install chromium       # once (Playwright is a devDependency)
npm run e2e                           # or E2E_CHROMIUM_PATH=/path/to/chrome npm run e2e
```

The PNG icons in `public/icons` are committed. To regenerate them, run `node scripts/generate-icons.mjs` (uses the Playwright devDependency; see the file header).

## Database

`next/` does **not** own migrations. The single canonical history lives in `/supabase/migrations`; which file is the baseline and how to recover is in `/docs/migration-baseline.md`. Never delete, rename or edit a migration that has been applied to any remote project.

Verification you can run on the development project (both are read-only or roll back):

- `scripts/schema-fingerprint.sql` — compare two projects' schemas by hash.
- `scripts/rls-adversarial.sql` — 41 attacks as anon, viewer and owner; every line must start with `PASS`.
- `node scripts/rehearse-migration.mjs` — copy and verify the library on development (see `/docs/migration-plan.md`).

## Discover and posters (M5.1)

Posters, overviews and trailer links come from TMDB through `api/tmdb.ts`, a Vercel function. Set these **server** variables on the project that serves `next/` (none use the `VITE_` prefix, so none reach the browser):

| Variable                   | Value                                                                     |
| -------------------------- | ------------------------------------------------------------------------- |
| `TMDB_API_KEY`             | TMDB v3 API key or v4 read-access token                                   |
| `SUPABASE_URL`             | the project this deployment signs users in with                           |
| `SUPABASE_PUBLISHABLE_KEY` | that project's publishable key (the `VITE_` pair is accepted as fallback) |

**Vercel → Settings → General → Root Directory must be `next`.** The repository also contains the older `api/tmdb.js` (it hard-codes the production Supabase project), and which one is served depends on that setting. After deploying, run `npm run check:deployment -- https://<url> --token <access token>`: it fails with "Root Directory is not next" when the wrong proxy answers.

Without the key the app works as before with placeholder posters. See `docs/architecture.md` (M5.1) for what is kept on the device.

## Statistics, settings and Discover controls (M5.2)

`/stats` shows totals, ratings, watched-by-month/year, genres and the backlog (computed on the device, works offline). Settings now has display name, password change, "sign out of all devices" and controls for what the device keeps (suggestion history, hidden titles, saved posters). Discover has a Films/Series filter, "Not now" (hides a title for 7 days) and short fact-based explanations. See `docs/architecture.md` (M5.2).
