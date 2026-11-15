# Cutover runbook: old CinemaVault → CinemaVault Next

This is the only document to follow on cutover day. It is written so that **every step either proves something or can be undone**, and so that the first failed proof stops the whole thing. Nothing here has been run against production by the automated tooling; production has only ever been read.

## 0. What "cutover" means here

Both apps use the **same Supabase schema** (`/supabase/migrations`). There is no data transformation to run: the data does not move, only the app in front of it changes. That makes the risk about three things: (1) the data is intact and identical before and after, (2) the new app can sign in and behave correctly against it, (3) you can go back in minutes. The tooling proves (1) and (3); (2) is the manual smoke test in section 5.

**Never run both apps as writers at the same time after cutover.** The old app saves with last-write-wins (finding F5) and can overwrite what `next/` saved. After cutover the old app is for rollback only.

## 1. Go / no-go (all must be true; write the date next to each)

| #   | Condition                                                                                           | How to prove it                                                                |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | `npm run check`, `build`, `check:bundle`, `e2e`, `e2e:perf`, `e2e:a11y` green on the release commit | CI + the clean-install gate output                                             |
| 2   | Full-library rehearsal on the **dev** project: "every row, field and timestamp matches"             | `rehearse-migration.mjs --apply --reset-dev`; keep backup + report             |
| 3   | Backup replay into an emptied dev project also matches                                              | `rehearse-migration.mjs --apply --reset-dev --from-backup <file>`              |
| 4   | Data gate passes on dev after the rehearsal                                                         | `data-gate.mjs` (section 3)                                                    |
| 5   | RLS adversarial suite 41/41 on the target schema                                                    | `scripts/rls-adversarial.sql` (rolled back; never on production data)          |
| 6   | Schema fingerprint of a fresh `supabase db reset` equals production's                               | `scripts/schema-fingerprint.sql` on both                                       |
| 7   | Preview deployment passes the deployment probe and the manual runbook (`deployment-rehearsal.md`)   | `check:deployment` + steps 3–11                                                |
| 8   | Offline editing tested on two real devices (`m6-test-plan.md`)                                      | tester results                                                                 |
| 9   | Decisions made: F1, F2, F6, F9, F10 (section 2)                                                     | written below                                                                  |
| 10  | The two Vercel tokens pasted earlier are **revoked**                                                | Vercel → Account → Tokens                                                      |
| 11  | `TMDB_API_KEY` set in the new Vercel project (Production **and** Preview)                           | Vercel → Project → Environment Variables                                       |
| 12  | Previous deployment id noted; old commit tagged                                                     | `git tag pre-next-cutover <commit>`; Vercel → Deployments → copy the old id    |

If any row is not true: **no-go.** Fix it or move the date. Cutting over with an open row converts a test into a production incident.

## 2. Decisions (take them before the day; "do nothing" is always safe)

| Finding                            | Decision needed                                                      | If you do nothing                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| F1 old app fails open on role read | Change the old app? (it is being retired)                            | Fine: the old app is not used after cutover                                                               |
| F2 NULL years not unique in the DB | Add `NULLS NOT DISTINCT` after verifying zero year-less duplicates   | App enforces it; two devices racing on a year-less title could still both add one (the gate would show it) |
| F6 `next/` source reachable        | Hide `/next/` on the old project?                                    | Source is public; contains no secrets                                                                     |
| F9 two `normalized_title` spellings | One-time backfill to one spelling (production write)                | App compares a canonical form; nothing breaks                                                             |
| F10 pasted metadata in titles      | Clean up (data decision, dev copy first)                             | Titles display as they are                                                                                |

**F2, F9 and F10 are production writes. They are not part of the cutover.** If you want them, do them on a separate day, each with its own backup and gate run, never in the same window as the cutover.

## 3. Tools you will use

| Tool                                                                              | What it does                                                                        | Writes?                |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------- |
| `node next/scripts/rehearse-migration.mjs` (no flags)                             | Reads production (SELECT only), profiles it, writes a JSON backup with a SHA-256    | local file only        |
| `node next/scripts/rehearse-migration.mjs --apply --reset-dev [--from-backup F]`  | Copies into the **dev** project, reads back, compares every field. Refuses production | dev only               |
| `node next/scripts/data-gate.mjs [--expect-backup F]`                             | 13 integrity checks + 3 informational notes + optional "identical to this backup" proof                     | none (SELECT only)     |
| `node next/scripts/check-deployment.mjs <url> --token … --bypass …`               | Probes a deployment (headers, static assets, `/api/tmdb`, signed-in read)           | none                   |

Environment for the gate (never commit, never paste into chat):

```
GATE_URL=https://<project>.supabase.co  GATE_KEY=<publishable key>
GATE_EMAIL=<owner email>                GATE_PASSWORD=<owner password>
```

A gate run prints one line per check (`ok`, `note`, `FAIL`) and exits non-zero on any `FAIL`. `note` lines (F7, F9, F10) are known, documented conditions; they are reported with a count so a change since the baseline is visible. The baseline today: **3,251 rows / 3,243 live / 8 tombstones**, F9 ≈ 1,166, F10 ≈ 290.

## 4. The day

### T−1 day

1. Run the gate on production. Expect **PASS**. Record the **digest** and row counts.
2. Run `rehearse-migration.mjs` (dry run) on production: this writes `rehearsal-output/backup-….json`. Store it **outside the repository** (it holds your whole library). Confirm the digest printed equals the gate's.
3. Take a Supabase backup (dashboard → Database → Backups; point-in-time recovery if your plan has it). Write down the time.
4. Rehearse the restore into the dev project from this backup (go/no-go #3).
5. Announce a quiet period: **nobody edits in the old app from now until you say "done".** Every write after the backup is a write the backup does not contain.

### T0 — cutover (about 30 minutes)

| Step | Action                                                                                                                                                                  | Proof / stop condition                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1    | Gate on production again                                                                                                                                                | PASS **and** digest equals T−1's. If not: someone wrote. Find out who/what before continuing                    |
| 2    | Supabase → Authentication → URL configuration: add the new app's origin to Site URL / Redirect URLs (keep the old ones)                                                  | Recovery and OAuth links must work on the new origin                                                            |
| 3    | In the **new** Vercel project, set **Production** environment variables to production Supabase: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_APP_ENV=production`. Leave **Preview** pointing at dev | Never put the service-role key anywhere. `VITE_DATA_SOURCE` stays unset                                         |
| 4    | Deploy the release commit to Production in the new project                                                                                                              | Build green; `check:deployment <prod-url>` passes                                                               |
| 5    | Smoke test (section 5) with the real owner account                                                                                                                      | Every line passes. Any failure → **rollback now** (section 6)                                                   |
| 6    | Gate on production                                                                                                                                                      | PASS. If you made **no** edits in the smoke test: digest still equals T−1's (use `--expect-backup`)             |
| 7    | Point the public address at the new project (move the domain / alias). Keep the old project and its last deployment untouched                                            | Open the public address in a fresh private window: new app, sign-in works                                       |
| 8    | Tell people to reload once. The new app installs its service worker on first visit                                                                                      | The old app registers no service worker, so nothing old needs clearing                                          |

### T+1 hour and T+1 day

- Vercel runtime logs: no spike in 4xx/5xx on `/api/tmdb`; no error-report bursts.
- Gate on production. Expect PASS; row counts only grow by what was added in the new app.
- Open the app on a phone **offline** (airplane mode), add a title, reconnect, confirm it appears once.
- Decide to retire the old project only after a full week with no rollback need.

## 5. Smoke test (real production, owner account, about 10 minutes)

1. Sign in. The library appears with the expected count (3,243 live titles unless changed).
2. Search for three titles you know; open one; ratings, watched dates and genre are as in the old app.
3. Add one title ("Cutover Test"), refresh, it is still there. Edit its rating, refresh. Delete it; it disappears and stays gone after refresh.
4. Settings → export JSON. The file's checksum line is present; the title count matches.
5. Sign out; the library is gone from the screen. Sign in as the **viewer** account: no add/edit/delete anywhere; the owner's titles are readable.
6. Sign back in as owner. Settings → "Sign out" shows no unsent-changes warning.
7. Browser devtools → Network offline → reload: the saved library opens with the "can't reach the server" banner; add a title; it shows "Not synced"; go online; it syncs and the badge clears.
8. The deleted "Cutover Test" is a tombstone (soft delete). It is fine to leave it; the gate treats tombstones as normal.

Each smoke-test write makes the digest differ from the backup's by design. If you want the strict "identical" proof (step 6), do the smoke test as the **viewer** only, or run the strict check before step 5 and the plain gate after.

## 6. Rollback

**Triggers (any one is enough):** a gate `FAIL`; a digest that changed when nothing should have written; sign-in failing for either account; the viewer able to write; a row count that is not what you expect; repeated errors in the logs; you simply do not trust it.

| Situation                                                    | Action                                                                                                                                                                                                         | Time        |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| New app misbehaves, **data is fine** (gate PASS)             | Move the public address back to the old project's last deployment (Vercel → Deployments → the noted id → "Promote"/re-alias). Nothing else. The schema is shared, so there is nothing to undo in the database | ~2 minutes  |
| Installed copies of the new app are stuck on a bad version   | Deploy the kill-switch worker (architecture.md): installed copies stop serving the shell and fall through to the network                                                                                       | ~10 minutes |
| **Data** is wrong (gate FAIL, unexpected digest)             | Stop all writers. Roll back the app **first** (above). Then restore from the Supabase backup/PITR taken at T−1. The JSON backup is for **inspection and targeted repair**: replay it into dev (`--from-backup`) and compare, then repair rows with SQL you have read | as needed   |
| Only a few rows are wrong                                    | Replay the backup into dev, run `diffRows` (the rehearsal report lists them), repair those rows in production with a reviewed SQL statement                                                                   | as needed   |

**What rollback cannot do:** un-ring writes made in the new app after cutover, if you then roll the *data* back to T−1 — those edits are lost by definition. Export the library (Settings → export JSON) before restoring so they can be re-entered, and never restore over a database someone is still using.

## 7. After

- Update `migration-plan.md` with the real cutover date, digests and any findings.
- Keep the T−1 backup file for at least 30 days.
- Remove the Preview-environment bypass secret if you created one only for testing.
- Revisit F2/F9/F10 as separate, backed-up, gated changes.
