// The browser-side security policy for the deployed app, in ONE place.
//
//   - `vercel.json` carries the result (it is a static file, so it cannot import this). Run
//     `node scripts/sync-security-headers.mjs` after changing anything here; the unit test fails when
//     the two disagree, so they cannot drift.
//   - The end-to-end checks serve the built app with the SAME headers and fail on any violation.
//
// What the Content-Security-Policy says, in words:
//   scripts      only this site's own files. No inline script, no eval, nothing from a CDN.
//   styles       this site's files and Google Fonts' stylesheet.
//   fonts        this site and Google's font host.
//   images       this site, data: images, and TMDB's image host (posters).
//   connections  this site (/api/tmdb) and Supabase (any project host: the same file serves a
//                preview on the development project and production on the real one).
//   everything else (frames, plugins, other origins' workers) is refused; the page cannot be framed.
//
// What it cannot do: stop a script that is already part of our own bundle. It narrows what an
// injected script could load or send, it does not make injection impossible.

export const SUPABASE_HOST = 'https://*.supabase.co';
export const TMDB_IMAGE_HOST = 'https://image.tmdb.org';
export const GOOGLE_FONTS_STYLE_HOST = 'https://fonts.googleapis.com';
export const GOOGLE_FONTS_FILE_HOST = 'https://fonts.gstatic.com';

/**
 * @param {{ connect?: readonly string[]; upgradeInsecure?: boolean }} [options]
 *   `connect`: extra connection targets (the end-to-end test's fake server).
 *   `upgradeInsecure: false` is for tests that talk to plain-http localhost only.
 */
export function cspDirectives(options = {}) {
  const { connect = [], upgradeInsecure = true } = options;
  /** @type {Record<string, readonly string[]>} */
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'", GOOGLE_FONTS_STYLE_HOST],
    'font-src': ["'self'", GOOGLE_FONTS_FILE_HOST],
    'img-src': ["'self'", 'data:', TMDB_IMAGE_HOST],
    'connect-src': ["'self'", SUPABASE_HOST, ...connect],
    'manifest-src': ["'self'"],
    'worker-src': ["'self'"],
    'media-src': ["'none'"],
    'object-src': ["'none'"],
    'frame-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
  };
  if (upgradeInsecure) directives['upgrade-insecure-requests'] = [];
  return directives;
}

/** @param {{ connect?: readonly string[]; upgradeInsecure?: boolean }} [options] */
export function buildCsp(options) {
  return Object.entries(cspDirectives(options))
    .map(([name, values]) => (values.length > 0 ? `${name} ${values.join(' ')}` : name))
    .join('; ');
}

/** The headers sent on every path. Order is the order they are written to `vercel.json`. */
export function securityHeaders(options) {
  return [
    { key: 'Content-Security-Policy', value: buildCsp(options) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'X-Frame-Options', value: 'DENY' },
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    },
    // The app never opens or is opened by another window, so nothing can reach it through one.
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    // Only HTTPS, for two years. (No `preload`: that is a one-way door the owner should choose.)
    { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  ];
}

/** The same headers as a plain object (for the end-to-end static server). */
export function securityHeaderMap(options) {
  return Object.fromEntries(securityHeaders(options).map((h) => [h.key, h.value]));
}

/**
 * `config` with the catch-all header rule (`/(.*)`) replaced by the current policy. Everything else
 * in the file is returned untouched.
 */
export function applySecurityHeaders(config) {
  const rule = { source: '/(.*)', headers: securityHeaders() };
  const headers = Array.isArray(config.headers) ? config.headers : [];
  const index = headers.findIndex((r) => r.source === '/(.*)');
  const next = index === -1 ? [rule, ...headers] : headers.map((r, i) => (i === index ? rule : r));
  return { ...config, headers: next };
}
