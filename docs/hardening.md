# Hardening (M6.4)

What was added, how to check it, and — just as important — what it does **not** do.

## 1. Content-Security-Policy and security headers

**One source:** `next/security/policy.mjs`. `vercel.json` is generated from it (`node scripts/sync-security-headers.mjs`); a unit test fails if they differ, and the end-to-end tests serve the built app with the **same** headers.

| Directive                          | Value                                                       | Why                                                                         |
| ---------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `default-src`                      | `'self'`                                                    | everything not listed below is this site only                               |
| `script-src`                       | `'self'`                                                    | no inline script, no `eval`, no CDN: an injected string cannot become code  |
| `style-src`                        | `'self'` + `fonts.googleapis.com`                           | the app's own CSS file and the font stylesheet                              |
| `font-src`                         | `'self'` + `fonts.gstatic.com`                              |                                                                             |
| `img-src`                          | `'self'`, `data:`, `image.tmdb.org`                         | posters                                                                     |
| `connect-src`                      | `'self'`, `https://*.supabase.co`                           | `/api/tmdb` and the database/auth. Any Supabase project host (see below)    |
| `manifest-src`, `worker-src`       | `'self'`                                                    | PWA                                                                         |
| `frame-ancestors`, `frame-src`, `object-src`, `media-src` | `'none'`                             | cannot be framed; embeds nothing                                            |
| `base-uri`, `form-action`          | `'self'`                                                    |                                                                             |
| `upgrade-insecure-requests`        |                                                             | any stray `http:` request is upgraded                                       |

Also sent on every path: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera, microphone, geolocation, payment, usb off), `Cross-Origin-Opener-Policy: same-origin`, and `Strict-Transport-Security` (2 years, no `preload` — that is a one-way door; add it yourself if you want it).

**Verified in a real browser:** `npm run e2e` (sign-in, library, offline, offline add and sync, update, sign-out) and `npm run a11y` (every screen, dialogs, three viewports) run under these headers and fail on any `securitypolicyviolation` event. A probe injects an inline script and requires it to be blocked **and** reported, so "zero violations" cannot mean "the monitor is broken".

What the run found and fixed: Zod's fast path compiles validators with `new Function`, which the policy forbids (and a strict policy reports even the failed probe). `src/app/zodSetup.ts` turns that path off before any schema is built. Validation is identical; measured effect on the 5,000-title run: none that matters (sign-in → library 1.8 s under 4x CPU throttle, budget 30 s).

**Limits**
- `connect-src` allows *any* `*.supabase.co` host, because one build serves a preview on the development project and production on the real one. A tighter pin would need a header per environment. Someone who could inject script could therefore send data to *their own* Supabase project; the policy still blocks every other destination.
- CSP narrows what injected script can do. It does not make injection impossible, and it does nothing about code that is already in our own bundle (supply chain: see section 5).
- The E2E runs over plain `http://127.0.0.1`, so `upgrade-insecure-requests` is the only directive the browser tests do not carry; the unit test pins it.
- A new third party (analytics, an error-reporting host, another image CDN) needs an explicit edit to `policy.mjs` + sync, or the browser will refuse it. That is the point.

## 2. TMDB proxy rate limits (`api/tmdb.ts`)

| Limit                    | Default        | Applied                                   | Why                                                                      |
| ------------------------ | -------------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| per address              | 120 / minute   | before the sign-in check                  | garbage tokens cannot each cost an auth call                             |
| per signed-in user       | 60 / minute    | after the sign-in check                   | a stranger cannot spend someone else's budget; a runaway loop is capped  |

Over the limit: `429 {code:"rate_limited"}` with `Retry-After`; TMDB is never called. The app already treats `rate_limited` as "pause lookups for 30 s".

**Honest limits:** the counters live in one serverless instance's memory. A host may run several instances and restarts them freely, so this bounds one instance's work for one caller; it is **not** a global guarantee. A hard shared limit needs Vercel's firewall rate-limit rules (dashboard → Firewall) or a shared store (e.g. Upstash). Recommended before wide use: add a Vercel Firewall rule of the same shape on `/api/tmdb`. The in-code limiter stays as the second layer. The address comes from `x-vercel-forwarded-for` / `x-forwarded-for`, which Vercel sets itself; behind a different host, check that header before trusting it. The table is capped at 2,000 keys, so a flood of distinct callers cannot exhaust memory.

## 3. Bundle splitting and budgets

Third-party code moved into its own cached files (`vendor-react`, `-router`, `-supabase`, `-data`, `-forms`). The largest file went from 862 kB to 219 kB; the total is unchanged (~0.94 MB raw), and the service worker precaches every file, so offline behaviour is unchanged. A release that touches only app code now leaves the vendor files cached in the browser.

`npm run check:bundle` also fails if one JavaScript file passes 300 kB or the total passes 1,100 kB. These are accident detectors (a whole library pulled in), not tuning targets.

## 4. Errors: boundary and reporting hook

- `src/app/ErrorBoundary.tsx` wraps the whole app. Before this, a crash outside a screen (providers, sign-in handling) was a blank white page. Now: "CinemaVault hit a problem — your library is safe — Reload". It uses plain markup only, because whatever broke may be the styles.
- `src/app/errorReporter.ts` is a **hook only**. Nothing is sent anywhere unless code calls `setErrorSink(fn)`. Reports are built here, not by the sink: error name, a scrubbed message (≤300 chars) and stack (≤2,000), the screen path with ids and query strings removed, and a time. A thrown string or object is never copied (it could be a title or a note). Tokens, e-mail addresses, ids, URL queries and hashes are scrubbed. Identical errors are reported once per 10 s; at most 20 reports per page load; a sink that throws is ignored.
- Wired to: render errors, screen (route) errors, `window` `error`, and `unhandledrejection`.
- **Not done, on purpose:** choosing a vendor. To add one: write a sink, add its host to `connect-src` in `policy.mjs`, run the sync script, run both E2E suites. The privacy tests in `errorReporter.test.ts` protect the report shape.

## 5. Residual risks (named, not solved)

| Risk                                                                    | State                                                                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A malicious npm release of a dependency runs inside our bundle           | Not mitigated by CSP. Mitigations available to you: `npm ci` from the lockfile only, Dependabot/`npm audit` in CI, review lockfile diffs |
| Not encrypted at rest on the device (library, outbox)                    | Deliberate (T23): a key kept next to the data adds nothing. Anyone with the unlocked browser profile can read it |
| Shared rate-limit counters                                              | Per-instance only (section 2)                                                                           |
| `connect-src` wildcard on Supabase                                      | Section 1                                                                                               |
| Involuntary sign-out discards unsent offline changes                    | Decision F-offline-1 in `release-checklist.md`                                                          |
| No error-reporting vendor                                               | Hook only (section 4)                                                                                   |

## 6. How to verify (all in `next/`)

```
npm run check                   # includes the policy/vercel.json sync test, proxy limits, error reporter
node scripts/sync-security-headers.mjs --check
npm run build && npm run check:bundle
npm run e2e && npm run a11y     # real Chromium, production headers, zero CSP violations
npm run perf                    # 5,000 titles
```
Manual, on the real preview: open DevTools → Console on every screen; there must be **no** "Refused to …" messages. In Network, the document response must show `Content-Security-Policy`. Run the page through https://securityheaders.com (or `curl -sI <url>`).
