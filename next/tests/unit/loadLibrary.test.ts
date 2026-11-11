import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDexieLibraryCache } from '@/data/local/dexieLibraryCache';
import type { LibraryCache } from '@/data/local/libraryCache';
import { SERVER_PATIENCE_MS, loadLibrary } from '@/data/local/loadLibrary';
import type { MovieRepository } from '@/data/repositories/movieRepository';
import { MOCK_OWNER_ID, fixtureId, generateMovies } from '@/data/mock/fixtures';
import type { Movie } from '@/domain/movie';
import { err, ok, type AppErrorCode, type Result } from '@/domain/result';

const ALICE = fixtureId(0xa11ce);
const BOB = fixtureId(0xb0b);
const NOW = new Date('2026-11-02T12:00:00.000Z');

let cache: LibraryCache;
let factory: IDBFactory;
beforeEach(() => {
  factory = new IDBFactory();
  cache = createDexieLibraryCache({ indexedDB: factory, IDBKeyRange, now: () => NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

const repo = (list: () => Promise<Result<readonly Movie[]>>): MovieRepository => ({
  list,
  get: () => Promise.reject(new Error('unused')),
  create: () => Promise.reject(new Error('unused')),
  update: () => Promise.reject(new Error('unused')),
  remove: () => Promise.reject(new Error('unused')),
});
const answering = (movies: readonly Movie[]) => repo(() => Promise.resolve(ok(movies)));
const failing = (code: AppErrorCode) => repo(() => Promise.resolve(err(code, `${code} happened`)));
const live = () => true;

/** The save is fire-and-forget; wait until it has landed. */
const saved = async (userId: string) => {
  for (let i = 0; i < 50; i += 1) {
    const copy = await cache.read(userId);
    if (copy) return copy;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return null;
};

describe('online: the server wins and is saved', () => {
  it('returns the server library as such and saves it as the new snapshot', async () => {
    const library = generateMovies(40, MOCK_OWNER_ID);
    const result = await loadLibrary({
      repository: answering(library),
      cache,
      userId: ALICE,
      isCurrent: live,
      now: () => NOW,
    });
    expect(result).toEqual({
      ok: true,
      value: { movies: library, source: { origin: 'network', at: NOW.toISOString() } },
    });
    expect((await saved(ALICE))?.movies).toHaveLength(40);
  });

  it('works without any cache (sample data) and saves nothing', async () => {
    const result = await loadLibrary({
      repository: answering(generateMovies(3, MOCK_OWNER_ID)),
      cache: null,
      userId: ALICE,
      isCurrent: live,
    });
    expect(result.ok && result.value.source.origin).toBe('network');
  });

  it('a newer server answer replaces an older snapshot completely', async () => {
    await cache.write(ALICE, generateMovies(10, MOCK_OWNER_ID));
    await loadLibrary({
      repository: answering(generateMovies(2, MOCK_OWNER_ID)),
      cache,
      userId: ALICE,
      isCurrent: live,
    });
    await vi.waitFor(async () => {
      expect((await cache.read(ALICE))?.movies).toHaveLength(2);
    });
  });
});

describe('only an unreachable server falls back to the saved copy', () => {
  it('network failure with a saved copy: shows the copy, labelled with when it was saved', async () => {
    const library = generateMovies(12, MOCK_OWNER_ID);
    await cache.write(ALICE, library);
    const result = await loadLibrary({
      repository: failing('network'),
      cache,
      userId: ALICE,
      isCurrent: live,
    });
    expect(result.ok && result.value.source).toEqual({
      origin: 'cache',
      at: NOW.toISOString(),
    });
    expect(result.ok && result.value.movies).toHaveLength(12);
  });

  it('network failure with nothing saved: the plain network error, as before', async () => {
    const result = await loadLibrary({
      repository: failing('network'),
      cache,
      userId: ALICE,
      isCurrent: live,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'network' } });
  });

  it.each(['forbidden', 'unauthenticated', 'unknown', 'validation'] as const)(
    'a %s answer is NEVER replaced by the saved copy, even when one exists',
    async (code) => {
      await cache.write(ALICE, generateMovies(5, MOCK_OWNER_ID));
      const result = await loadLibrary({
        repository: failing(code),
        cache,
        userId: ALICE,
        isCurrent: live,
      });
      expect(result).toMatchObject({ ok: false, error: { code } });
    },
  );

  it('a damaged saved copy is not shown: the network error stands, and the copy is deleted', async () => {
    await cache.write(ALICE, generateMovies(5, MOCK_OWNER_ID));
    const { default: Dexie } = await import('dexie');
    const raw = new Dexie(`cinemavault-next:${ALICE}`, { indexedDB: factory, IDBKeyRange });
    raw.version(1).stores({ movies: 'id', meta: 'key' });
    const row = (await raw.table('movies').toArray())[0] as Movie;
    await raw.table('movies').put({ ...row, title: '' }); // empty title is invalid
    raw.close();

    const result = await loadLibrary({
      repository: failing('network'),
      cache,
      userId: ALICE,
      isCurrent: live,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'network' } });
    expect((await factory.databases()).map((d) => d.name)).not.toContain(
      `cinemavault-next:${ALICE}`,
    );
  });

  it('account B never gets account A’s saved copy', async () => {
    await cache.write(ALICE, generateMovies(5, MOCK_OWNER_ID));
    const result = await loadLibrary({
      repository: failing('network'),
      cache,
      userId: BOB,
      isCurrent: live,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'network' } });
  });
});

describe('a server that never answers', () => {
  it('with a saved copy: shows it after the patience runs out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); // IndexedDB keeps real timers
    await cache.write(ALICE, generateMovies(7, MOCK_OWNER_ID));
    const never = repo(() => new Promise(() => undefined));
    const pending = loadLibrary({ repository: never, cache, userId: ALICE, isCurrent: live });
    await vi.advanceTimersByTimeAsync(SERVER_PATIENCE_MS + 1);
    const result = await pending;
    expect(result.ok && result.value.source.origin).toBe('cache');
  });

  it('does not give up early: an answer inside the patience wins over the copy', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); // IndexedDB keeps real timers
    await cache.write(ALICE, generateMovies(7, MOCK_OWNER_ID));
    const slow = repo(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(ok(generateMovies(9, MOCK_OWNER_ID)));
          }, SERVER_PATIENCE_MS - 100);
        }),
    );
    const pending = loadLibrary({ repository: slow, cache, userId: ALICE, isCurrent: live });
    await vi.advanceTimersByTimeAsync(SERVER_PATIENCE_MS);
    const result = await pending;
    expect(result.ok && result.value.source.origin).toBe('network');
    expect(result.ok && result.value.movies).toHaveLength(9);
  });

  it('with nothing saved: keeps waiting for the server, as before', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); // IndexedDB keeps real timers
    let answer: (value: Result<readonly Movie[]>) => void = () => undefined;
    const slow = repo(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const pending = loadLibrary({ repository: slow, cache, userId: ALICE, isCurrent: live });
    await vi.advanceTimersByTimeAsync(SERVER_PATIENCE_MS * 3);
    answer(ok(generateMovies(4, MOCK_OWNER_ID)));
    const result = await pending;
    expect(result.ok && result.value.source.origin).toBe('network');
  });
});

describe('the account changes while loading', () => {
  it('a server answer for a previous account is discarded and not saved', async () => {
    let current = true;
    const result = await loadLibrary({
      repository: repo(() => {
        current = false; // the person switched account while the request was in flight
        return Promise.resolve(ok(generateMovies(5, MOCK_OWNER_ID)));
      }),
      cache,
      userId: ALICE,
      isCurrent: () => current,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'session_changed' } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await cache.read(ALICE)).toBeNull();
  });

  it('a saved copy read for a previous account is discarded', async () => {
    await cache.write(ALICE, generateMovies(5, MOCK_OWNER_ID));
    let current = true;
    const result = await loadLibrary({
      repository: repo(() => {
        const failure = err('network', 'down');
        current = false;
        return Promise.resolve(failure);
      }),
      cache,
      userId: ALICE,
      isCurrent: () => current,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'session_changed' } });
  });
});
