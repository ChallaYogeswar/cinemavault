# Deployment rehearsal (preview of `next/`, never the production database)

Goal: prove that `next/` deploys, signs in, installs, works offline and can be rolled back, **before** anything is cut over. The old app (`cinemavault` project, `cinemavaul.vercel.app`) is not touched at any point.

## 0. Preconditions

- The `next/` code is on a GitHub branch (not `main`) and `next-ci` is green on it.
- Supabase: the **development** project `rgcicevuflinfhalyomp` only. The current production project (`ermjvreodaeovawbsbyh`) must not appear in any variable of this Vercel preview project.
- Decided: F1, F2, F6 (hide `next/` from the old project), F9, F10 (see the release checklist).

## 1. Create a separate Vercel project

1. Vercel → Add New → Project → the same GitHub repo, **a new project** named e.g. `cinemavault-next`.
2. Settings → General → **Root Directory = `next`**. Framework preset: Vite.
3. Environment variables (Preview and Production of this project only):
   `TMDB_API_KEY` (exactly this name: the proxy does not read `TMDB`), `SUPABASE_URL` (= `https://rgcicevuflinfhalyomp.supabase.co`), `SUPABASE_PUBLISHABLE_KEY` (the dev project's publishable key).
4. Settings → Git: Production Branch = a branch you will not push to by accident during the rehearsal. Deploy the rehearsal branch as a Preview.
5. Supabase dev project → Authentication → URL configuration: add the preview URL to the redirect allow-list.

## 2. Automated checks against the preview

```bash
cd next
npm run check:deployment -- https://<preview-url> --token <access_token of a signed-in test user> --bypass <automation bypass secret>
```

The token is the Supabase `access_token` of a test user **on the dev project** (not a Vercel token). Without it only the signed-out checks run. What it proves: the **next** proxy (`/api/tmdb`, marker header `X-CinemaVault-Proxy`) answers rather than the old `api/tmdb.js`, signed-out calls are refused, and a signed-in call is accepted. "Root Directory is not next" means step 1.2 was missed. A preview behind Vercel Authentication answers with a login page before the function runs, so the script reports "no function is deployed or Deployment Protection answered first". Keep protection on and create a secret instead: Vercel → project → Settings → Deployment Protection → Protection Bypass for Automation → add, then pass it as `--bypass`. Treat the secret like a password (do not paste it into chat or commit it) and revoke it after the rehearsal.

Not covered by the script (check by hand in step 3): security headers, manifest and `sw.js` content types, and credentials in the served JavaScript (`npm run check:bundle` already covers the build output).

## 3. Manual rehearsal (record each result in the checklist)

| #   | Step                                                                                                       | Pass when                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Sign up / sign in with a dev-project test account                                                          | Library loads; role shown correctly (owner vs viewer)                                                                       |
| 2   | Add, rename, rate, delete a title                                                                          | Appears on a second browser after its next refresh                                                                          |
| 3   | Discover and posters                                                                                       | Real TMDB posters load; trailer link opens                                                                                  |
| 4   | Install the PWA (Chrome desktop, Android Chrome, iOS "Add to Home Screen")                                 | Opens standalone with the right icon and name                                                                               |
| 5   | Flight mode after a normal visit                                                                           | Library, Statistics, Discover open from the saved copy; banner says it is a saved copy; writes refused with a clear message |
| 6   | Back online                                                                                                | Banner clears; data refreshes                                                                                               |
| 7   | Settings → Sign out of all devices (two browsers)                                                          | Second browser is signed out after its next refresh                                                                         |
| 8   | Settings → change password                                                                                 | Works, or the "re-authentication required" message is clear                                                                 |
| 9   | Sign out                                                                                                   | Saved copy for that account is gone (DevTools → Application → IndexedDB)                                                    |
| 10  | Screen reader pass (VoiceOver / TalkBack / NVDA): sign in, add, open and close a title, Discover, Settings | Every control has a sensible name; focus returns to the card after closing a dialog                                         |
| 11  | 3,000–5,000 titles on a real mid-range phone (seed the dev project)                                        | Library usable; search responds in about a second                                                                           |

## 4. Rollback rehearsal

1. Deploy a second, trivially different build (e.g. change the README) to the same project.
2. Vercel → Deployments → pick the earlier READY deployment → **Promote / Instant Rollback**.
3. Pass when the previous build is served again **and** a signed-in browser keeps working: no forced sign-out, saved copy still readable offline, and the service worker updates to the rolled-back build on the next visit.
4. The old project is the production rollback for the cutover itself: until DNS/domain moves, nothing is lost by abandoning `cinemavault-next`.

## 5. Not part of this rehearsal

- Switching `cinemavaul.vercel.app` to the new app, or pointing the new app at the production database. That is a separate decision after the data-migration rehearsal (`docs/migration-plan.md`: `supabase db reset` with the literal migrations, row counts and checksums before and after).
- Android packaging.

## Findings log

### 2026-11-12, first preview (`cinemavault-izjj`, branch `fix/patch-merge-validation`, commit `ce13a29`)

- Passed: the preview builds and is READY with Root Directory `next`; `/` serves "CinemaVault Next" with the lazy chunks; `/manifest.webmanifest` is `application/manifest+json`; `/sw.js` is served with `Cache-Control: no-cache` and `Service-Worker-Allowed: /`, and its precache list matches the built files (including the lazy screens).
- Fixed in the repository (not yet re-deployed): Vercel printed TypeScript errors for `api/tmdb.ts` (`process`, `node:crypto`, a union not narrowed) because it compiled the function with a default non-strict config. The build still succeeded, but `api/tsconfig.json` now gives it the same strict config as local type checking. Confirm the next build log has no `api/tmdb.ts` errors.
- Not yet verified: `/api/tmdb` (a protected preview stops the request before the function; no runtime log lines exist) and everything in step 3.
- Fixed in the repository (not yet re-deployed): static responses carried only HSTS. `vercel.json` now also sends `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` and a restrictive `Permissions-Policy` on every path (unit-tested). Check them on the next preview (`curl -sI`). A Content-Security-Policy is still not set: it needs the font, Supabase and TMDB image origins listed and an E2E pass, so it is a separate change.
- Open (yours): the project has `TMDB` where the proxy needs `TMDB_API_KEY`, and no Supabase variable existed (the two public dev-project ones were added for Preview by Claude on 2026-11-12; Root Directory was set to `next` and the framework to Vite at the same time). With Root Directory `next`, a push to `main` of this project will fail to build because `main` has no `next/`: that is expected for the rehearsal; set the Production Branch to the rehearsal branch or ignore it.
