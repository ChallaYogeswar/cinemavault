import { describe, expect, it } from 'vitest';
import { handleTmdbRequest, type ProxyEnv } from '../../api/tmdb';
// @ts-expect-error -- a plain .mjs script with no type declarations
import { probe } from '../../scripts/check-deployment.mjs';

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
type Probe = (
  base: string,
  options: { token?: string; bypass?: string; fetchImpl: typeof fetch },
) => Promise<Check[]>;
const run = probe as Probe;

/** A fetch that hands requests for the deployment to the real handler, and answers the auth server and TMDB. */
function deployment(env: ProxyEnv): typeof fetch {
  const upstream = (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/auth/v1/user')) return Promise.resolve(new Response('{}', { status: 200 }));
    return Promise.resolve(new Response('{"results":[]}', { status: 200 }));
  };
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const result = await handleTmdbRequest(
      {
        method: 'GET',
        url: url.slice(url.indexOf('/api/tmdb')),
        authorization: headers.get('Authorization') ?? undefined,
      },
      { env, fetch: upstream },
    );
    return new Response(result.body, { status: result.status, headers: result.headers });
  };
}

const ENV: ProxyEnv = {
  TMDB_API_KEY: 'k',
  SUPABASE_URL: 'https://dev.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'p',
};

describe('check:deployment', () => {
  it('sends the automation-bypass header on every call, and only when given', async () => {
    const seen: (string | null)[] = [];
    const spy: typeof fetch = (input, init) => {
      seen.push(new Headers(init?.headers).get('x-vercel-protection-bypass'));
      return deployment(ENV)(input, init);
    };
    await run('https://preview.example', { token: 'jwt', bypass: 'secret', fetchImpl: spy });
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.every((value) => value === 'secret')).toBe(true);

    seen.length = 0;
    await run('https://preview.example', { token: 'jwt', fetchImpl: spy });
    expect(seen.every((value) => value === null)).toBe(true);
  });

  it('recognises the new proxy and passes every signed-out and signed-in check', async () => {
    const checks = await run('https://preview.example', {
      token: 'jwt',
      fetchImpl: deployment(ENV),
    });
    expect(checks.map((c) => c.name)).toHaveLength(6);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('runs only the signed-out checks without a token', async () => {
    const checks = await run('https://preview.example', { fetchImpl: deployment(ENV) });
    expect(checks).toHaveLength(2);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it('fails loudly, naming the Root Directory, when the OLD proxy is the one answering', async () => {
    // The legacy function answers 401 too, but never sends the marker header.
    const legacy = (() =>
      Promise.resolve(new Response('{"error":"Unauthorized"}', { status: 401 }))) as typeof fetch;
    const checks = await run('https://preview.example', { token: 'jwt', fetchImpl: legacy });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.ok).toBe(false);
    expect(checks[0]?.detail).toMatch(/Root Directory is not "next"/);
  });

  it('fails when nothing is deployed or the host is unreachable', async () => {
    const none = (() => Promise.resolve(new Response('<html>', { status: 404 }))) as typeof fetch;
    expect((await run('https://x.example', { fetchImpl: none }))[0]?.ok).toBe(false);
    const down = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    const checks = await run('https://x.example', { fetchImpl: down });
    expect(checks[0]?.detail).toMatch(/could not reach/);
  });

  it('fails when the deployment accepts a request with two path parameters', async () => {
    const real = deployment(ENV);
    const lax = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('path=/search/multi&path=/account')) {
        return Promise.resolve(
          new Response('{}', { status: 200, headers: { 'X-CinemaVault-Proxy': 'next-1' } }),
        );
      }
      return real(input, init);
    }) as typeof fetch;
    const checks = await run('https://x.example', { token: 'jwt', fetchImpl: lax });
    expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['two path parameters: 400']);
  });

  it('reports a missing TMDB key', async () => {
    const checks = await run('https://x.example', {
      token: 'jwt',
      fetchImpl: deployment({ ...ENV, TMDB_API_KEY: undefined }),
    });
    // 501 is answered before the sign-in is looked at, so the signed-out probe sees it
    expect(checks.some((c) => !c.ok && /TMDB_API_KEY|401/.test(c.name))).toBe(true);
  });
});
