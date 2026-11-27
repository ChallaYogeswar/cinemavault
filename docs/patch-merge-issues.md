# Patch Merge: Issues and Findings

This log records the findings from merging the updated CinemaVault project and preparing the Next.js preview. It distinguishes verified fixes from unresolved problems; a passing subset is not evidence that the full suite is green.

## Resolved

1. **TMDB environment-variable name mismatch**
   - The deployed legacy configuration used `TMDB`, while the proxies expected `TMDB_API_KEY`.
   - Both proxies now prefer `TMDB_API_KEY` and accept `TMDB` as a fallback. README guidance was updated.
   - The root `.env` was found to be malformed. It remains ignored and must not be used as a source of credentials without correcting it.

2. **Windows E2E runners could not reliably spawn Vite through `npx`**
   - The E2E scripts were changed to launch the project's local Vite executable with `process.execPath`.

3. **Service-worker test fake broke native `Request` access**
   - The test harness created a native `Request` using `Object.create`, which caused a private-field error.
   - It now adds the test `mode` property to a real `Request` with `Object.defineProperty`.
   - Verification recorded: service-worker tests passed, 26/26.

4. **Static checks**
   - TypeScript, lint, and formatting checks passed on the merged patch at the time they were run.

5. **Library dialog integration tests**
   - The edit helper contained temporary console logging that read `document.body.innerText`, which is undefined in the test DOM and threw before the dialog assertions ran.
   - Removed both diagnostic logs and the artificial 20 ms delay. The focused library and Discover integration files pass, 124/124.

6. **Discover poster retention**
   - Metadata queries no longer consume React Query's abort signal. The metadata service shares and caches lookups, so a route transition must not cancel the query result needed by a still-mounted poster.

7. **Slow test-environment waits**
   - Increased Vitest hook/test limits and Testing Library's async wait limit to avoid false timeouts while the full suite runs concurrently.

## Verification

- `npm run check`: passed (typecheck, lint, formatting, 53 test files; 1,029 tests).
- `npm run build`: passed. Vite reports the existing main chunk is larger than 500 kB.
- `npm run check:bundle`: passed; no server credentials in the client bundle.
- Local Playwright E2E could not reach its local server (`net::ERR_NETWORK_ACCESS_DENIED` at `127.0.0.1`) even after allowing loopback in the workspace settings. Verify the E2E job on GitHub Actions.

## Remaining delivery blockers

1. **Preview deployment and CI are not verified**
   - No non-main branch has been pushed, and there is no verified green `next-ci` run for this merged patch.
   - No separate Vercel preview project has been created. The existing production project should not be repointed; the runbook requires a separate project with Root Directory `next` and development Supabase settings.

2. **Test-user credential**
   - A user's bearer `access_token` must not be posted in chat. The deployment check should be run locally by the user with their own token.
