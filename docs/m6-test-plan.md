# M6 test plan — what to run, what to check, what to send back

Everything here is something the automated suite **cannot** prove: real phones, real networks, your Vercel and Supabase projects, your data. Do the sections in order; stop and report at the first **BLOCKER** failure.

**Reporting:** copy the table at the end, fill in `PASS` / `FAIL` / `SKIP` and one line for anything not PASS. Attach what each section asks for. Never paste tokens, passwords, the Vercel bypass secret, or your export/backup files into chat — send counts and digests, not contents.

**Where:** the **preview of the new project on the development Supabase** (`rgcicevuflinfhalyomp`). Nothing below touches production data. Section E is the only one that *reads* production, and only with SELECT.

**You need:** the preview URL; the dev **owner** and **viewer** accounts; two devices (a laptop + a phone is ideal); Node 22 and the repo.

---

## A. Run on your machine (about 15 minutes)

Unzip, then in `next/`:

| #   | Command                                                              | Expect                                                          | Send back                  |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------- |
| A1  | `npm ci && npm run check`                                            | typecheck, lint, format, all tests green (~1,200 tests)         | the last 8 lines           |
| A2  | `npm run build && npm run check:bundle && npm run check:headers`     | "no server credentials… every file within budget"; "matches"   | the 3 result lines         |
| A3  | `npx playwright install chromium && npm run e2e`                     | `54/54 checks passed` (incl. offline add → sync, CSP enforced)  | last 5 lines               |
| A4  | `npm run a11y`                                                       | all PASS, incl. "no Content-Security-Policy violations"         | last 5 lines               |
| A5  | `npm run perf` (optional; slow machine = slower numbers)             | all `ok`                                                        | the table                  |

**BLOCKER** if A1–A4 fail on your machine but passed in my sandbox: that is an environment difference I need to see.

## B. Offline editing — two real devices, owner account (BLOCKER section)

Open the preview on device 1 (phone) and device 2 (laptop), sign in as the **owner** on both, and let the library load.

| #   | Do                                                                                             | Expect                                                                                              |
| --- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| B1  | Phone: airplane mode. Reload the page.                                                         | Library opens from the saved copy; banner says changes are kept on this device                      |
| B2  | Phone (offline): add "Offline Test One" (2019); edit another title's rating; delete a third    | Each change shows at once; added/edited titles show **Not synced**; a banner counts waiting changes |
| B3  | Phone (offline): close the tab, reopen it, still offline                                       | All three changes are still there and still marked                                                   |
| B4  | Phone: airplane mode off                                                                       | Within ~30 s (or tap **Sync now**) badges and banner clear. No press needed                         |
| B5  | Laptop: reload                                                                                 | "Offline Test One" appears **once**; the edit and the delete are applied                            |
| B6  | Phone (offline): add "Offline Test Two"; then edit it again; then delete it                    | Nothing is sent when back online (it never existed); no stray title                                 |
| B7  | **Conflict.** Phone offline: edit title X's rating to 2. Laptop (online): edit X's rating to 5 | —                                                                                                   |
| B7b | Phone back online                                                                              | X shows **Needs review**; the laptop's 5 is **not** overwritten; banner offers **Review**           |
| B7c | Review → **Use the other version**                                                             | Phone shows 5, queue empty. Repeat B7 and choose **Keep my version** → both devices end at 2        |
| B8  | **Delete vs edit.** Phone offline: edit title Y. Laptop: delete Y. Phone online                | Wording says it was deleted elsewhere; choices work; nothing vanishes silently                      |
| B9  | **Duplicate.** Phone offline: add "Dup Test" (2020). Laptop: add "Dup Test" (2020). Phone online | Phone's change shows **Needs review** (duplicate); no second copy on the server                  |
| B10 | Phone offline with one unsent change → Settings → Sign out                                     | Asks first. **Stay signed in** keeps it; **Sign out and discard them** wipes it                    |
| B11 | Sign in as the **viewer** (offline and online)                                                 | No add/edit/delete anywhere. Offline never enables them                                             |
| B12 | Phone: poor network (Chrome DevTools "Slow 3G", or walk into a weak-signal spot) and add a title | Either saves, or queues and syncs later; **never** a duplicate and never a silent loss            |
| B13 | Owner: in Supabase dev, demote the owner to viewer *while the phone is offline with changes*, then reconnect | Changes are kept and flagged (refused), not applied, not lost. (Restore the role afterwards)   |

**Send back:** PASS/FAIL per row + a phone screenshot of B7b and B9. Any FAIL: the exact steps, the device/browser, and what the banner said.

**Decision for you (D1):** if the *server* ends a session (revoked/expired refresh token) while changes are unsent, they are discarded with the account's saved data. Accept that, or should I add "download unsent changes before wiping"?

## C. Export / import

| #   | Do                                                                                                  | Expect                                                                                           |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| C1  | Settings → export **JSON** and **CSV**                                                              | Both download; JSON title count = library count                                                  |
| C2  | Open the CSV in Excel / Sheets. Add a title named `=1+1` first (then delete it after the check)   | The cell shows the text `=1+1`, not `2`                                                         |
| C3  | Import the JSON back into the same library                                                          | Preview says every title is a duplicate; **0 added**; checksum "verified"                        |
| C4  | Edit the JSON by hand (change one rating, keep the checksum) and import                             | Checksum shown as **mismatch**; nothing existing changes                                         |
| C5  | Import a CSV with: a new title, a duplicate, a rating of 9, a blank title, a `=cmd` title           | New one added; duplicate skipped; invalid rows listed with reasons; formula text stored as text |
| C6  | Import a >5 MB file, and a file renamed `.json` that is not JSON                                    | Clear refusal; nothing changed                                                                   |
| C7  | Viewer account: Settings                                                                            | Export works; the import area says "View-only accounts can’t import titles."                    |

**Send back:** PASS/FAIL, screenshot of C4's preview.

## D. Hardening on the preview

| #   | Do                                                                                                  | Expect                                                                                                |
| --- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| D1  | Open each screen (Home, Library, a title, Add, Genres, Discover, Stats, Settings, sign-in) with DevTools → Console open | **No** "Refused to load/execute/connect… Content Security Policy" message           |
| D2  | `curl -sI https://<preview>/` (the bypass secret may be needed; or DevTools → Network → document → Headers) | `content-security-policy`, `strict-transport-security`, `x-frame-options: DENY`, `cross-origin-opener-policy` present |
| D3  | Posters and fonts still load; sign-in, sign-out, password reset e-mail link still work             | Yes                                                                                                   |
| D4  | Open `/library/not-a-real-id` and `/no-such-page`                                                  | A "Title not found" dialog that closes cleanly; navigation still works                            |
| D5  | Set `TMDB_API_KEY` in Vercel (name exactly that), redeploy, open Discover                           | Posters load. `npm run check:deployment -- <url> --token … --bypass …` all PASS                       |
| D6  | In Vercel → Firewall add a rate-limit rule for `/api/tmdb` (e.g. 60 req/min per IP)                 | Rule saved. (The in-code limit is per instance only — this rule is the real one)                      |
| D7  | `npm audit --omit=dev` in `next/`                                                                   | Send the summary; I will triage anything high/critical                                                |

**Send back:** D1 as PASS/FAIL (a screenshot of any console message); D2 the header **names** only.

## E. Cutover rehearsal — dev project (BLOCKER before any production step)

Follow `docs/cutover-runbook.md` sections 3–4 *against the dev project*, with production as **read-only source**. Environment variables go in your shell, not in chat.

| #   | Do                                                                                                                    | Expect                                                                               | Send back                              |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------- |
| E1  | `node scripts/rehearse-migration.mjs` (SOURCE_* = production, **no `--apply`**)                                       | Profile: counts as in `migration-plan.md` (3,251 / 3,243 / 8 unless you changed data) | the printed counts + backup **digest** |
| E2  | `node scripts/rehearse-migration.mjs --apply --reset-dev` (DEST_* = dev)                                              | "every row, field and timestamp matches"                                             | that line + the report file            |
| E3  | `node scripts/rehearse-migration.mjs --apply --reset-dev --from-backup <backup file>`                                 | same                                                                                 | that line                              |
| E4  | `GATE_*` = dev owner; `npm run gate:data -- --expect-backup <backup file>`                                            | `PASS`; 13 checks ok; notes only for F7/F9/F10                                       | the output (no secrets in it)          |
| E5  | Same gate against **production** (read-only, owner login)                                                             | PASS, same digest as E1                                                              | the output                             |
| E6  | Make a deliberate mistake on dev (edit one rating) and re-run E4                                                      | The gate reports the difference and exits non-zero                                   | the failing line                       |
| E7  | Run RLS suite and schema fingerprint as in the runbook go/no-go rows 5–6                                              | 41/41; fingerprints equal                                                            | both results                           |

**Do not** run the runbook's section 4 "T0" steps (production env vars, domain move) yet. That is a separate day after B–E are green and you have decided F1, F2, F6, F9, F10.

## F. Real device and accessibility (manual)

| #   | Do                                                                                                        | Expect                                                          |
| --- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| F1  | Install the app to the phone's home screen; open it offline                                               | Opens, shows saved copy                                         |
| F2  | Load your real ~3,000+ title library (via E2 on dev) on the phone: scroll, search, "Show more"            | Smooth enough to use; note any stutter and the phone model       |
| F3  | Screen reader (TalkBack / VoiceOver) through: sign in → library → a title → add → the Sync banner         | Names make sense; the banner and "Sync issues" dialog are read   |
| F4  | Keyboard only (laptop): reach and use "Sync now", Review, and the sign-out confirmation                   | All reachable, visible focus, Escape closes dialogs              |
| F5  | 320 px wide and 200% text zoom                                                                            | No horizontal scroll; banners readable                           |

## G. Decisions I need from you

| #   | Decision                                                                                       | Default if you say nothing                       |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| D1  | Unsent offline changes when the *server* ends the session: discard, or export first            | Discard (documented)                              |
| F1  | Old app fails open on role read                                                                | Leave (old app is being retired)                  |
| F2  | `NULLS NOT DISTINCT` index for year-less titles (a production write)                           | Not now; app enforces it                          |
| F6  | Hide `next/` source on the old project                                                         | Leave                                             |
| F9/F10 | Normalise title spellings / clean pasted metadata (production writes)                       | Not now                                           |
| H1  | Error-reporting service (needs a host added to the CSP) or console only                        | Console only                                      |

## H. Housekeeping (yours, not tests)

- Revoke the two Vercel tokens that were pasted in chat earlier (Vercel → Account → Tokens).
- Push the current changes to a branch so the Vercel preview rebuilds.
- Create the Vercel "Protection Bypass for Automation" secret; keep it out of chat.

## I. Deferred on purpose

**Android packaging** has not been started, as you asked: it waits for these web results. When B–F are green, the next step is a short decision doc (Trusted Web Activity vs Capacitor, signing, store listing, offline expectations) — say "go" and I will write it.

---

## Results template (copy, fill, send)

```
Device(s):            Browser/version:          Preview URL commit:
A1 A2 A3 A4 A5:
B1 B2 B3 B4 B5 B6:
B7 B7b B7c B8 B9:
B10 B11 B12 B13:
C1 C2 C3 C4 C5 C6 C7:
D1 D2 D3 D4 D5 D6 D7:
E1 E2 E3 E4 E5 E6 E7:
F1 F2 F3 F4 F5:
Decisions (G):
Anything odd:
```
