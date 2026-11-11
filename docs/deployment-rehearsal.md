# Deployment rehearsal (preview of `next/`, never the production database)

Goal: prove that `next/` deploys, signs in, installs, works offline and can be rolled back, **before** anything is cut over. The old app (`cinemavault` project, `cinemavaul.vercel.app`) is not touched at any point.

## 0. Preconditions

- The `next/` code is on a GitHub branch (not `main`) and `next-ci` is green on it.
- Supabase: the **development** project `rgcicevuflinfhalyomp` only. The production project (`qhopjfqpnmoinggejgvt`) must not appear in any variable of this Vercel project.
- Decided: F1, F2, F6 (hide `next/` from the old project), F9, F10 (see the release checklist).

## 1. Create a separate Vercel project

1. Vercel → Add New → Project → the same GitHub repo, **a new project** named e.g. `cinemavault-next`.
2. Settings → General → **Root Directory = `next`**. Framework preset: Vite.
3. Environment variables (Preview and Production of this project only):
   `TMDB_API_KEY`, `SUPABASE_URL` (= `https://rgcicevuflinfhalyomp.supabase.co`), `SUPABASE_PUBLISHABLE_KEY` (the dev project's publishable key).
4. Settings → Git: Production Branch = a branch you will not push to by accident during the rehearsal. Deploy the rehearsal branch as a Preview.
5. Supabase dev project → Authentication → URL configuration: add the preview URL to the redirect allow-list.

## 2. Automated checks against the preview

```bash
cd next
npm run check:deployment -- https://<preview-url> --token <access_token of a signed-in test user>
```

The token is the Supabase `access_token` of a test user **on the dev project** (not a Vercel token). Without it only the signed-out checks run. What it proves: the **next** proxy (`/api/tmdb`, marker header `X-CinemaVault-Proxy`) answers rather than the old `api/tmdb.js`, signed-out calls are refused, and a signed-in call is accepted. "Root Directory is not next" means step 1.2 was missed. If the preview is behind Vercel Authentication, turn that off for the rehearsal or use a protection-bypass link, otherwise the script sees the login page.

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
