import { describe, expect, it, vi } from 'vitest';
import {
  PROXY_MARKER,
  PROXY_MARKER_HEADER,
  SIGN_IN_MEMORY_MS,
  buildUpstream,
  createRateLimiter,
  createSignInMemory,
  handleTmdbRequest,
  type ProxyEnv,
  type ProxyRequest,
} from '../../api/tmdb';

const KEY = 'tmdb-secret-key-1234567890';
const ENV: ProxyEnv = {
  TMDB_API_KEY: KEY,
  SUPABASE_URL: 'https://dev-project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_dev',
};

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
}

function fakeFetch(opts: { auth?: number; tmdb?: () => Response | Promise<Response> } = {}) {
  const calls: Call[] = [];
  const impl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    if (url.includes('/auth/v1/user')) {
      return Promise.resolve(new Response('{}', { status: opts.auth ?? 200 }));
    }
    const make =
      opts.tmdb ?? (() => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    return Promise.resolve(make());
  });
  return {
    fetch: impl as unknown as typeof fetch,
    calls,
    authCalls: () => calls.filter((c) => c.url.includes('/auth/')),
  };
}

const req = (over: Partial<ProxyRequest> = {}): ProxyRequest => ({
  method: 'GET',
  url: '/api/tmdb?path=/search/multi&query=Inception',
  authorization: 'Bearer user-token',
  ...over,
});

const upstreamOf = (calls: Call[]) =>
  calls.find((c) => c.url.startsWith('https://api.themoviedb.org'));

describe('who may call the proxy', () => {
  it('refuses a request with no sign-in and never touches TMDB', async () => {
    const f = fakeFetch();
    const r = await handleTmdbRequest(req({ authorization: undefined }), {
      env: ENV,
      fetch: f.fetch,
    });
    expect(r.status).toBe(401);
    expect(f.calls).toHaveLength(0);
  });

  it('refuses a malformed Authorization header', async () => {
    const f = fakeFetch();
    for (const authorization of ['user-token', 'Basic abc', 'Bearer', 'Bearer a b']) {
      const r = await handleTmdbRequest(req({ authorization }), { env: ENV, fetch: f.fetch });
      expect(r.status).toBe(401);
    }
    expect(f.calls).toHaveLength(0);
  });

  it('refuses a token the auth server rejects', async () => {
    const f = fakeFetch({ auth: 401 });
    const r = await handleTmdbRequest(req(), { env: ENV, fetch: f.fetch });
    expect(r.status).toBe(401);
    expect(upstreamOf(f.calls)).toBeUndefined();
  });

  it('checks the sign-in against THIS deployment’s own project, with the user’s token', async () => {
    const f = fakeFetch();
    await handleTmdbRequest(req(), { env: ENV, fetch: f.fetch });
    const auth = f.authCalls()[0];
    expect(auth?.url).toBe('https://dev-project.supabase.co/auth/v1/user');
    expect(auth?.headers).toMatchObject({
      Authorization: 'Bearer user-token',
      apikey: 'sb_publishable_dev',
    });
  });

  it('falls back to the VITE_ variables when the server ones are absent', async () => {
    const f = fakeFetch();
    const r = await handleTmdbRequest(req(), {
      env: {
        TMDB_API_KEY: KEY,
        VITE_SUPABASE_URL: 'https://vite.supabase.co/',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'k',
      },
      fetch: f.fetch,
    });
    expect(r.status).toBe(200);
    expect(f.authCalls()[0]?.url).toBe('https://vite.supabase.co/auth/v1/user');
  });

  it('says 503 — not 401 — when the auth server cannot be reached or is unconfigured', async () => {
    const broken = fakeFetch({ auth: 500 });
    expect((await handleTmdbRequest(req(), { env: ENV, fetch: broken.fetch })).status).toBe(503);
    const down = vi.fn(() => Promise.reject(new Error('net'))) as unknown as typeof fetch;
    expect((await handleTmdbRequest(req(), { env: ENV, fetch: down })).status).toBe(503);
    const f = fakeFetch();
    const r = await handleTmdbRequest(req(), { env: { TMDB_API_KEY: KEY }, fetch: f.fetch });
    expect(r.status).toBe(503);
    expect(f.calls).toHaveLength(0);
  });

  it('says 501 when the TMDB key is not configured, before anything else is called', async () => {
    const f = fakeFetch();
    const r = await handleTmdbRequest(req(), {
      env: { ...ENV, TMDB_API_KEY: undefined },
      fetch: f.fetch,
    });
    expect(r.status).toBe(501);
    expect(f.calls).toHaveLength(0);
  });

  it('only allows GET', async () => {
    const f = fakeFetch();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await handleTmdbRequest(req({ method }), { env: ENV, fetch: f.fetch });
      expect(r.status).toBe(405);
      expect(r.headers.Allow).toBe('GET');
    }
    expect(f.calls).toHaveLength(0);
  });
});

describe('remembering a recent sign-in check', () => {
  it('skips the auth call for the same token within a minute, and asks again afterwards', async () => {
    const f = fakeFetch();
    const memory = createSignInMemory();
    let now = 1_000;
    const deps = { env: ENV, fetch: f.fetch, signInMemory: memory, now: () => now };
    await handleTmdbRequest(req(), deps);
    await handleTmdbRequest(req(), deps);
    expect(f.authCalls()).toHaveLength(1);
    now += SIGN_IN_MEMORY_MS + 1;
    await handleTmdbRequest(req(), deps);
    expect(f.authCalls()).toHaveLength(2);
  });

  it('does not remember a rejected token, nor share one token’s check with another', async () => {
    const memory = createSignInMemory();
    const rejecting = fakeFetch({ auth: 401 });
    await handleTmdbRequest(req(), { env: ENV, fetch: rejecting.fetch, signInMemory: memory });
    await handleTmdbRequest(req(), { env: ENV, fetch: rejecting.fetch, signInMemory: memory });
    expect(rejecting.authCalls()).toHaveLength(2);

    const f = fakeFetch();
    await handleTmdbRequest(req({ authorization: 'Bearer one' }), {
      env: ENV,
      fetch: f.fetch,
      signInMemory: memory,
    });
    await handleTmdbRequest(req({ authorization: 'Bearer two' }), {
      env: ENV,
      fetch: f.fetch,
      signInMemory: memory,
    });
    expect(f.authCalls()).toHaveLength(2);
  });

  it('is bounded', () => {
    const memory = createSignInMemory();
    for (let i = 0; i < 600; i++) memory.add(`t${String(i)}`, 1);
    expect(memory.has('t0', 2)).toBe(false);
    expect(memory.has('t599', 2)).toBe(true);
  });
});

describe('what may be asked of TMDB', () => {
  const ok = (path: string) => buildUpstream(`/api/tmdb?path=${path}`);

  it('allows search and video lookups only', () => {
    expect(ok('/search/multi&query=x').ok).toBe(true);
    expect(ok('/movie/27205/videos').ok).toBe(true);
    expect(ok('/tv/1396/videos&language=en-US').ok).toBe(true);
  });

  it.each([
    '/account',
    '/movie/27205',
    '/movie/27205/videos/extra',
    '/movie/abc/videos',
    '/movie/0/videos',
    '/movie/12345678901/videos',
    '/search/person&query=x',
    '/search/multi/../../account',
    '//evil.example/search/multi',
    '/authentication/token/new',
    '',
  ])('rejects the path %s', (path) => {
    expect(ok(path).ok).toBe(false);
  });

  it('rejects unknown, repeated and invalid parameters', () => {
    expect(buildUpstream('/api/tmdb?path=/search/multi&query=x&api_key=mine').ok).toBe(false);
    expect(buildUpstream('/api/tmdb?path=/search/multi&query=x&include_adult=true').ok).toBe(false);
    expect(buildUpstream('/api/tmdb?path=/search/multi&query=x&query=y').ok).toBe(false);
    expect(buildUpstream('/api/tmdb?path=/search/multi&query=x&page=9').ok).toBe(false);
    expect(buildUpstream('/api/tmdb?path=/search/multi&query=x&language=english').ok).toBe(false);
    expect(buildUpstream('/api/tmdb?path=/search/multi').ok).toBe(false);
    expect(buildUpstream(`/api/tmdb?path=/search/multi&query=${'a'.repeat(101)}`).ok).toBe(false);
    expect(buildUpstream('/api/tmdb?path=/search/multi&query=').ok).toBe(false);
    expect(buildUpstream('/api/tmdb?path=/movie/1/videos&query=x').ok).toBe(false);
  });

  it('always forces adult results off', () => {
    const r = buildUpstream('/api/tmdb?path=/search/multi&query=x');
    expect(r.ok && r.params.get('include_adult')).toBe('false');
  });

  it('answers 400 for a bad request and sends nothing to TMDB', async () => {
    const f = fakeFetch();
    const r = await handleTmdbRequest(req({ url: '/api/tmdb?path=/account' }), {
      env: ENV,
      fetch: f.fetch,
    });
    expect(r.status).toBe(400);
    expect(upstreamOf(f.calls)).toBeUndefined();
  });
});

describe('talking to TMDB', () => {
  it('uses a v3 key as a query parameter', async () => {
    const f = fakeFetch();
    await handleTmdbRequest(req(), { env: ENV, fetch: f.fetch });
    const call = upstreamOf(f.calls);
    expect(call?.url).toContain('https://api.themoviedb.org/3/search/multi?');
    expect(call?.url).toContain(`api_key=${KEY}`);
    expect(call?.url).toContain('query=Inception');
    expect(call?.url).toContain('include_adult=false');
    expect(call?.headers.Authorization).toBeUndefined();
  });

  it('uses a v4 read token as a bearer header, not in the URL', async () => {
    const f = fakeFetch();
    const token = 'eyJhbGciOi.payload.sig';
    await handleTmdbRequest(req(), { env: { ...ENV, TMDB_API_KEY: token }, fetch: f.fetch });
    const call = upstreamOf(f.calls);
    expect(call?.headers.Authorization).toBe(`Bearer ${token}`);
    expect(call?.url).not.toContain('api_key');
    expect(call?.url).not.toContain(token);
  });

  it('never sends the user’s token to TMDB', async () => {
    const f = fakeFetch();
    await handleTmdbRequest(req(), { env: ENV, fetch: f.fetch });
    const call = upstreamOf(f.calls);
    expect(JSON.stringify(call)).not.toContain('user-token');
  });

  it('returns the answer as private, cacheable JSON', async () => {
    const f = fakeFetch({ tmdb: () => new Response('{"results":[{"id":1}]}', { status: 200 }) });
    const r = await handleTmdbRequest(req(), { env: ENV, fetch: f.fetch });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ results: [{ id: 1 }] });
    expect(r.headers['Cache-Control']).toBe('private, max-age=86400');
    expect(r.headers['Content-Type']).toContain('application/json');
  });

  it('redacts the key even if an upstream answer echoes it', async () => {
    const f = fakeFetch({
      tmdb: () => new Response(JSON.stringify({ echo: `x${KEY}y` }), { status: 200 }),
    });
    const r = await handleTmdbRequest(req(), { env: ENV, fetch: f.fetch });
    expect(r.body).not.toContain(KEY);
    expect(r.body).toContain('[redacted]');
  });

  it('never reports a wrong TMDB key as a sign-out', async () => {
    for (const status of [401, 403]) {
      const f = fakeFetch({ tmdb: () => new Response('{}', { status }) });
      const r = await handleTmdbRequest(req(), { env: ENV, fetch: f.fetch });
      expect(r.status).toBe(502);
      expect(JSON.parse(r.body)).toMatchObject({ code: 'upstream_rejected_key' });
    }
  });

  it('passes rate limiting through with Retry-After, and maps the other failures', async () => {
    const limited = fakeFetch({
      tmdb: () => new Response('{}', { status: 429, headers: { 'Retry-After': '7' } }),
    });
    const a = await handleTmdbRequest(req(), { env: ENV, fetch: limited.fetch });
    expect(a.status).toBe(429);
    expect(a.headers['Retry-After']).toBe('7');

    const missing = fakeFetch({ tmdb: () => new Response('{}', { status: 404 }) });
    expect((await handleTmdbRequest(req(), { env: ENV, fetch: missing.fetch })).status).toBe(404);

    const broken = fakeFetch({ tmdb: () => new Response('oops', { status: 500 }) });
    expect((await handleTmdbRequest(req(), { env: ENV, fetch: broken.fetch })).status).toBe(502);

    const garbage = fakeFetch({ tmdb: () => new Response('<html>', { status: 200 }) });
    expect((await handleTmdbRequest(req(), { env: ENV, fetch: garbage.fetch })).status).toBe(502);

    const huge = fakeFetch({
      tmdb: () => new Response(`"${'a'.repeat(1_100_000)}"`, { status: 200 }),
    });
    expect((await handleTmdbRequest(req(), { env: ENV, fetch: huge.fetch })).status).toBe(502);

    const down = fakeFetch({ tmdb: () => Promise.reject(new Error('net')) });
    expect((await handleTmdbRequest(req(), { env: ENV, fetch: down.fetch })).status).toBe(502);
  });

  it('never puts the key in an error answer', async () => {
    const f = fakeFetch({ tmdb: () => new Response(`bad ${KEY}`, { status: 500 }) });
    const r = await handleTmdbRequest(req(), { env: ENV, fetch: f.fetch });
    expect(r.body).not.toContain(KEY);
    expect(r.headers['Cache-Control']).toBe('no-store');
  });
});

describe('review fixes: one path, bytes not characters, a marker on every answer', () => {
  it('rejects a request with two path parameters, whichever order, and sends nothing to TMDB', async () => {
    for (const url of [
      '/api/tmdb?path=/search/multi&path=/account&query=x',
      '/api/tmdb?path=/account&path=/search/multi&query=x',
      '/api/tmdb?path=/search/multi&path=/search/multi&query=x',
    ]) {
      const f = fakeFetch();
      const r = await handleTmdbRequest(req({ url }), { env: ENV, fetch: f.fetch });
      expect(r.status).toBe(400);
      expect(upstreamOf(f.calls)).toBeUndefined();
    }
    expect(buildUpstream('/api/tmdb?query=x').ok).toBe(false); // none at all
  });

  it('measures the answer in bytes: 400k three-byte characters are 1.2 MB, not 400k', async () => {
    const f = fakeFetch({
      tmdb: () => new Response(JSON.stringify({ t: '€'.repeat(400_000) }), { status: 200 }),
    });
    const r = await handleTmdbRequest(req(), { env: ENV, fetch: f.fetch });
    expect(r.status).toBe(502);
    expect(JSON.parse(r.body)).toMatchObject({ code: 'upstream_error' });
  });

  it('accepts a multi-byte answer that is under the limit', async () => {
    const f = fakeFetch({
      tmdb: () => new Response(JSON.stringify({ t: 'é'.repeat(100_000) }), { status: 200 }),
    });
    expect((await handleTmdbRequest(req(), { env: ENV, fetch: f.fetch })).status).toBe(200);
  });

  it('refuses early on a declared Content-Length, and stops reading a stream that runs past the limit', async () => {
    const declared = fakeFetch({
      tmdb: () => new Response('{}', { status: 200, headers: { 'Content-Length': '5000000' } }),
    });
    expect((await handleTmdbRequest(req(), { env: ENV, fetch: declared.fetch })).status).toBe(502);

    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(100_000).fill(97));
        if (pulls > 1000) controller.close();
      },
    });
    const f = fakeFetch({ tmdb: () => new Response(endless, { status: 200 }) });
    expect((await handleTmdbRequest(req(), { env: ENV, fetch: f.fetch })).status).toBe(502);
    expect(pulls).toBeLessThan(50); // it gave up at about 1 MB instead of reading it all
  });

  it('a stream failing half-way is a 502, not a crash', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('reset'));
      },
    });
    const f = fakeFetch({ tmdb: () => new Response(broken, { status: 200 }) });
    expect((await handleTmdbRequest(req(), { env: ENV, fetch: f.fetch })).status).toBe(502);
  });

  it('marks every answer — success and each kind of failure — as coming from this implementation', async () => {
    const f = fakeFetch();
    const answers = [
      await handleTmdbRequest(req(), { env: ENV, fetch: f.fetch }), // 200
      await handleTmdbRequest(req({ authorization: undefined }), { env: ENV, fetch: f.fetch }), // 401
      await handleTmdbRequest(req({ method: 'POST' }), { env: ENV, fetch: f.fetch }), // 405
      await handleTmdbRequest(req({ url: '/api/tmdb?path=/account' }), {
        env: ENV,
        fetch: f.fetch,
      }), // 400
      await handleTmdbRequest(req(), { env: { ...ENV, TMDB_API_KEY: undefined }, fetch: f.fetch }), // 501
    ];
    expect(answers.map((a) => a.status)).toEqual([200, 401, 405, 400, 501]);
    for (const a of answers) expect(a.headers[PROXY_MARKER_HEADER]).toBe(PROXY_MARKER);
  });
});

describe('rate limiting', () => {
  const clock = (start = 1_000_000) => {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it('createRateLimiter: allows up to the limit per key, then says how long to wait', () => {
    const limiter = createRateLimiter(3, 60_000);
    expect([1, 2, 3].map(() => limiter.take('a', 0).allowed)).toEqual([true, true, true]);
    const refused = limiter.take('a', 10_000);
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 50 });
    expect(limiter.take('b', 10_000).allowed).toBe(true); // another key is unaffected
    expect(limiter.take('a', 60_000).allowed).toBe(true); // a new window starts
  });

  it('createRateLimiter: a flood of distinct keys cannot grow it past its cap', () => {
    const limiter = createRateLimiter(1, 60_000, 5);
    for (let i = 0; i < 50; i += 1) expect(limiter.take(`k${String(i)}`, i).allowed).toBe(true);
    // The newest keys are still remembered; the oldest were dropped.
    expect(limiter.take('k49', 100).allowed).toBe(false);
    expect(limiter.take('k0', 100).allowed).toBe(true);
  });

  it('refuses a signed-in user over the limit with 429 + Retry-After, and never calls TMDB', async () => {
    const f = fakeFetch();
    const time = clock();
    const deps = {
      env: ENV,
      fetch: f.fetch,
      now: time.now,
      signInMemory: createSignInMemory(),
      userLimiter: createRateLimiter(2),
    };
    expect((await handleTmdbRequest(req(), deps)).status).toBe(200);
    expect((await handleTmdbRequest(req(), deps)).status).toBe(200);
    const tmdbCallsBefore = f.calls.filter((c) => c.url.includes('themoviedb')).length;
    const third = await handleTmdbRequest(req(), deps);
    expect(third.status).toBe(429);
    expect(third.headers['Retry-After']).toBe('60');
    expect(JSON.parse(third.body)).toMatchObject({ code: 'rate_limited' });
    expect(f.calls.filter((c) => c.url.includes('themoviedb')).length).toBe(tmdbCallsBefore);
    time.advance(61_000);
    expect((await handleTmdbRequest(req(), deps)).status).toBe(200);
  });

  it('one user’s budget is not another’s', async () => {
    const f = fakeFetch();
    const deps = { env: ENV, fetch: f.fetch, userLimiter: createRateLimiter(1) };
    expect((await handleTmdbRequest(req({ authorization: 'Bearer one' }), deps)).status).toBe(200);
    expect((await handleTmdbRequest(req({ authorization: 'Bearer one' }), deps)).status).toBe(429);
    expect((await handleTmdbRequest(req({ authorization: 'Bearer two' }), deps)).status).toBe(200);
  });

  it('a rejected token never spends a real user’s budget, but the address limit still stops a flood of them', async () => {
    const f = fakeFetch({ auth: 401 });
    const deps = {
      env: ENV,
      fetch: f.fetch,
      clientLimiter: createRateLimiter(3),
      userLimiter: createRateLimiter(1),
    };
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await handleTmdbRequest(
        req({ authorization: `Bearer junk-${String(i)}`, clientIp: '203.0.113.9' }),
        deps,
      );
      statuses.push(r.status);
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    // The 4th and 5th never reached the auth server.
    expect(f.authCalls()).toHaveLength(3);
  });

  it('does not limit by address when the host reports none, and is off when no limiter is given', async () => {
    const f = fakeFetch();
    const deps = { env: ENV, fetch: f.fetch, clientLimiter: createRateLimiter(1) };
    for (let i = 0; i < 4; i += 1) expect((await handleTmdbRequest(req(), deps)).status).toBe(200);
    const bare = { env: ENV, fetch: f.fetch };
    for (let i = 0; i < 4; i += 1) {
      expect((await handleTmdbRequest(req({ clientIp: '198.51.100.1' }), bare)).status).toBe(200);
    }
  });

  it('answers 429 from the limiter with the same marker header as every other answer', async () => {
    const f = fakeFetch();
    const deps = { env: ENV, fetch: f.fetch, userLimiter: createRateLimiter(0) };
    const r = await handleTmdbRequest(req(), deps);
    expect(r.status).toBe(429);
    expect(r.headers[PROXY_MARKER_HEADER]).toBe(PROXY_MARKER);
  });
});
