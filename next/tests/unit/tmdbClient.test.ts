import { describe, expect, it, vi } from 'vitest';
import { TmdbError, createTmdbClient } from '../../src/services/tmdb/tmdbClient';

const answer = (body: unknown, init: ResponseInit = { status: 200 }) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, ...init });

function client(reply: () => Response | Promise<Response>, token: string | null = 'tok') {
  const fetchMock = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(reply()),
  );
  return {
    fetchMock,
    api: createTmdbClient({
      getToken: () => Promise.resolve(token),
      fetch: fetchMock,
    }),
  };
}

const failureOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof TmdbError) return e.failure;
    throw e;
  }
  return 'no error';
};

describe('requests', () => {
  it('sends the path and query to the proxy with the user’s token', async () => {
    const { api, fetchMock } = client(() => answer({ results: [] }));
    await api.search('Heat');
    const call = fetchMock.mock.calls[0];
    expect(call?.[0] as string).toBe('/api/tmdb?path=%2Fsearch%2Fmulti&query=Heat');
    expect((call?.[1]?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('asks for videos by media type and id', async () => {
    const { api, fetchMock } = client(() => answer({ results: [] }));
    await api.videos('tv', 1396);
    expect(fetchMock.mock.calls[0]?.[0] as string).toContain('path=%2Ftv%2F1396%2Fvideos');
  });

  it('does not call anything when signed out', async () => {
    const { api, fetchMock } = client(() => answer({}), null);
    expect(await failureOf(api.search('x'))).toBe('signed_out');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('answers', () => {
  it('keeps movies and shows, drops people, and skips malformed entries', async () => {
    const { api } = client(() =>
      answer({
        results: [
          { id: 1, media_type: 'movie', title: 'A', poster_path: '/a.jpg' },
          { id: 2, media_type: 'person', name: 'P' },
          { id: 3, media_type: 'tv', name: 'T', poster_path: 'https://evil.example/x.jpg' },
          { id: 'x', media_type: 'movie' },
          { id: 4, media_type: 'tv', name: 'T2', poster_path: null },
        ],
      }),
    );
    expect((await api.search('x')).map((r) => r.id)).toEqual([1, 4]);
  });

  it('keeps only well-formed video ids', async () => {
    const { api } = client(() =>
      answer({
        results: [
          { site: 'YouTube', type: 'Trailer', key: 'abcDEF12345' },
          { site: 'YouTube', type: 'Trailer', key: '"><script>' },
        ],
      }),
    );
    expect((await api.videos('movie', 1)).map((v) => v.key)).toEqual(['abcDEF12345']);
  });

  it('rejects an answer of the wrong shape', async () => {
    const { api } = client(() => answer({ nope: true }));
    expect(await failureOf(api.search('x'))).toBe('unavailable');
  });
});

describe('failures', () => {
  it.each([
    [401, 'signed_out'],
    [405, 'not_configured'],
    [501, 'not_configured'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [502, 'unavailable'],
    [503, 'unavailable'],
  ])('status %i is %s', async (status, expected) => {
    const { api } = client(() => answer({ error: 'x' }, { status }));
    expect(await failureOf(api.search('x'))).toBe(expected);
  });

  it('treats an HTML 404 (no proxy deployed) as not configured, but a JSON 404 as unavailable', async () => {
    const html = client(
      () => new Response('<html>', { status: 404, headers: { 'Content-Type': 'text/html' } }),
    );
    expect(await failureOf(html.api.search('x'))).toBe('not_configured');
    const json = client(() => answer({ code: 'not_found' }, { status: 404 }));
    expect(await failureOf(json.api.search('x'))).toBe('unavailable');
  });

  it('treats a network error and unreadable JSON as unavailable', async () => {
    const down = client(() => Promise.reject(new TypeError('offline')));
    expect(await failureOf(down.api.search('x'))).toBe('unavailable');
    const junk = client(() => new Response('<<', { status: 200 }));
    expect(await failureOf(junk.api.search('x'))).toBe('unavailable');
  });

  it('lets a caller’s own abort through unchanged', async () => {
    const controller = new AbortController();
    const { api } = client(() => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(api.search('x', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
