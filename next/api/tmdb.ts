/**
 * TMDB proxy for CinemaVault Next (Vercel serverless function).
 *
 * Why it exists: the TMDB key must never reach a browser, so the app asks THIS function, which
 * asks TMDB. Only signed-in users may call it, only three read-only kinds of request are allowed,
 * and nothing the browser sends can widen that.
 *
 *   GET /api/tmdb?path=/search/multi&query=Inception
 *   GET /api/tmdb?path=/movie/27205/videos
 *
 * Server environment (Vercel → Settings → Environment Variables; none of these use the VITE_
 * prefix, so none is bundled into the browser):
 *   TMDB_API_KEY              TMDB v3 key or v4 read-access token
 *   SUPABASE_URL              the project this deployment signs users in with
 *   SUPABASE_PUBLISHABLE_KEY  that project's publishable (anon) key — public by design
 * (VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are accepted as a fallback because they
 * already exist on the project.) The sign-in check goes to THIS deployment's project, never to a
 * hard-coded one, so a preview talks to the development project and production to production.
 */
import { createHash } from 'node:crypto';

export interface ProxyEnv {
  readonly TMDB_API_KEY?: string | undefined;
  readonly SUPABASE_URL?: string | undefined;
  readonly SUPABASE_PUBLISHABLE_KEY?: string | undefined;
  readonly VITE_SUPABASE_URL?: string | undefined;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string | undefined;
}

export interface ProxyRequest {
  readonly method: string;
  /** Path and query, as received (for example `/api/tmdb?path=/search/multi&query=x`). */
  readonly url: string;
  readonly authorization: string | undefined;
  /** The caller's address as the host reports it; absent when unknown (then no per-address limit). */
  readonly clientIp?: string | undefined;
}

export interface ProxyResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface ProxyDeps {
  readonly env: ProxyEnv;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  /** Remembers recent sign-in checks so a screenful of posters is not a screenful of auth calls. */
  readonly signInMemory?: SignInMemory;
  /** Caps requests per address, BEFORE the sign-in check (so garbage tokens cannot fan out to auth). */
  readonly clientLimiter?: RateLimiter;
  /** Caps requests per verified sign-in, AFTER the check (so a stranger cannot spend someone's budget). */
  readonly userLimiter?: RateLimiter;
}

const TMDB_BASE = 'https://api.themoviedb.org/3';
const UPSTREAM_TIMEOUT_MS = 8_000;
export const SIGN_IN_MEMORY_MS = 60_000;
const SIGN_IN_MEMORY_MAX = 500;
const MAX_BODY_BYTES = 1_000_000;

/**
 * Marks every answer from THIS implementation, so a deployment can be checked from outside
 * (`npm run check:deployment`). The older root `api/tmdb.js` does not send it.
 */
export const PROXY_MARKER_HEADER = 'X-CinemaVault-Proxy';
export const PROXY_MARKER = 'next-1';

const ID = '[1-9][0-9]{0,9}';
/** The only upstream paths, each with the only query parameters it may carry. */
const ROUTES: readonly {
  readonly path: RegExp;
  readonly params: Readonly<Partial<Record<string, RegExp>>>;
}[] = [
  {
    path: /^\/search\/multi$/,
    params: {
      query: /^[^\p{Cc}]{1,100}$/u,
      page: /^[1-5]$/,
      language: /^[a-z]{2}(-[A-Z]{2})?$/,
    },
  },
  {
    path: new RegExp(`^/(movie|tv)/${ID}/videos$`),
    params: { language: /^[a-z]{2}(-[A-Z]{2})?$/ },
  },
];

const json = (
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): ProxyResponse => ({
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    [PROXY_MARKER_HEADER]: PROXY_MARKER,
    ...extra,
  },
  body: JSON.stringify(body),
});

const fail = (status: number, code: string, message: string, extra: Record<string, string> = {}) =>
  json(status, { code, error: message }, { 'Cache-Control': 'no-store', ...extra });

export interface SignInMemory {
  has(tokenHash: string, now: number): boolean;
  add(tokenHash: string, now: number): void;
}

export function createSignInMemory(): SignInMemory {
  const seen = new Map<string, number>();
  return {
    has: (hash, now) => {
      const at = seen.get(hash);
      if (at === undefined) return false;
      if (now - at > SIGN_IN_MEMORY_MS) {
        seen.delete(hash);
        return false;
      }
      return true;
    },
    add: (hash, now) => {
      if (seen.size >= SIGN_IN_MEMORY_MAX) {
        const oldest = seen.keys().next();
        if (!oldest.done) seen.delete(oldest.value);
      }
      seen.set(hash, now);
    },
  };
}

export type RateDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface RateLimiter {
  take(key: string, now: number): RateDecision;
}

export const CLIENT_LIMIT_PER_MINUTE = 120;
export const USER_LIMIT_PER_MINUTE = 60;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_KEYS = 2_000;

/**
 * A fixed-window counter per key, held in this instance's memory.
 *
 * HONEST LIMITS: a serverless host may run several instances and restarts them freely, and each has
 * its own counters. So this bounds what ONE instance will do for one caller (it stops a runaway
 * loop or a casual abuser from draining the TMDB quota through us); it is not a global guarantee.
 * A hard, shared limit needs the host's firewall rules or a shared store (see docs/hardening.md).
 * The table is capped, so a flood of distinct keys cannot grow memory without bound.
 */
export function createRateLimiter(
  limit: number,
  windowMs: number = RATE_WINDOW_MS,
  maxKeys: number = RATE_MAX_KEYS,
): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    take(key, now) {
      if (limit < 1) return { allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) };
      const current = windows.get(key);
      if (!current || now - current.start >= windowMs) {
        if (!current && windows.size >= maxKeys) {
          // Drop expired windows first; if every key is live, drop the oldest.
          for (const [name, w] of windows) if (now - w.start >= windowMs) windows.delete(name);
          if (windows.size >= maxKeys) {
            const oldest = windows.keys().next();
            if (!oldest.done) windows.delete(oldest.value);
          }
        }
        windows.set(key, { start: now, count: 1 });
        return { allowed: true };
      }
      if (current.count >= limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((current.start + windowMs - now) / 1000)),
        };
      }
      current.count += 1;
      return { allowed: true };
    },
  };
}

const tooMany = (retryAfterSeconds: number) =>
  fail(429, 'rate_limited', 'Too many requests. Try again shortly.', {
    'Retry-After': String(retryAfterSeconds),
  });

type SignIn = 'yes' | 'no' | 'unknown';

async function checkSignedIn(token: string, deps: ProxyDeps): Promise<SignIn> {
  const url = deps.env.SUPABASE_URL ?? deps.env.VITE_SUPABASE_URL;
  const key = deps.env.SUPABASE_PUBLISHABLE_KEY ?? deps.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return 'unknown';
  const now = (deps.now ?? Date.now)();
  const hash = createHash('sha256').update(token).digest('hex');
  if (deps.signInMemory?.has(hash, now)) return 'yes';
  try {
    const reply = await deps.fetch(`${url.replace(/\/+$/, '')}/auth/v1/user`, {
      headers: { apikey: key, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (reply.ok) {
      deps.signInMemory?.add(hash, now);
      return 'yes';
    }
    // Only an explicit "no" from the auth server means signed out; a 5xx means we could not tell.
    return reply.status === 401 || reply.status === 403 ? 'no' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Validates the request against the allow-list and returns the exact upstream query, or an error. */
export function buildUpstream(
  requestUrl: string,
): { ok: true; path: string; params: URLSearchParams } | { ok: false; message: string } {
  const url = new URL(requestUrl, 'http://proxy.invalid');
  // Exactly one `path`: with several, which one selects the route must never be a guess.
  const paths = url.searchParams.getAll('path');
  if (paths.length !== 1) return { ok: false, message: 'Exactly one path is required.' };
  const path = paths[0] ?? '';
  const route = ROUTES.find((r) => r.path.test(path));
  if (!route) return { ok: false, message: 'Path not allowed.' };

  const params = new URLSearchParams();
  const seen = new Set<string>();
  for (const [name, value] of url.searchParams) {
    if (name === 'path') continue;
    const rule = route.params[name];
    if (!rule || seen.has(name)) return { ok: false, message: `Parameter not allowed: ${name}.` };
    if (!rule.test(value)) return { ok: false, message: `Invalid value for ${name}.` };
    seen.add(name);
    params.set(name, value);
  }
  if (path === '/search/multi') {
    if (!params.has('query')) return { ok: false, message: 'Missing query.' };
    params.set('include_adult', 'false');
  }
  return { ok: true, path, params };
}

/**
 * Reads an answer while counting BYTES (not string characters: a 3-byte character is one
 * `length`), and stops reading as soon as the limit is passed instead of buffering all of it.
 */
export async function readLimited(
  reply: Response,
  limit: number,
): Promise<{ readonly text: string } | { readonly error: 'too_large' | 'failed' }> {
  const declared = Number(reply.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > limit) return { error: 'too_large' };
  try {
    if (!reply.body) {
      const text = await reply.text();
      return new TextEncoder().encode(text).byteLength > limit ? { error: 'too_large' } : { text };
    }
    const reader = reply.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return { error: 'too_large' };
      }
      chunks.push(value);
    }
    const all = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { text: new TextDecoder().decode(all) };
  } catch {
    return { error: 'failed' };
  }
}

export async function handleTmdbRequest(
  request: ProxyRequest,
  deps: ProxyDeps,
): Promise<ProxyResponse> {
  if (request.method !== 'GET')
    return fail(405, 'method_not_allowed', 'Method not allowed.', { Allow: 'GET' });

  const key = deps.env.TMDB_API_KEY;
  if (!key) return fail(501, 'not_configured', 'TMDB_API_KEY is not configured on the server.');

  const token = /^Bearer\s+(\S+)$/i.exec(request.authorization ?? '')?.[1];
  if (!token) return fail(401, 'unauthenticated', 'Sign in required.');
  const now = (deps.now ?? Date.now)();
  if (deps.clientLimiter && request.clientIp) {
    const decision = deps.clientLimiter.take(request.clientIp, now);
    if (!decision.allowed) return tooMany(decision.retryAfterSeconds);
  }
  const signedIn = await checkSignedIn(token, deps);
  if (signedIn === 'no') return fail(401, 'unauthenticated', 'Sign in required.');
  if (signedIn === 'unknown') {
    return fail(503, 'auth_unavailable', 'Could not check your sign-in right now.');
  }
  if (deps.userLimiter) {
    const decision = deps.userLimiter.take(createHash('sha256').update(token).digest('hex'), now);
    if (!decision.allowed) return tooMany(decision.retryAfterSeconds);
  }

  const upstream = buildUpstream(request.url);
  if (!upstream.ok) return fail(400, 'bad_request', upstream.message);

  const headers: Record<string, string> = { Accept: 'application/json' };
  // Supports both a v3 API key and a v4 "read access token" (a long JWT).
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  else upstream.params.set('api_key', key);

  let reply: Response;
  try {
    reply = await deps.fetch(`${TMDB_BASE}${upstream.path}?${upstream.params.toString()}`, {
      headers,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return fail(502, 'upstream_unreachable', 'TMDB request failed.');
  }

  // A 401/403 from TMDB means OUR key is wrong. Never pass it on as 401, which the browser would
  // read as "you are signed out".
  if (reply.status === 401 || reply.status === 403) {
    return fail(502, 'upstream_rejected_key', 'TMDB rejected the API key. Check TMDB_API_KEY.');
  }
  if (reply.status === 429) {
    const wait = reply.headers.get('Retry-After');
    return fail(
      429,
      'rate_limited',
      'TMDB is busy. Try again shortly.',
      wait ? { 'Retry-After': wait } : {},
    );
  }
  if (reply.status === 404) return fail(404, 'not_found', 'Not found.');
  if (!reply.ok) return fail(502, 'upstream_error', 'TMDB request failed.');

  const body = await readLimited(reply, MAX_BODY_BYTES);
  if ('error' in body) {
    return fail(
      502,
      'upstream_error',
      body.error === 'too_large' ? 'TMDB answer was too large.' : 'TMDB request failed.',
    );
  }
  const { text } = body;
  try {
    JSON.parse(text);
  } catch {
    return fail(502, 'upstream_error', 'TMDB answer was not valid.');
  }
  return {
    status: 200,
    // Private: the answer follows a signed-in request, so shared caches must not keep it.
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, max-age=86400',
      [PROXY_MARKER_HEADER]: PROXY_MARKER,
    },
    // Belt and braces: the key must not travel back even if an upstream answer were to echo it.
    body: text.split(key).join('[redacted]'),
  };
}

/** Node-style adapter for Vercel. Everything testable lives in `handleTmdbRequest`. */
interface NodeRequest {
  method?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}
interface NodeResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body: string): void;
}

const signInMemory = createSignInMemory();
const clientLimiter = createRateLimiter(CLIENT_LIMIT_PER_MINUTE);
const userLimiter = createRateLimiter(USER_LIMIT_PER_MINUTE);

/** The caller's address. On Vercel the platform sets these, overwriting anything the caller sent. */
function clientAddress(headers: NodeRequest['headers']): string | undefined {
  const raw = headers['x-vercel-forwarded-for'] ?? headers['x-forwarded-for'];
  const first = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim();
  return first !== undefined && first !== '' ? first : undefined;
}

export default async function handler(req: NodeRequest, res: NodeResponse): Promise<void> {
  const authorization = req.headers.authorization;
  const result = await handleTmdbRequest(
    {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      authorization: Array.isArray(authorization) ? authorization[0] : authorization,
      clientIp: clientAddress(req.headers),
    },
    { env: process.env, fetch, signInMemory, clientLimiter, userLimiter },
  );
  res.statusCode = result.status;
  for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
  res.end(result.body);
}
