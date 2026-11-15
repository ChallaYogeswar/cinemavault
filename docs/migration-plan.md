# Migration plan and audit findings

## Rules

- No production data or schema is changed by `next/` work. Experiments use a separate Supabase project or branch.
- Never run two independent writers against the same library unless identity and mutation rules are identical.
- One canonical migration history: `/supabase/migrations`.

## Cutover steps

1. Protect the release: tag the deployed commit, export the library (JSON/CSV), take a database backup.
2. Build `next/` independently against a development project.
3. Verify compatibility: compare counts, ids, ratings, watched dates, tombstones and metadata; test restore.
4. Validate: unit, browser, role-based security and cross-device tests; confirm rollback.
5. Cut over by switching the production entry point; keep the previous deployment for rollback.

## Baseline measured on production (read-only, 2026-10-26)

| Check                                       | Result                           |
| ------------------------------------------- | -------------------------------- |
| Rows (all / live / tombstones)              | 3,251 / 3,243 / 8                |
| Live rows without a year                    | 59                               |
| Duplicate groups (with year / without year) | 0 / 0                            |
| Ratings outside 0–5                         | 0                                |
| `watched = false` with a watched date       | 0                                |
| `normalized_title` not trimmed/lowercase    | 0                                |
| Profiles / owners                           | 2 / 1                            |
| Rows in `movie_metadata`                    | 0 (posters were never persisted) |

Re-run these after every import or migration rehearsal; they are the data-integrity release gate.

## Findings to resolve before cutover

- **F1 — UI role fallback (R1).** The root app grants write UI when the profile cannot be read. Postgres RLS still blocks viewers, so this is a UX gap, not a data-loss path. It was a deliberate bridge while the roles migration was unapplied; the migration is now applied (2 profiles, 1 owner), so it can be removed from the root app when you approve a change there. `next/` already fails closed.
- **F2 — NULL years are not unique in the database.** `movies_owner_identity_idx` treats NULL years as distinct (confirmed with a PostgreSQL test), so two year-less duplicates are allowed; only the client prevents them. Production currently has none. Options: add `NULLS NOT DISTINCT` (PostgreSQL 15+) after verifying no existing duplicates, or keep the app-level rule.
- **F3 — Two initial-schema migrations** (`20260927000100_initial_schema`, `20261015175602_cinemavault_initial_schema`) exist locally and remotely. Both are idempotent and match the remote history list, so the histories agree; do not delete either. Document, don't rewrite.
- **F4 — Rating scale history.** The first migration allows 0–10, `align_movie_rating_scale` restricts to 0–5. `next/` uses 0–5.
- **F5 — Sync is last-write-wins** in the root app (R3). `next/` requires `expectedUpdatedAt`.
- **F6 — `next/` is publicly reachable.** The existing Vercel project serves the repository root, so `next/` source files will be reachable under `/next/`. There are no secrets in it, but if you prefer not to expose it, add a Vercel redirect/ignore rule (a root configuration change that needs your approval).

## Findings from M2

- **F7 – unvalidated `shot_link` in production.** The database has no constraint on this column and the old app never validated it. The new app validates on write and degrades bad values to plain text on read, but Measured read-only on production (2026-10-29): **0 live rows have a `shot_link` at all**, so nothing is affected today. Re-run the check before cutover in case the old app has been used since: `select count(*) from movies where shot_link is not null and btrim(shot_link) <> '' and shot_link !~* '^https?://'`.
- **F8 – `fixed` positioning and CSS transforms.** A forwards-filled animation left an identity `transform` on an ancestor, which made `position: fixed` relative to the page, not the viewport. This is invisible in jsdom. The animation now uses `backwards` fill. Keep the browser layout checks in the release checklist.
- **Decision for M3.** When a year-less duplicate is added, the application rule (F2) rejects it but the database index would not. The real repository must keep the application check until `NULLS NOT DISTINCT` is applied.

## M3: development project, rehearsal and results

**Environment.** A separate free-plan project, `CinemaVault Dev` (`rgcicevuflinfhalyomp`, same region), holds the rehearsal. Database branching needs the paid plan, so a second project was used. Production (`qhopjfqpnmoinggejgvt`) received read-only queries only. After the work it still reads 3,251 rows (3,243 live, 8 tombstones), the same latest `updated_at` (2026-10-25 16:08:58.396273+00), 2 profiles and 5 migrations.

**Schema parity.** The five repository migrations were applied to the dev project (the duplicate initial schema once, since the two files are byte-identical). A hash over columns, indexes, policies, constraints, function bodies and triggers matches production on every item except one: production has a function `rls_auto_enable` that is not in the repository's migrations (it looks like a platform default; it is not applied to dev). Decide whether to capture it in a migration.

**Production profile (read-only, 2026-11-01).**

| Check                                                        | Result                                    |
| ------------------------------------------------------------ | ----------------------------------------- |
| Rows (all / live / tombstones)                               | 3,251 / 3,243 / 8                         |
| Year-less / TV                                               | 59 / 212                                  |
| Rated / ratings range                                        | 41 / 3.0–5.0, no fractions finer than 0.1 |
| Rows with sub-millisecond `updated_at`                       | 3,156 (53 distinct version values)        |
| Control characters, titles > 200, notes > 5,000, `shot_link` | 0, 0, 0, 0                                |
| Duplicate groups (strict / punctuation- and accent-folded)   | 0 / 0                                     |
| Stored `normalized_title` differing from the app's function  | 1,166 (see F9)                            |
| Titles with metadata pasted into them (finding F10)          | about 290                                 |

**Copy and compare.** 106 rows were copied (all 8 tombstones, 10 year-less, rated, watched, non-ASCII, punctuated, TV, oldest and newest, plus a hash-ordered random sample). A digest over all 17 columns, including microsecond timestamps, is identical on both sides (`349577010018f85a4d2b9a2c88443c44`). The full-library copy cannot run from the automated environment (it has no network route to Supabase), so it is a script you run: `next/scripts/rehearse-migration.mjs`.

**Real-Supabase permission checks** (19 of 19 as expected, inside a rolled-back transaction): a viewer reads the owner's 106 rows but cannot insert (as self or as owner), update, soft-delete or delete; cannot promote self or rename the owner; a stale-version update changes 0 rows; a duplicate identity fails with 23505; a rating above 5 fails with 23514; the owner cannot write into another account's library, hand a record away or demote self; anonymous cannot read.

**How to run the full rehearsal** (needs a dev-project owner sign-in; the dev owner has the same user id as production's owner, so `owner_id` values carry over):

```
SOURCE_URL=… SOURCE_KEY=… SOURCE_EMAIL=… SOURCE_PASSWORD=…   # production owner, read with SELECT only
DEST_URL=…   DEST_KEY=…   DEST_EMAIL=…   DEST_PASSWORD=…     # the DEV project's owner
node next/scripts/rehearse-migration.mjs                      # dry run: reads, profiles, writes a backup
node next/scripts/rehearse-migration.mjs --apply --reset-dev  # copy, read back, compare every field
```

It writes `rehearsal-output/backup-….json` (rows plus a digest) and a report, refuses a production destination, refuses a non-empty destination unless `--reset-dev` is given, and exits non-zero on any difference. A backup can be replayed with `--from-backup`, which proves it is restorable. After a successful run, load every exported row through the real mapper by checking that `rowToMovie` accepts all of them (`tests/unit/productionShapedRows.test.ts` covers the shapes seen so far).

**Rollback.** The rehearsal is the rollback exercise: the dev table can be emptied (`--reset-dev`) and reloaded from a backup at any time. For the real cutover keep three things: the pre-cutover JSON backup with its digest, a database backup, and the previous deployment (the old app and `next/` are independent, so reverting is a routing change, not a data change).

### New findings from M3

- **F9 — two spellings of `normalized_title`.** About a third of the library (1,166 rows imported from the original list) stores titles with punctuation turned into spaces and accents folded ("the pope s exorcist", "leon"); titles created in the app, in the old one and in `next/`, keep punctuation ("the pope's exorcist"). The old app's `normalizeTitle` produces the second form, so it never matches the first, and its edit path rewrites a row's `normalized_title` on any edit. Consequences: a true duplicate of an imported title passes the old app's check and the database index. `next/` compares a canonical form (`comparableTitle`) and never rewrites a stored value unless the title changes. **Decision for you:** a one-time production backfill to a single canonical spelling plus the same change in the old app. Nothing was changed in production.
- **F10 — metadata pasted into titles.** About 290 titles contain text copied from search results ("Psycho . 1960 ‧ Horror/Mystery ‧ 1h 49m", "Lucía y el sexo (Sex and Lucia), 2001, Drama/Romance, 128 min") and about 150 contain "User noted …". They load and display, but they make searching and identity unreliable and will make poster matching harder. A cleanup pass is a data decision; it should run on the dev copy first.
- **Data oddity.** One title ("John Wick") has `watched_on = 2222-01-01`. It is a valid date and is preserved as-is.
- **Soft delete uses the client clock** for `deleted_at` (the old app does too).

## M3.1: review fixes

- **Migration history (P1):** compared with production's recorded history; canonical baseline, duplicate file, fresh-database tests, fingerprints and recovery steps are in `docs/migration-baseline.md`. Nothing applied remotely was deleted or renamed.
- **Duplicate detection (P1):** repository scan now covers every candidate; the unique index remains the final authority (see architecture.md). Future: one canonical normalized title, one database normalization function, one unique index for all rules (F2, F9).
- **Verification added:** `next/scripts/rls-adversarial.sql` (41 checks, rolled back, PASS on development) and `next/scripts/schema-fingerprint.sql`.
- **Still the user's to run or decide:** the full-library rehearsal (`--apply`), F1, F2, F6, F9, F10, the `TMDB_API_KEY` in Vercel and the OAuth callback URL.

## M4: what changes for the migration

- **No database change.** M4 adds nothing to `supabase/migrations`; the production database is still only read. The fingerprint, RLS suite and rehearsal results from M3/M3.1 stand.
- **A new kind of data exists on users' devices** (the saved library, per account, plus the shell cache). It is disposable: every part of it is rebuilt from the server, so rolling back to the old app needs no data action. The old app uses different storage names and is unaffected. If `next/` is rolled back after being deployed, deploy the kill-switch worker (architecture.md) so installed copies stop serving the shell.
- **Cutover additions:** serve `sw.js` / `index.html` / the manifest uncached (`next/vercel.json`); the old app registers no service worker (searched the repository), so `next/`'s worker is the only one on the origin; if the old app is ever served from the same origin and scope as `next/`, the two must not both exist; run the manual offline and install checks in `release-checklist.md`.

## Cutover (M6.3)

The step-by-step, with go/no-go rows, the read-only integrity gate (`scripts/data-gate.mjs`), the smoke test and the rollback table, is `docs/cutover-runbook.md`. Nothing in it has been run against production by the automated tooling.
