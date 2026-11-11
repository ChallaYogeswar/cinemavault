import { describe, expect, it, vi } from 'vitest';
import type { MetadataStore, StoredMetadata } from '../../src/data/local/deviceData';
import {
  FOUND_TTL_MS,
  MAX_PARALLEL,
  NONE_TTL_MS,
  NOT_CONFIGURED_PAUSE_MS,
  RATE_LIMIT_PAUSE_MS,
  createMetadataService,
  pickTrailer,
} from '../../src/services/tmdb/metadataService';
import {
  TmdbError,
  type SearchItem,
  type TmdbClient,
  type Video,
} from '../../src/services/tmdb/tmdbClient';

const item = (over: Partial<SearchItem> = {}): SearchItem => ({
  id: 27205,
  media_type: 'movie',
  title: 'Inception',
  release_date: '2010-07-16',
  poster_path: '/p.jpg',
  backdrop_path: '/b.jpg',
  vote_average: 8.364,
  overview: 'Dreams.',
  ...over,
});

function memoryStore() {
  const rows = new Map<string, StoredMetadata>();
  const store: MetadataStore = {
    get: (u, k) => Promise.resolve(rows.get(`${u}|${k}`) ?? null),
    put: (u, k, value, at) => {
      rows.set(`${u}|${k}`, { value, savedAt: at.toISOString() });
      return Promise.resolve();
    },
    clear: (u) => {
      for (const key of [...rows.keys()]) if (key.startsWith(`${u}|`)) rows.delete(key);
      return Promise.resolve();
    },
  };
  return { store, rows };
}

function setup(over: Partial<TmdbClient> = {}) {
  // By default TMDB "finds" a title called exactly what was searched for.
  const search = vi.fn((q: string) => Promise.resolve([item({ title: q })]));
  const videos = vi.fn((_t: 'movie' | 'tv', _id: number) => Promise.resolve<Video[]>([]));
  const client: TmdbClient = { search, videos, ...over };
  const mem = memoryStore();
  let clock = Date.parse('2026-11-04T00:00:00Z');
  const service = createMetadataService({ client, store: mem.store, now: () => new Date(clock) });
  return { service, search, videos, mem, advance: (ms: number) => (clock += ms) };
}

const TARGET = { title: 'Inception', year: 2010, mediaType: 'movie' } as const;

describe('lookup', () => {
  it('finds, rounds the rating and stores paths only', async () => {
    const { service, mem } = setup();
    const r = await service.lookup('u1', TARGET);
    expect(r).toEqual({
      kind: 'found',
      metadata: {
        tmdbId: 27205,
        mediaType: 'movie',
        posterPath: '/p.jpg',
        backdropPath: '/b.jpg',
        voteAverage: 8.4,
        overview: 'Dreams.',
        matchedTitle: 'Inception',
        matchedYear: 2010,
      },
    });
    expect([...mem.rows.keys()]).toHaveLength(1);
    expect(JSON.stringify([...mem.rows.values()])).not.toContain('http');
  });

  it('answers a second ask from the device, not the network', async () => {
    const { service, search } = setup();
    await service.lookup('u1', TARGET);
    const again = await service.lookup('u1', TARGET);
    expect(again.kind).toBe('found');
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('keeps accounts apart', async () => {
    const { service, search } = setup();
    await service.lookup('u1', TARGET);
    await service.lookup('u2', TARGET);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('asks again once a stored poster is 30 days old', async () => {
    const { service, search, advance } = setup();
    await service.lookup('u1', TARGET);
    advance(FOUND_TTL_MS - 1);
    await service.lookup('u1', TARGET);
    expect(search).toHaveBeenCalledTimes(1);
    advance(2);
    await service.lookup('u1', TARGET);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('remembers "nothing found" for 7 days only', async () => {
    const search = vi.fn((_q: string) => Promise.resolve<SearchItem[]>([]));
    const { service, advance } = setup({ search });
    expect((await service.lookup('u1', TARGET)).kind).toBe('none');
    advance(NONE_TTL_MS - 1);
    expect((await service.lookup('u1', TARGET)).kind).toBe('none');
    expect(search).toHaveBeenCalledTimes(1);
    advance(2);
    await service.lookup('u1', TARGET);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('shares one request between simultaneous asks for the same title', async () => {
    const { service, search } = setup();
    await Promise.all([
      service.lookup('u1', TARGET),
      service.lookup('u1', TARGET),
      service.lookup('u1', { ...TARGET }),
    ]);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('never shares an in-flight request between two accounts, and stores the answer for each', async () => {
    const { service, search, mem } = setup();
    await Promise.all([service.lookup('u1', TARGET), service.lookup('u2', TARGET)]);
    expect(search).toHaveBeenCalledTimes(2);
    expect([...mem.rows.keys()].map((k) => k.split('|')[0]).sort()).toEqual(['u1', 'u2']);
  });

  it('retries once without leading symbols', async () => {
    const search = vi.fn((q: string) =>
      Promise.resolve(q === 'Alive' ? [item({ id: 9, title: 'Alive' })] : []),
    );
    const { service } = setup({ search });
    const r = await service.lookup('u1', { title: '#Alive', year: null, mediaType: 'movie' });
    expect(search.mock.calls.map((c) => c[0])).toEqual(['#Alive', 'Alive']);
    expect(r.kind === 'found' && r.metadata.tmdbId).toBe(9);
  });

  it('strips tags before searching, and treats an empty title as nothing found without a request', async () => {
    const { service, search } = setup();
    await service.lookup('u1', { title: 'Dark (Series)', year: null, mediaType: 'movie' });
    expect(search.mock.calls[0]?.[0]).toBe('Dark');
    expect((await service.lookup('u1', { title: '  ', year: null, mediaType: 'movie' })).kind).toBe(
      'none',
    );
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('ignores a corrupt stored value and looks it up again', async () => {
    const { service, search, mem } = setup();
    await service.lookup('u1', TARGET);
    for (const k of mem.rows.keys())
      mem.rows.set(k, {
        value: { kind: 'found', tmdbId: 'x' },
        savedAt: '2026-11-04T00:00:00.000Z',
      });
    expect((await service.lookup('u1', TARGET)).kind).toBe('found');
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('ignores a stored value dated in the future', async () => {
    const { service, search, mem } = setup();
    await service.lookup('u1', TARGET);
    for (const [k, v] of mem.rows) mem.rows.set(k, { ...v, savedAt: '2027-01-01T00:00:00.000Z' });
    await service.lookup('u1', TARGET);
    expect(search).toHaveBeenCalledTimes(2);
  });
});

describe('matching', () => {
  it('shows "nothing found" rather than the wrong title, and remembers that', async () => {
    const search = vi.fn((_q: string) =>
      Promise.resolve([item({ title: 'The Notebook', release_date: '2004-06-25' })]),
    );
    const { service } = setup({ search });
    expect((await service.lookup('u1', TARGET)).kind).toBe('none');
    expect((await service.lookup('u1', TARGET)).kind).toBe('none');
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('keeps a film and a series of the same name apart', async () => {
    const results = [
      item({
        id: 1,
        media_type: 'tv',
        title: undefined,
        name: 'Heat',
        first_air_date: '2020-01-01',
        release_date: undefined,
      }),
      item({ id: 2, title: 'Heat', release_date: '1995-12-15' }),
    ];
    const { service } = setup({ search: vi.fn((_q: string) => Promise.resolve(results)) });
    const film = await service.lookup('u1', { title: 'Heat', year: null, mediaType: 'movie' });
    const series = await service.lookup('u1', { title: 'Heat', year: null, mediaType: 'tv' });
    expect(film.kind === 'found' && film.metadata.tmdbId).toBe(2);
    expect(series.kind === 'found' && series.metadata.tmdbId).toBe(1);
  });

  it('records what TMDB called the match, so a wrong one is visible', async () => {
    const results = [item({ title: 'Interstellr', release_date: '2014-11-05' })];
    const { service } = setup({ search: vi.fn((_q: string) => Promise.resolve(results)) });
    const r = await service.lookup('u1', { title: 'Interstellar', year: 2014, mediaType: 'movie' });
    expect(r.kind === 'found' && r.metadata.matchedTitle).toBe('Interstellr');
    expect(r.kind === 'found' && r.metadata.matchedYear).toBe(2014);
  });

  it('retries without leading symbols when the first answer holds nothing convincing', async () => {
    const search = vi.fn((q: string) =>
      Promise.resolve(
        q === 'Alive'
          ? [item({ id: 9, title: 'Alive' })]
          : [item({ id: 5, title: 'Something Else' })],
      ),
    );
    const { service } = setup({ search });
    const r = await service.lookup('u1', { title: '#Alive', year: null, mediaType: 'movie' });
    expect(search.mock.calls.map((c) => c[0])).toEqual(['#Alive', 'Alive']);
    expect(r.kind === 'found' && r.metadata.tmdbId).toBe(9);
  });

  it('a film and a series with the same name and year are cached separately', async () => {
    const { service, search } = setup();
    await service.lookup('u1', { title: 'Dark', year: 2017, mediaType: 'tv' });
    await service.lookup('u1', { title: 'Dark', year: 2017, mediaType: 'movie' });
    expect(search).toHaveBeenCalledTimes(2);
  });
});

describe('shared lookups and cancellation', () => {
  /** A client whose search honours the signal it is given, the way fetch does. */
  const abortable = (release: { run: () => void }) => {
    const calls: (AbortSignal | undefined)[] = [];
    const search = vi.fn((q: string, signal?: AbortSignal) => {
      calls.push(signal);
      return new Promise<SearchItem[]>((resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
        release.run = () => {
          resolve([item({ title: q })]);
        };
      });
    });
    return { search, calls };
  };

  it('one caller leaving does not cancel the request the other is still waiting for', async () => {
    const release = { run: () => undefined };
    const { search, calls } = abortable(release);
    const { service } = setup({ search });
    const leaving = new AbortController();
    const first = service.lookup('u1', TARGET, leaving.signal);
    const second = service.lookup('u1', TARGET);
    const firstOutcome = first.then(
      () => 'resolved',
      (error: unknown) => (error as Error).name,
    );
    leaving.abort();
    expect(await firstOutcome).toBe('AbortError');
    release.run();
    expect((await second).kind).toBe('found');
    expect(search).toHaveBeenCalledTimes(1);
    expect(calls.every((s) => s === undefined)).toBe(true); // nobody's signal reached the request
  });

  it('the answer a departed caller asked for is still stored for next time', async () => {
    const release = { run: () => undefined };
    const { search } = abortable(release);
    const { service, mem } = setup({ search });
    const leaving = new AbortController();
    const only = service.lookup('u1', TARGET, leaving.signal).catch(() => 'gone');
    leaving.abort();
    expect(await only).toBe('gone');
    release.run();
    await vi.waitFor(() => {
      expect(mem.rows.size).toBe(1);
    });
    expect((await service.lookup('u1', TARGET)).kind).toBe('found');
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('an already-aborted caller gets an abort at once and starts no extra request', async () => {
    const { service, search } = setup();
    const done = new AbortController();
    done.abort();
    await expect(service.lookup('u1', TARGET, done.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(search.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('trailer lookups are shared and survive one caller leaving, too', async () => {
    const found = vi.fn((_t: 'movie' | 'tv', _id: number) =>
      Promise.resolve<Video[]>([{ site: 'YouTube', type: 'Trailer', key: 'abcDEF12345' }]),
    );
    const { service } = setup({ videos: found });
    const leaving = new AbortController();
    const first = service.trailerKey('u1', TARGET, leaving.signal).catch(() => 'gone');
    const second = service.trailerKey('u1', TARGET);
    leaving.abort();
    expect(await first).toBe('gone');
    expect(await second).toBe('abcDEF12345');
    expect(found).toHaveBeenCalledTimes(1);
  });

  it('removes its abort listener once the answer arrives', async () => {
    const { service } = setup();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await service.lookup('u1', TARGET, controller.signal);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

describe('failures', () => {
  it('reports unavailable and stores nothing', async () => {
    const { service, mem } = setup({
      search: vi.fn(() => Promise.reject(new TmdbError('unavailable', 'x'))),
    });
    expect(await service.lookup('u1', TARGET)).toEqual({
      kind: 'unavailable',
      failure: 'unavailable',
    });
    expect(mem.rows.size).toBe(0);
  });

  it('stops asking for 5 minutes once the service is not set up', async () => {
    const search = vi.fn(() => Promise.reject(new TmdbError('not_configured', 'x')));
    const { service, advance } = setup({ search });
    await service.lookup('u1', TARGET);
    const other = await service.lookup('u1', { title: 'Heat', year: null, mediaType: 'movie' });
    expect(other).toEqual({ kind: 'unavailable', failure: 'not_configured' });
    expect(search).toHaveBeenCalledTimes(1);
    advance(NOT_CONFIGURED_PAUSE_MS + 1);
    await service.lookup('u1', { title: 'Ronin', year: null, mediaType: 'movie' });
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('pauses 30 seconds when rate limited', async () => {
    const search = vi.fn(() => Promise.reject(new TmdbError('rate_limited', 'x')));
    const { service, advance } = setup({ search });
    await service.lookup('u1', TARGET);
    await service.lookup('u1', { title: 'Heat', year: null, mediaType: 'movie' });
    expect(search).toHaveBeenCalledTimes(1);
    advance(RATE_LIMIT_PAUSE_MS + 1);
    await service.lookup('u1', { title: 'Ronin', year: null, mediaType: 'movie' });
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('does not pause for an ordinary failure', async () => {
    const search = vi.fn(() => Promise.reject(new TmdbError('unavailable', 'x')));
    const { service } = setup({ search });
    await service.lookup('u1', TARGET);
    await service.lookup('u1', { title: 'Heat', year: null, mediaType: 'movie' });
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('still serves stored posters while paused', async () => {
    const { service, search } = setup();
    await service.lookup('u1', TARGET);
    search.mockRejectedValue(new TmdbError('not_configured', 'x'));
    await service.lookup('u1', { title: 'Heat', year: null, mediaType: 'movie' });
    expect((await service.lookup('u1', TARGET)).kind).toBe('found');
  });

  it('passes an abort through instead of calling it a failure', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const { service } = setup({ search: vi.fn(() => Promise.reject(abort)) });
    await expect(service.lookup('u1', TARGET)).rejects.toBe(abort);
  });
});

describe('concurrency', () => {
  it(`runs at most ${String(MAX_PARALLEL)} requests at once`, async () => {
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const search = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((r) => releases.push(r));
      active--;
      return [item()];
    });
    const { service } = setup({ search });
    const all = Array.from({ length: 10 }, (_, i) =>
      service.lookup('u1', { title: `T${String(i)}`, year: null, mediaType: 'movie' }),
    );
    for (let i = 0; i < 40; i++) {
      await Promise.resolve();
      for (const release of releases.splice(0)) release();
    }
    await Promise.all(all);
    expect(peak).toBe(MAX_PARALLEL);
    expect(search).toHaveBeenCalledTimes(10);
  });
});

describe('trailers', () => {
  const trailer: Video = { site: 'YouTube', type: 'Trailer', key: 'abcDEF12345' };

  it('picks trailer, then teaser, then any YouTube video, and ignores other sites', () => {
    const teaser: Video = { site: 'YouTube', type: 'Teaser', key: 'teaser12345' };
    const clip: Video = { site: 'YouTube', type: 'Clip', key: 'clip1234567' };
    const vimeo: Video = { site: 'Vimeo', type: 'Trailer', key: 'vimeo123456' };
    expect(pickTrailer([clip, teaser, trailer])).toBe('abcDEF12345');
    expect(pickTrailer([clip, teaser])).toBe('teaser12345');
    expect(pickTrailer([vimeo, clip])).toBe('clip1234567');
    expect(pickTrailer([vimeo])).toBeNull();
  });

  it('looks the trailer up once and remembers it, even when there is none', async () => {
    const found = vi.fn((_t: 'movie' | 'tv', _id: number) => Promise.resolve([trailer]));
    const { service } = setup({ videos: found });
    expect(await service.trailerKey('u1', TARGET)).toBe('abcDEF12345');
    expect(await service.trailerKey('u1', TARGET)).toBe('abcDEF12345');
    expect(found).toHaveBeenCalledTimes(1);
    const none = setup();
    expect(await none.service.trailerKey('u1', TARGET)).toBeNull();
    await none.service.trailerKey('u1', TARGET);
    expect(none.videos).toHaveBeenCalledTimes(1);
  });

  it('returns null without storing when the lookup fails', async () => {
    const { service, mem } = setup({
      videos: vi.fn(() => Promise.reject(new TmdbError('unavailable', 'x'))),
    });
    expect(await service.trailerKey('u1', TARGET)).toBeNull();
    expect([...mem.rows.keys()].some((k) => k.includes('trailer'))).toBe(false);
  });

  it('returns null when the title is not on TMDB', async () => {
    const { service, videos } = setup({ search: vi.fn(() => Promise.resolve([])) });
    expect(await service.trailerKey('u1', TARGET)).toBeNull();
    expect(videos).not.toHaveBeenCalled();
  });

  it('keeps no title in a trailer key', async () => {
    const { service, mem } = setup({ videos: vi.fn(() => Promise.resolve([trailer])) });
    await service.trailerKey('u1', TARGET);
    const trailerKeys = [...mem.rows.keys()].filter((k) => k.includes('trailer'));
    expect(trailerKeys).toHaveLength(1);
    expect(trailerKeys[0]).not.toContain('inception');
  });
});

describe('clear', () => {
  it('forgets this account’s saved lookups and asks TMDB again, leaving other accounts alone', async () => {
    const { service, search, mem } = setup();
    await service.lookup('u1', TARGET);
    await service.lookup('u2', TARGET);
    await service.clear('u1');
    expect([...mem.rows.keys()].some((k) => k.startsWith('u1|'))).toBe(false);
    expect([...mem.rows.keys()].some((k) => k.startsWith('u2|'))).toBe(true);
    await service.lookup('u1', TARGET);
    await service.lookup('u2', TARGET);
    expect(search).toHaveBeenCalledTimes(3); // u1 asked again, u2 served from its copy
  });

  it('does not let a request that was already on its way save its answer afterwards', async () => {
    let release: (items: SearchItem[]) => void = () => undefined;
    const search = vi.fn(
      (_q: string) =>
        new Promise<SearchItem[]>((resolve) => {
          release = resolve;
        }),
    );
    const { service, mem } = setup({ search });
    const pending = service.lookup('u1', TARGET);
    await vi.waitFor(() => {
      expect(search).toHaveBeenCalled();
    });
    await service.clear('u1');
    release([item()]);
    expect((await pending).kind).toBe('found'); // the caller still gets its answer…
    expect(mem.rows.size).toBe(0); // …but it is not kept
  });

  it('also stops a straggling trailer lookup from saving', async () => {
    let release: (v: Video[]) => void = () => undefined;
    const videos = vi.fn(
      (_t: 'movie' | 'tv', _id: number) =>
        new Promise<Video[]>((resolve) => {
          release = resolve;
        }),
    );
    const { service, mem } = setup({ videos });
    const pending = service.trailerKey('u1', TARGET);
    await vi.waitFor(() => {
      expect(videos).toHaveBeenCalled();
    });
    await service.clear('u1');
    release([{ site: 'YouTube', type: 'Trailer', key: 'abcDEF12345' }]);
    await pending;
    expect([...mem.rows.keys()].some((k) => k.includes('trailer'))).toBe(false);
  });

  it('lets lookups through again right after a "not set up" pause is cleared', async () => {
    const search = vi
      .fn((_q: string) => Promise.resolve<SearchItem[]>([item()]))
      .mockRejectedValueOnce(new TmdbError('not_configured', 'x'));
    const { service } = setup({ search });
    expect((await service.lookup('u1', TARGET)).kind).toBe('unavailable');
    expect((await service.lookup('u1', TARGET)).kind).toBe('unavailable'); // paused
    await service.clear('u1');
    expect((await service.lookup('u1', TARGET)).kind).toBe('found');
  });
});
