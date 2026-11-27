import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDexieLibraryCache, snapshotChecksum } from '@/data/local/dexieLibraryCache';
import { CACHE_FORMAT_VERSION, MAX_CACHE_AGE_MS } from '@/data/local/libraryCache';
import { cacheDatabaseName } from '@/data/local/scope';
import { MOCK_OWNER_ID, fixtureId, generateMovies } from '@/data/mock/fixtures';
import { first } from '../helpers';

/** What a planted (hand-edited) row looks like to the tests: any shape, keyed by id. */
type PlantedRow = Record<string, unknown> & { id: string };

const ALICE = fixtureId(0xa11ce);
const BOB = fixtureId(0xb0b);
const OWNER = MOCK_OWNER_ID;

let factory: IDBFactory;
let clock: Date;
const make = () => createDexieLibraryCache({ indexedDB: factory, IDBKeyRange, now: () => clock });

/** Raw access to a user's database, for planting damage the cache itself would never write. */
const raw = (userId: string) => {
  const db = new Dexie(cacheDatabaseName(userId), { indexedDB: factory, IDBKeyRange });
  db.version(1).stores({ movies: 'id', meta: 'key' });
  return db;
};
const databaseNames = async () => (await factory.databases()).map((entry) => entry.name);

beforeEach(() => {
  factory = new IDBFactory();
  clock = new Date('2026-11-02T10:00:00.000Z');
});

describe('saving and reading a library', () => {
  it('returns nothing when nothing was saved', async () => {
    expect(await make().read(ALICE)).toBeNull();
  });

  it('round-trips a production-sized library field for field, version tokens included', async () => {
    const cache = make();
    const library = generateMovies(3_243, OWNER);
    // A token with microsecond precision must survive verbatim: it is the optimistic-lock value.
    const tokened = library.map((movie, i) =>
      i === 0 ? { ...movie, updatedAt: '2026-10-25T16:08:58.396273+00:00' } : movie,
    );
    expect(await cache.write(ALICE, tokened)).toBe(true);

    const saved = await cache.read(ALICE);
    expect(saved?.savedAt).toBe('2026-11-02T10:00:00.000Z');
    expect(saved?.movies).toHaveLength(3_243);
    const byId = new Map(saved?.movies.map((movie) => [movie.id, movie]));
    for (const movie of tokened) expect(byId.get(movie.id)).toEqual(movie);
    expect(byId.get(first(tokened).id)?.updatedAt).toBe('2026-10-25T16:08:58.396273+00:00');
  });

  it('replaces the whole snapshot: titles removed on the server do not linger', async () => {
    const cache = make();
    const library = generateMovies(10, OWNER);
    await cache.write(ALICE, library);
    await cache.write(ALICE, library.slice(0, 4));
    const saved = await cache.read(ALICE);
    expect(saved?.movies.map((movie) => movie.id).sort()).toEqual(
      library
        .slice(0, 4)
        .map((movie) => movie.id)
        .sort(),
    );
  });

  it('saves an empty library (a real answer) and reads it back as empty, not as missing', async () => {
    const cache = make();
    await cache.write(ALICE, []);
    expect(await cache.read(ALICE)).toEqual({ movies: [], savedAt: clock.toISOString() });
  });

  it('refuses an id that is not a UUID rather than naming a database after it', async () => {
    const cache = make();
    expect(await cache.write('../../evil', generateMovies(1, OWNER))).toBe(false);
    expect(await cache.read('../../evil')).toBeNull();
    expect(await databaseNames()).toEqual([]);
  });
});

describe('one database per account', () => {
  it('never shows one account the other’s library', async () => {
    const cache = make();
    await cache.write(ALICE, generateMovies(5, OWNER));
    expect(await cache.read(BOB)).toBeNull();
    const bobs = raw(BOB); // reading may create Bob's database, but never with Alice's rows in it
    expect(await bobs.table('movies').count()).toBe(0);
    bobs.close();
    expect((await cache.read(ALICE))?.movies).toHaveLength(5);
  });

  it('keeps each account’s own copy', async () => {
    const cache = make();
    await cache.write(ALICE, generateMovies(3, OWNER));
    await cache.write(BOB, generateMovies(7, OWNER));
    expect((await cache.read(ALICE))?.movies).toHaveLength(3);
    expect((await cache.read(BOB))?.movies).toHaveLength(7);
  });

  it('a snapshot copied under another account’s database is not accepted for it', async () => {
    const cache = make();
    await cache.write(ALICE, generateMovies(3, OWNER));
    const source = raw(ALICE);
    const meta: unknown = await source.table('meta').get('library');
    const rows = await source.table<PlantedRow, string>('movies').toArray();
    source.close();
    const target = raw(BOB);
    await target.table('movies').bulkPut(rows);
    await target.table('meta').put(meta); // still says it belongs to ALICE
    target.close();
    expect(await cache.read(BOB)).toBeNull();
  });
});

describe('saves that finish out of order', () => {
  it('a slow, older answer never replaces a newer snapshot', async () => {
    const at = (iso: string) =>
      createDexieLibraryCache({ indexedDB: factory, IDBKeyRange, now: () => new Date(iso) });
    const newer = at('2026-11-02T10:00:05.000Z');
    const older = at('2026-11-02T10:00:00.000Z');

    expect(await newer.write(ALICE, generateMovies(29, OWNER))).toBe(true);
    expect(await older.write(ALICE, generateMovies(28, OWNER))).toBe(false); // arrives late
    const saved = await newer.read(ALICE);
    expect(saved?.movies).toHaveLength(29);
    expect(saved?.savedAt).toBe('2026-11-02T10:00:05.000Z');
  });

  it('two saves in the same millisecond keep the one started last', async () => {
    const cache = make(); // the clock is frozen
    const first = cache.write(ALICE, generateMovies(3, OWNER));
    const second = cache.write(ALICE, generateMovies(5, OWNER));
    await Promise.all([first, second]);
    expect((await cache.read(ALICE))?.movies).toHaveLength(5);
  });

  it('a newer answer does replace an older one', async () => {
    const cache = make();
    await cache.write(ALICE, generateMovies(3, OWNER));
    clock = new Date(clock.getTime() + 1_000);
    expect(await cache.write(ALICE, generateMovies(4, OWNER))).toBe(true);
    expect((await cache.read(ALICE))?.movies).toHaveLength(4);
  });
});

describe('wiping', () => {
  it('forget removes one account’s database', async () => {
    const cache = make();
    await cache.write(ALICE, generateMovies(3, OWNER));
    await cache.write(BOB, generateMovies(3, OWNER));
    await cache.forget(ALICE);
    expect(await databaseNames()).toEqual([cacheDatabaseName(BOB)]);
    expect(await cache.read(ALICE)).toBeNull();
  });

  it('retainOnly keeps the active account and deletes everyone else’s, even from a past session', async () => {
    await make().write(ALICE, generateMovies(3, OWNER)); // an earlier page load
    const cache = make(); // a new page load that never opened ALICE
    await cache.write(BOB, generateMovies(3, OWNER));
    await cache.retainOnly(BOB);
    expect(await databaseNames()).toEqual([cacheDatabaseName(BOB)]);
    expect((await cache.read(BOB))?.movies).toHaveLength(3);
  });

  it('retainOnly(null), as on sign-out, deletes everything', async () => {
    const cache = make();
    await cache.write(ALICE, generateMovies(3, OWNER));
    await cache.write(BOB, generateMovies(3, OWNER));
    await cache.retainOnly(null);
    expect(await databaseNames()).toEqual([]);
  });

  it('leaves databases that are not CinemaVault’s own account caches alone', async () => {
    const cache = make();
    const other = new Dexie('someone-elses-app', { indexedDB: factory, IDBKeyRange });
    other.version(1).stores({ things: 'id' });
    await other.open();
    other.close();
    await cache.write(ALICE, generateMovies(2, OWNER));
    await cache.retainOnly(null);
    expect(await databaseNames()).toEqual(['someone-elses-app']);
  });

  it('a save that was still waiting when the account was wiped does not resurrect the data', async () => {
    const cache = make();
    const pending = cache.write(ALICE, generateMovies(50, OWNER)); // not awaited yet
    await cache.retainOnly(null); // sign-out happens first
    expect(await pending).toBe(false);
    expect(await databaseNames()).toEqual([]);
    expect(await cache.read(ALICE)).toBeNull();
  });

  it('a save for the previous account that lands after a switch to another is dropped', async () => {
    const cache = make();
    const pending = cache.write(ALICE, generateMovies(50, OWNER));
    await cache.retainOnly(BOB);
    expect(await pending).toBe(false);
    expect(await databaseNames()).not.toContain(cacheDatabaseName(ALICE));
  });

  it('the account can save again after a wipe (signing back in)', async () => {
    const cache = make();
    await cache.write(ALICE, generateMovies(2, OWNER));
    await cache.retainOnly(null);
    expect(await cache.write(ALICE, generateMovies(4, OWNER))).toBe(true);
    expect((await cache.read(ALICE))?.movies).toHaveLength(4);
  });
});

describe('damaged, outdated or untrustworthy snapshots are treated as absent and deleted', () => {
  const planted = async (change: (db: ReturnType<typeof raw>) => Promise<void>) => {
    const cache = make();
    await cache.write(ALICE, generateMovies(6, OWNER));
    const db = raw(ALICE);
    await change(db);
    db.close();
    return cache;
  };
  const gone = async () => {
    expect(await databaseNames()).not.toContain(cacheDatabaseName(ALICE));
  };

  it('a row with an invalid field', async () => {
    const cache = await planted(async (db) => {
      const row = first(await db.table<PlantedRow, string>('movies').toArray());
      await db.table<PlantedRow, string>('movies').put({ ...row, year: 'nineteen ninety' });
    });
    expect(await cache.read(ALICE)).toBeNull();
    await gone();
  });

  it('a row that was removed', async () => {
    const cache = await planted(async (db) => {
      const row = first(await db.table<PlantedRow, string>('movies').toArray());
      await db.table<PlantedRow, string>('movies').delete(row.id);
    });
    expect(await cache.read(ALICE)).toBeNull();
    await gone();
  });

  it('a row whose version token was altered (checksum no longer matches)', async () => {
    const cache = await planted(async (db) => {
      const row = first(await db.table<PlantedRow, string>('movies').toArray());
      await db
        .table<PlantedRow, string>('movies')
        .put({ ...row, updatedAt: '2030-01-01T00:00:00.000000+00:00' });
    });
    expect(await cache.read(ALICE)).toBeNull();
    await gone();
  });

  it('a snapshot written by another format version', async () => {
    const cache = await planted(async (db) => {
      await db.table('meta').update('library', { formatVersion: CACHE_FORMAT_VERSION + 1 });
    });
    expect(await cache.read(ALICE)).toBeNull();
    await gone();
  });

  it('movie rows with no meta row (an interrupted or foreign write) are deleted, not just ignored', async () => {
    const cache = await planted(async (db) => {
      await db.table('meta').clear();
    });
    expect(await cache.read(ALICE)).toBeNull();
    await gone();
  });

  it('an account that never saved anything simply has no copy (and nothing to delete)', async () => {
    const cache = make();
    expect(await cache.read(ALICE)).toBeNull();
    // Nothing doubtful was found, so nothing is deleted: reading an empty database is just "no copy".
    expect(await databaseNames()).toContain(cacheDatabaseName(ALICE));
    const db = raw(ALICE);
    await db.open();
    expect(await db.table('movies').count()).toBe(0);
    db.close();
  });

  it('a meta row whose movie rows are gone is damage (count and checksum no longer match)', async () => {
    const cache = await planted(async (db) => {
      await db.table('movies').clear();
    });
    expect(await cache.read(ALICE)).toBeNull();
    await gone();
  });

  it('an empty library saved honestly is served as empty, not as damage', async () => {
    const cache = make();
    await cache.write(ALICE, []);
    expect((await cache.read(ALICE))?.movies).toEqual([]);
  });

  // Every one of these still passes the row schema, the count and the (old) id+version check.
  // Each change is computed from the stored value so it is always a real difference.
  const flip = (value: unknown, alternatives: readonly unknown[]) =>
    alternatives.find((candidate) => candidate !== value);
  it.each<[string, readonly unknown[]]>([
    ['title', ['Inception', 'Interstellar']],
    ['normalizedTitle', ['inception', 'interstellar']],
    ['mediaType', ['series', 'movie']],
    ['year', [1999, 2000]],
    ['genre', ['Horror', 'Drama', null]],
    ['runtimeMinutes', [61, 62]],
    ['watched', [true, false]],
    ['watchedOn', ['2001-02-03', '2001-02-04', null]],
    ['userRating', [1, 2]],
    ['verdict', ['Changed by damage', 'Changed again', null]],
    ['technicalNotes', ['Changed by damage', 'Changed again', null]],
    ['shotLink', ['https://example.com/changed', 'https://example.com/other', null]],
    ['ownerId', ['00000000-0000-4000-8000-0000000000bb', '00000000-0000-4000-8000-0000000000cc']],
    ['createdAt', ['2001-01-01T00:00:00.000000+00:00', '2002-01-01T00:00:00.000000+00:00']],
    ['deletedAt', ['2026-01-01T00:00:00.000000+00:00', '2027-01-01T00:00:00.000000+00:00']],
  ])('a changed %s with the same id and version token is damage', async (field, alternatives) => {
    const cache = await planted(async (db) => {
      const row = first(await db.table<PlantedRow, string>('movies').toArray());
      const replacement = flip(row[field], alternatives);
      expect(replacement).not.toBe(row[field]); // the test really changes something
      await db.table<PlantedRow, string>('movies').put({ ...row, [field]: replacement });
    });
    expect(await cache.read(ALICE)).toBeNull();
    await gone();
  });

  it('a snapshot older than the maximum age', async () => {
    const cache = make();
    await cache.write(ALICE, generateMovies(3, OWNER));
    clock = new Date(clock.getTime() + MAX_CACHE_AGE_MS + 1);
    expect(await cache.read(ALICE)).toBeNull();
    await gone();
  });

  it('a snapshot just inside the maximum age is still served', async () => {
    const cache = make();
    await cache.write(ALICE, generateMovies(3, OWNER));
    clock = new Date(clock.getTime() + MAX_CACHE_AGE_MS - 1);
    expect((await cache.read(ALICE))?.movies).toHaveLength(3);
  });

  it('a snapshot dated in the future (the clock was wrong when it was saved)', async () => {
    const cache = make();
    await cache.write(ALICE, generateMovies(3, OWNER));
    clock = new Date(clock.getTime() - 60 * 60_000);
    expect(await cache.read(ALICE)).toBeNull();
  });

  it('a database left by a NEWER app version (a rollback) still works: Dexie 4 ignores tables it does not know', async () => {
    const newer = new Dexie(cacheDatabaseName(ALICE), { indexedDB: factory, IDBKeyRange });
    newer.version(7).stores({ movies: 'id', meta: 'key', somethingNew: 'id' });
    await newer.open();
    newer.close();

    const cache = make();
    expect(await cache.read(ALICE)).toBeNull();
    expect(await cache.write(ALICE, generateMovies(2, OWNER))).toBe(true);
    expect((await cache.read(ALICE))?.movies).toHaveLength(2);
  });
});

describe('when the browser offers no IndexedDB (private window, blocked storage)', () => {
  it('reading and saving fail quietly instead of throwing', async () => {
    const cache = createDexieLibraryCache(); // jsdom has no indexedDB
    expect(await cache.read(ALICE)).toBeNull();
    expect(await cache.write(ALICE, generateMovies(1, OWNER))).toBe(false);
    await expect(cache.retainOnly(null)).resolves.toBeUndefined();
    await expect(cache.forget(ALICE)).resolves.toBeUndefined();
  });
});

describe('checksum', () => {
  it('depends on the content of every field, not only the id and version token', () => {
    const [a, b] = generateMovies(2, OWNER);
    if (!a || !b) throw new Error('fixture');
    const base = snapshotChecksum([a, b]);
    expect(snapshotChecksum([{ ...a, title: 'Inception' }, b])).not.toBe(base);
    expect(snapshotChecksum([{ ...a, userRating: a.userRating === 5 ? 4 : 5 }, b])).not.toBe(base);
    expect(snapshotChecksum([{ ...a, verdict: `${a.verdict ?? ''} edited` }, b])).not.toBe(base);
    expect(snapshotChecksum([a, { ...b, watched: !b.watched }])).not.toBe(base);
  });

  it('keeps null and the text "null", and text moved between neighbouring fields, apart', () => {
    const [a] = generateMovies(1, OWNER);
    if (!a) throw new Error('fixture');
    const asNull = snapshotChecksum([{ ...a, genre: null, verdict: 'x' }]);
    expect(snapshotChecksum([{ ...a, genre: 'null', verdict: 'x' }])).not.toBe(asNull);
    expect(snapshotChecksum([{ ...a, genre: 'x', verdict: null }])).not.toBe(asNull);
    expect(snapshotChecksum([{ ...a, genre: 'a', verdict: 'b' }])).not.toBe(
      snapshotChecksum([{ ...a, genre: 'ab', verdict: '' }]),
    );
  });

  it('depends on every id and version token, not on order', () => {
    const [a, b, c] = generateMovies(3, OWNER);
    if (!a || !b || !c) throw new Error('fixture');
    expect(snapshotChecksum([a, b, c])).toBe(snapshotChecksum([c, a, b]));
    expect(snapshotChecksum([a, b])).not.toBe(snapshotChecksum([a, b, c]));
    expect(snapshotChecksum([a, b])).not.toBe(
      snapshotChecksum([a, { ...b, updatedAt: '2031-01-01T00:00:00.000000+00:00' }]),
    );
  });
});
