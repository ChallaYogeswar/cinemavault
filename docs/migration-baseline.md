# Migration baseline and recovery procedure

Status: written for the M3 review fix (P1 "migration history"). Production was only **read**.

Historical snapshot: the production project recorded below was later deleted. Current production Supabase is `ermjvreodaeovawbsbyh`; do not use this report as its live migration history.

## 1. What actually exists

| Where                              | Applied migrations (version · name)                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository `supabase/migrations/`  | 5 files, listed below                                                                                                                                                       |
| Production `qhopjfqpnmoinggejgvt`  | the same 5 (versions identical to the file names)                                                                                                                           |
| Development `rgcicevuflinfhalyomp` | 4: `20261101044926 initial_schema`, `…44933 align_movie_rating_scale`, `…44953 owner_viewer_roles`, `…45004 profile_contact_sync` (versions are the time they were applied) |

Repository files, oldest first:

1. `20260927000100_initial_schema.sql` — **canonical baseline**
2. `20261015175602_cinemavault_initial_schema.sql` — byte-identical copy of (1)
3. `20261015175654_align_movie_rating_scale.sql`
4. `20261019120000_owner_viewer_roles.sql`
5. `20261021120000_profile_contact_sync.sql`

## 2. Which migration is canonical

**`20260927000100_initial_schema` is the baseline.** `20261015175602_cinemavault_initial_schema` is the same
file recorded a second time (it was applied through the Supabase dashboard/MCP on 2026-10-15). Every statement in
it is idempotent (`create … if not exists`, `create or replace`, `drop … if exists`), so replaying it changes nothing.

Evidence, all enforced by `tests/unit/migrationHistory.test.ts` so it cannot drift:

- the two files are byte-for-byte equal;
- the list of files equals production's recorded history, name for name;
- a database built **with** the duplicate and one built **without** it have the same schema fingerprint;
- row-level security is on for all four tables and the rating check is the 0–5 scale.

## 3. Decision: do not delete or rename anything

Production's `supabase_migrations.schema_migrations` records all five versions. Deleting or renaming file 2 would
make the repository disagree with production's history, and `supabase db push` / `migration list` would report a
mismatch. The duplicate is harmless, so the rule is:

> **Never delete, rename, reorder or edit a migration that has been applied to any remote project.**
> Fix forward with a new, later migration.

If the duplicate is ever to be squashed away, that is a deliberate, separately rehearsed operation (new baseline
plus `supabase migration repair` on every project), not a cleanup.

## 4. Fresh-database test (done)

| Test                                                                            | Result                                                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| PGlite (real PostgreSQL) built from the five literal files, in CI               | builds cleanly; same fingerprint with and without the duplicate file (its own baseline, below)    |
| Development project: the 4 distinct migrations applied through the Supabase API | `8ea6abe519010d495886599d8a56738f`, 149 items                                                     |
| Real Supabase replay of the full chain in a scratch transaction (rolled back)   | schema unchanged by the replay; development left with its 106 rows (see caveat)                   |
| Production, read-only                                                           | 150 items, `31d2a757712224d3fa14212f6e38e8f8`; **`8ea6abe5…` once `rls_auto_enable` is excluded** |

PGlite's number is not comparable with Supabase's (platform defaults such as default privileges and extensions
differ), so it is only ever compared with itself. The cross-project comparison is development ↔ production.

Caveat: the real-Supabase replay used the migration SQL re-typed into one transaction, not the literal files. The
literal files are exercised by the PGlite test. Before cutover run `supabase db reset` against a local stack or a
fresh scratch project so the literal files are applied by the real tool.

### The one known difference: `rls_auto_enable`

Production has a function `rls_auto_enable()` and an event trigger `ensure_rls`. They come from Supabase's
project-level "automatically enable row-level security" setting, not from this repository, and a new project only
has them if that setting is on. They only turn RLS on for new tables; every existing table already has it. Nothing
in the application depends on them. Leave them alone in production and do not copy them into the migrations.

## 5. How to compare any two databases

Run `next/scripts/schema-fingerprint.sql` on both (read-only). Compare **names and fingerprints, not version numbers**:
a project that applied the migrations by API (development) gets timestamps of the day it ran.

## 6. Recovery procedures

Backups first. Nothing below is run on production without a verified backup and a rehearsal on development:
`node next/scripts/rehearse-migration.mjs` (see migration-plan.md) copies production data to development and compares a
digest; `--from-backup` restores from a saved export.

| Situation                                                    | Action                                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| A migration is applied remotely but missing from history     | `supabase migration repair --status applied <version>`                                                                    |
| A migration is in history but was not really applied         | `supabase migration repair --status reverted <version>`, then push again                                                  |
| Repository and remote history differ only by version numbers | do nothing to the data; compare fingerprints, and record the mapping in section 1                                         |
| A new migration breaks something                             | there are no "down" migrations; write a new forward migration. If data is damaged, restore the verified backup and replay |
| Data damaged on the development project                      | `node next/scripts/rehearse-migration.mjs --reset-dev` and re-import                                                      |
| Anything touching production                                 | stop; take a backup; rehearse on development; compare digests before and after; only then proceed                         |

## 7. Policy checks that must pass before any cutover

1. `next/scripts/schema-fingerprint.sql` equal on target and development (allowing only `rls_auto_enable`).
2. `next/scripts/rls-adversarial.sql` all PASS on the development project (41 checks; changes nothing).
3. `npm run check` green from a clean `npm ci`.
4. Row count and digest of the copied library equal to the source.
