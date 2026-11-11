import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDexieDeviceStore, snapshotChecksum } from '@/data/local/dexieLibraryCache';
import { HISTORY_LIMIT, METADATA_LIMIT, SNOOZE_LIMIT } from '@/data/local/deviceData';
import { CACHE_FORMAT_VERSION } from '@/data/local/libraryCache';
import { cacheDatabaseName } from '@/data/local/scope';
import { MOCK_OWNER_ID, fixtureId, generateMovies } from '@/data/mock/fixtures';
import type { HistoryEntry } from '@/domain/recommend';

const ALICE = fixtureId(0xa11ce);
const BOB = fixtureId(0xb0b);

let factory: IDBFactory;
let clock: Date;
const make = () => createDexieDeviceStore({ indexedDB: factory, IDBKeyRange, now: () => clock });
const names = async () => (await factory.databases()).map((d) => d.name);
const entry = (n: number): HistoryEntry => ({
  movieId: `movie-${String(n)}`,
  genres: ['Drama'],
  result: 'recommended',
  at: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(),
});

beforeEach(() => {
  factory = new IDBFactory();
  clock = new Date('2026-11-04T10:00:00.000Z');
});

describe('recommendation history (per account, on this device)', () => {
  it('returns newest first, up to the limit', async () => {
    const { history } = make();
    for (let n = 1; n <= 5; n += 1) await history.record(ALICE, entry(n));
    expect((await history.recent(ALICE, 3)).map((e) => e.movieId)).toEqual([
      'movie-5',
      'movie-4',
      'movie-3',
    ]);
    expect(await history.recent(ALICE, 0)).toEqual([]);
  });

  it('keeps only the most recent entries', async () => {
    const { history } = make();
    for (let n = 1; n <= HISTORY_LIMIT + 7; n += 1) await history.record(ALICE, entry(n));
    const all = await history.recent(ALICE, 1_000);
    expect(all).toHaveLength(HISTORY_LIMIT);
    expect(all[0]?.movieId).toBe(`movie-${String(HISTORY_LIMIT + 7)}`);
    expect(all.at(-1)?.movieId).toBe('movie-8'); // 1..7 were dropped
  });

  it('is separate for each account', async () => {
    const { history } = make();
    await history.record(ALICE, entry(1));
    await history.record(BOB, entry(2));
    expect((await history.recent(ALICE, 10)).map((e) => e.movieId)).toEqual(['movie-1']);
    expect((await history.recent(BOB, 10)).map((e) => e.movieId)).toEqual(['movie-2']);
  });

  it('skips a row that is not a valid entry instead of failing', async () => {
    const { history } = make();
    await history.record(ALICE, entry(1));
    const db = new Dexie(cacheDatabaseName(ALICE), { indexedDB: factory, IDBKeyRange });
    db.version(1).stores({ movies: 'id', meta: 'key' });
    db.version(2).stores({ history: '++seq', metadata: 'key, savedAt' });
    await db.table('history').add({ movieId: 42, genres: 'nope', result: 'x', at: null });
    db.close();
    expect((await history.recent(ALICE, 10)).map((e) => e.movieId)).toEqual(['movie-1']);
  });

  it('can be cleared without touching the saved library', async () => {
    const { history, library } = make();
    await library.write(ALICE, generateMovies(3, MOCK_OWNER_ID));
    await history.record(ALICE, entry(1));
    await history.clear(ALICE);
    expect(await history.recent(ALICE, 10)).toEqual([]);
    expect((await library.read(ALICE))?.movies).toHaveLength(3);
  });

  it('is not disturbed by saving a new library snapshot', async () => {
    const { history, library } = make();
    await history.record(ALICE, entry(1));
    await library.write(ALICE, generateMovies(3, MOCK_OWNER_ID));
    await library.write(ALICE, generateMovies(2, MOCK_OWNER_ID));
    expect(await history.recent(ALICE, 10)).toHaveLength(1);
  });
});

describe('looked-up metadata (posters, trailers)', () => {
  it('stores and returns a value with the time it was looked up', async () => {
    const { metadata } = make();
    expect(await metadata.get(ALICE, 'k')).toBeNull();
    await metadata.put(ALICE, 'k', { poster: 'https://image.example/a.jpg' }, clock);
    expect(await metadata.get(ALICE, 'k')).toEqual({
      value: { poster: 'https://image.example/a.jpg' },
      savedAt: '2026-11-04T10:00:00.000Z',
    });
  });

  it('replaces a value stored under the same key', async () => {
    const { metadata } = make();
    await metadata.put(ALICE, 'k', 1, clock);
    await metadata.put(ALICE, 'k', 2, new Date(clock.getTime() + 1_000));
    expect((await metadata.get(ALICE, 'k'))?.value).toBe(2);
  });

  it('is separate for each account (what one looked up is not visible to another)', async () => {
    const { metadata } = make();
    await metadata.put(ALICE, 'secret title|2001', { id: 1 }, clock);
    expect(await metadata.get(BOB, 'secret title|2001')).toBeNull();
  });

  it('can be cleared for one account without touching the library, the history or another account', async () => {
    const { metadata, library, history } = make();
    await library.write(ALICE, generateMovies(3, MOCK_OWNER_ID));
    await history.record(ALICE, entry(1));
    await metadata.put(ALICE, 'a|2001', { id: 1 }, clock);
    await metadata.put(BOB, 'a|2001', { id: 2 }, clock);
    await metadata.clear(ALICE);
    expect(await metadata.get(ALICE, 'a|2001')).toBeNull();
    expect(await metadata.get(BOB, 'a|2001')).not.toBeNull();
    expect((await library.read(ALICE))?.movies).toHaveLength(3);
    expect(await history.recent(ALICE, 10)).toHaveLength(1);
  });

  it('keeps the table bounded by dropping the oldest lookups', async () => {
    const { metadata } = make();
    await metadata.put(ALICE, 'seed', 0, clock); // opens (and creates) the database
    const db = new Dexie(cacheDatabaseName(ALICE), { indexedDB: factory, IDBKeyRange });
    db.version(1).stores({ movies: 'id', meta: 'key' });
    db.version(2).stores({ history: '++seq', metadata: 'key, savedAt' });
    const old = Array.from({ length: METADATA_LIMIT }, (_, i) => ({
      key: `old-${String(i)}`,
      value: i,
      savedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    }));
    await db.table('metadata').bulkPut(old);
    db.close();

    await metadata.put(ALICE, 'newest', 'n', clock);

    const check = new Dexie(cacheDatabaseName(ALICE), { indexedDB: factory, IDBKeyRange });
    check.version(1).stores({ movies: 'id', meta: 'key' });
    check.version(2).stores({ history: '++seq', metadata: 'key, savedAt' });
    expect(await check.table('metadata').count()).toBe(METADATA_LIMIT);
    expect(await check.table('metadata').get('newest')).toBeDefined();
    // 6,000 old + 'seed' + 'newest' = two over the limit: the two OLDEST lookups go.
    expect(await check.table('metadata').get('old-0')).toBeUndefined();
    expect(await check.table('metadata').get('old-1')).toBeUndefined();
    expect(await check.table('metadata').get('old-2')).toBeDefined();
    expect(await check.table('metadata').get('seed')).toBeDefined();
    check.close();
  }, 30_000);
});

describe('titles hidden from Discover for a while', () => {
  const at = () => clock;
  const later = (ms: number) => new Date(clock.getTime() + ms);
  const DAY = 86_400_000;

  it('hides a title until the time is up, and not a moment longer', async () => {
    const { snoozes } = make();
    await snoozes.snooze(ALICE, 'a', later(7 * DAY), at());
    expect(await snoozes.active(ALICE, later(7 * DAY - 1))).toEqual(['a']);
    expect(await snoozes.active(ALICE, later(7 * DAY))).toEqual([]);
  });

  it('hiding again replaces the time instead of adding a second entry', async () => {
    const { snoozes } = make();
    await snoozes.snooze(ALICE, 'a', later(DAY), at());
    await snoozes.snooze(ALICE, 'a', later(10 * DAY), at());
    expect(await snoozes.active(ALICE, later(5 * DAY))).toEqual(['a']);
  });

  it('is separate for each account', async () => {
    const { snoozes } = make();
    await snoozes.snooze(ALICE, 'a', later(DAY), at());
    expect(await snoozes.active(BOB, at())).toEqual([]);
  });

  it('can be cleared without touching the library or the history', async () => {
    const { snoozes, library, history } = make();
    await library.write(ALICE, generateMovies(3, MOCK_OWNER_ID));
    await history.record(ALICE, entry(1));
    await snoozes.snooze(ALICE, 'a', later(DAY), at());
    await snoozes.clear(ALICE);
    expect(await snoozes.active(ALICE, at())).toEqual([]);
    expect((await library.read(ALICE))?.movies).toHaveLength(3);
    expect(await history.recent(ALICE, 10)).toHaveLength(1);
  });

  it('forgets snoozes that have run out when a new one is saved, and stays bounded', async () => {
    const { snoozes } = make();
    await snoozes.snooze(ALICE, 'old', later(DAY), at());
    clock = later(2 * DAY);
    await snoozes.snooze(ALICE, 'new', later(9 * DAY), at());
    expect(await snoozes.active(ALICE, later(-DAY))).toEqual(['new']); // "old" was removed, not just inactive
    for (let i = 0; i < SNOOZE_LIMIT + 20; i += 1) {
      await snoozes.snooze(ALICE, `t${String(i)}`, later((10 + i) * 1000 + 9 * DAY), at());
    }
    expect((await snoozes.active(ALICE, later(-100 * DAY))).length).toBeLessThanOrEqual(
      SNOOZE_LIMIT,
    );
  }, 60_000);

  it('is removed with everything else on sign-out', async () => {
    const { snoozes, library } = make();
    await library.write(ALICE, generateMovies(2, MOCK_OWNER_ID));
    await snoozes.snooze(ALICE, 'a', later(DAY), at());
    await library.retainOnly(null);
    expect(await names()).not.toContain(cacheDatabaseName(ALICE));
    expect(await snoozes.active(ALICE, at())).toEqual([]);
  });
});

describe('leaving the device clean', () => {
  it('sign-out removes history and metadata together with the library', async () => {
    const { history, metadata, library } = make();
    await library.write(ALICE, generateMovies(2, MOCK_OWNER_ID));
    await history.record(ALICE, entry(1));
    await metadata.put(ALICE, 'k', 'v', clock);
    await library.retainOnly(null);
    expect(await names()).not.toContain(cacheDatabaseName(ALICE));
    expect(await history.recent(ALICE, 10)).toEqual([]);
    expect(await metadata.get(ALICE, 'k')).toBeNull();
  });

  it('switching accounts removes the previous account’s history and metadata', async () => {
    const { history, metadata, library } = make();
    await history.record(ALICE, entry(1));
    await metadata.put(ALICE, 'k', 'v', clock);
    await library.retainOnly(BOB);
    expect(await names()).not.toContain(cacheDatabaseName(ALICE));
  });

  it('a write that was waiting when the account was wiped does not bring the data back', async () => {
    const { history, metadata, library } = make();
    const pendingHistory = history.record(ALICE, entry(1));
    const pendingMetadata = metadata.put(ALICE, 'k', 'v', clock);
    await library.retainOnly(BOB);
    await Promise.all([pendingHistory, pendingMetadata]);
    expect(await names()).not.toContain(cacheDatabaseName(ALICE));
  });

  it('a damaged library snapshot is deleted, and takes the disposable extras with it', async () => {
    const { history, library } = make();
    await library.write(ALICE, generateMovies(3, MOCK_OWNER_ID));
    await history.record(ALICE, entry(1));
    const db = new Dexie(cacheDatabaseName(ALICE), { indexedDB: factory, IDBKeyRange });
    db.version(1).stores({ movies: 'id', meta: 'key' });
    db.version(2).stores({ history: '++seq', metadata: 'key, savedAt' });
    await db.table('meta').update('library', { count: 999 });
    db.close();
    expect(await library.read(ALICE)).toBeNull();
    expect(await names()).not.toContain(cacheDatabaseName(ALICE));
  });
});

describe('upgrading a database saved by M4 (schema version 1)', () => {
  it('keeps the saved library and adds the new tables', async () => {
    const movies = generateMovies(4, MOCK_OWNER_ID);
    const v1 = new Dexie(cacheDatabaseName(ALICE), { indexedDB: factory, IDBKeyRange });
    v1.version(1).stores({ movies: 'id', meta: 'key' });
    await v1.table('movies').bulkPut(movies);
    await v1.table('meta').put({
      key: 'library',
      formatVersion: CACHE_FORMAT_VERSION,
      userId: ALICE,
      savedAt: clock.toISOString(),
      count: movies.length,
      checksum: snapshotChecksum(movies),
    });
    v1.close();

    const { library, history, metadata } = make();
    expect((await library.read(ALICE))?.movies).toHaveLength(4);
    await history.record(ALICE, entry(1));
    await metadata.put(ALICE, 'k', 'v', clock);
    expect(await history.recent(ALICE, 5)).toHaveLength(1);
    expect((await metadata.get(ALICE, 'k'))?.value).toBe('v');
    expect((await library.read(ALICE))?.movies).toHaveLength(4);
  });
});

describe('upgrading a database saved by M5 (schema version 2)', () => {
  it('keeps the library, the history and the lookups, and adds the hiding table', async () => {
    const movies = generateMovies(4, MOCK_OWNER_ID);
    const v2 = new Dexie(cacheDatabaseName(ALICE), { indexedDB: factory, IDBKeyRange });
    v2.version(1).stores({ movies: 'id', meta: 'key' });
    v2.version(2).stores({ history: '++seq', metadata: 'key, savedAt' });
    await v2.table('movies').bulkPut(movies);
    await v2.table('meta').put({
      key: 'library',
      formatVersion: CACHE_FORMAT_VERSION,
      userId: ALICE,
      savedAt: clock.toISOString(),
      count: movies.length,
      checksum: snapshotChecksum(movies),
    });
    await v2.table('history').add({ ...entry(1), genres: ['Drama'] });
    await v2.table('metadata').put({ key: 'k', value: { v: 1 }, savedAt: clock.toISOString() });
    v2.close();

    const { library, history, metadata, snoozes } = make();
    expect((await library.read(ALICE))?.movies).toHaveLength(4);
    expect(await history.recent(ALICE, 10)).toHaveLength(1);
    expect(await metadata.get(ALICE, 'k')).not.toBeNull();
    expect(await snoozes.active(ALICE, clock)).toEqual([]);
    await snoozes.snooze(ALICE, 'a', new Date(clock.getTime() + 1000), clock);
    expect(await snoozes.active(ALICE, clock)).toEqual(['a']);
  });
});

describe('when the browser offers no IndexedDB', () => {
  it('everything quietly reports "nothing saved"', async () => {
    const { history, metadata } = createDexieDeviceStore(); // jsdom has no indexedDB
    expect(await history.recent(ALICE, 5)).toEqual([]);
    await expect(history.record(ALICE, entry(1))).resolves.toBeUndefined();
    await expect(history.clear(ALICE)).resolves.toBeUndefined();
    expect(await metadata.get(ALICE, 'k')).toBeNull();
    await expect(metadata.put(ALICE, 'k', 1, clock)).resolves.toBeUndefined();
  });

  it('a user id that is not an account id is refused without touching storage', async () => {
    const { history, metadata } = make();
    await history.record('not-a-uuid', entry(1));
    await metadata.put('../evil', 'k', 1, clock);
    expect(await history.recent('not-a-uuid', 5)).toEqual([]);
    expect(await metadata.get('../evil', 'k')).toBeNull();
    expect(await names()).toEqual([]);
  });
});
