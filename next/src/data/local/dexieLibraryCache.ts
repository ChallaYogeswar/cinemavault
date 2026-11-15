import Dexie, { type Table } from 'dexie';
import { CACHE_DATABASE_PREFIX, cacheDatabaseName } from '@/data/local/scope';
import type { Movie } from '@/domain/movie';
import { movieSchema } from '@/domain/validation';
import { z } from 'zod';
import type { HistoryEntry } from '@/domain/recommend';
import {
  HISTORY_LIMIT,
  METADATA_LIMIT,
  SNOOZE_LIMIT,
  type HistoryStore,
  type MetadataStore,
  type SnoozeStore,
  type StoredMetadata,
} from './deviceData';
import { coalesce, outboxEntrySchema, toEntry, type OutboxEntry } from '@/domain/outbox';
import type { Role } from '@/domain/permissions';
import {
  MAX_ROLE_AGE_MS,
  type EnqueueResult,
  type OutboxStore,
  type RoleStore,
  type StoredRole,
} from './outboxStore';
import {
  CACHE_FORMAT_VERSION,
  MAX_CACHE_AGE_MS,
  type CachedLibrary,
  type LibraryCache,
} from './libraryCache';

/** One row per movie, keyed by id. The domain Movie is stored as-is (strings, numbers, nulls). */
type StoredMovie = Movie;

interface SnapshotMeta {
  readonly key: 'library';
  readonly formatVersion: number;
  /** Must equal the account the database name was derived from. */
  readonly userId: string;
  readonly savedAt: string;
  readonly count: number;
  /** Detects a torn or tampered snapshot: a hash over every id and version token. */
  readonly checksum: string;
}

/**
 * One IndexedDB database PER ACCOUNT (`cinemavault-next:<user id>`). Isolation is structural: the
 * code that reads account B opens a database that account A's data was never written to, and
 * signing out deletes the databases outright instead of filtering rows.
 *
 * IndexedDB schema versions (this is the Dexie `version()` number, which only describes TABLES):
 *   1  movies (key id), meta (key key)
 *   2  + history (auto-increment seq), metadata (key, indexed by savedAt)   [M5: Discover, posters]
 *   3  + snoozed (key movieId, indexed by until)                              [M5.2: "Not now"]
 *   4  + outbox (key movieId, indexed by queuedAt), session (key key)         [M6.2: offline edits, last confirmed role]
 * To change the tables, add `db.version(2).stores({...})` BELOW the existing line and never edit a
 * shipped version. To change what a snapshot contains, bump CACHE_FORMAT_VERSION instead: old
 * snapshots are then dropped and refilled from the server, which is always safe for a cache.
 */
interface StoredHistory {
  seq?: number;
  movieId: string;
  genres: string[];
  result: 'recommended' | 'genre-random';
  at: string;
}

interface StoredSnooze {
  movieId: string;
  until: string;
}

/** One row per title with a waiting change: the key IS the title's id, so there can never be two. */
type StoredOutbox = OutboxEntry;

interface StoredSession {
  key: 'role';
  role: Role;
  savedAt: string;
}

interface StoredMetadataRow {
  key: string;
  value: unknown;
  savedAt: string;
}

const historyRowSchema = z.object({
  movieId: z.string().min(1),
  genres: z.array(z.string()),
  result: z.enum(['recommended', 'genre-random']),
  at: z.string(),
});

class LibraryDatabase extends Dexie {
  movies!: Table<StoredMovie, string>;
  meta!: Table<SnapshotMeta, string>;
  history!: Table<StoredHistory, number>;
  metadata!: Table<StoredMetadataRow, string>;
  snoozed!: Table<StoredSnooze, string>;
  outbox!: Table<StoredOutbox, string>;
  session!: Table<StoredSession, string>;

  constructor(name: string, options: Pick<DexieOptions, 'indexedDB' | 'IDBKeyRange'>) {
    super(name, options);
    this.version(1).stores({ movies: 'id', meta: 'key' });
    // Additive: an existing version-1 database is upgraded in place and keeps its snapshot.
    this.version(2).stores({ history: '++seq', metadata: 'key, savedAt' });
    this.version(3).stores({ snoozed: 'movieId, until' });
    this.version(4).stores({ outbox: 'movieId, queuedAt', session: 'key' });
  }
}

type DexieOptions = ConstructorParameters<typeof Dexie>[1] & object;

export interface DexieLibraryCacheOptions {
  /** Defaults to the browser's `indexedDB`. Tests give each simulated device its own. */
  readonly indexedDB?: IDBFactory;
  readonly IDBKeyRange?: typeof IDBKeyRange;
  readonly now?: () => Date;
}

/** Every persisted movie field, in the schema's own order. Adding a field to the schema changes this list, and so the checksum. */
const MOVIE_FIELDS = Object.keys(movieSchema.shape) as readonly (keyof Movie)[];

/**
 * A 53-bit hash (cyrb53) over EVERY persisted field of every movie, rows in id order and fields in
 * schema order. It detects accidental damage to any part of a snapshot: a changed title, rating
 * or note as well as a missing, extra or re-versioned row. It is not tamper-proof and is not meant
 * to be: whoever can edit IndexedDB can edit the checksum beside the data, which is why the saved
 * copy is a convenience and never a security boundary (docs/threat-model.md, T23).
 */
export function snapshotChecksum(movies: readonly Movie[]): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const feed = (text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
  };
  for (const movie of [...movies].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    // JSON keeps types apart (null vs "null", 4 vs "4") and escapes separators inside text.
    feed(JSON.stringify(MOVIE_FIELDS.map((field) => movie[field])));
    feed('\n');
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

const isUserDatabase = (name: string) => name.startsWith(CACHE_DATABASE_PREFIX);
const userOf = (name: string) => name.slice(CACHE_DATABASE_PREFIX.length);

export interface DeviceStore {
  readonly library: LibraryCache;
  readonly history: HistoryStore;
  readonly metadata: MetadataStore;
  readonly snoozes: SnoozeStore;
  /** Changes made offline, waiting to be sent. NOT a disposable cache: see OutboxStore. */
  readonly outbox: OutboxStore;
  readonly roles: RoleStore;
}

/** Just the saved library (what M4 exposed). */
export const createDexieLibraryCache = (options: DexieLibraryCacheOptions = {}): LibraryCache =>
  createDexieDeviceStore(options).library;

export function createDexieDeviceStore(options: DexieLibraryCacheOptions = {}): DeviceStore {
  const now = options.now ?? (() => new Date());
  const dexieOptions = {
    ...(options.indexedDB ? { indexedDB: options.indexedDB } : {}),
    ...(options.IDBKeyRange ? { IDBKeyRange: options.IDBKeyRange } : {}),
  };
  const open = new Map<string, LibraryDatabase>();
  let lastTaken = 0;
  /** Bumped whenever an account's cache is wiped; a write that started earlier must not land. */
  const generation = new Map<string, number>();
  const generationOf = (userId: string) => generation.get(userId) ?? 0;
  const bump = (userId: string) => generation.set(userId, generationOf(userId) + 1);

  const databaseFor = (userId: string): LibraryDatabase => {
    let db = open.get(userId);
    if (!db) {
      db = new LibraryDatabase(cacheDatabaseName(userId), dexieOptions);
      open.set(userId, db);
    }
    return db;
  };

  const destroy = async (userId: string): Promise<void> => {
    bump(userId);
    const db = open.get(userId);
    open.delete(userId);
    db?.close();
    try {
      await new Dexie(cacheDatabaseName(userId), dexieOptions).delete();
    } catch {
      /* nothing more can be done; the data is unreachable by any other account anyway */
    }
  };

  /**
   * A saved library that cannot be trusted is removed. Normally that means the whole database, but
   * if changes made offline are waiting in it they are the only copy of what the person typed, so
   * only the library tables are cleared and the waiting changes stay.
   */
  const discardSnapshot = async (userId: string): Promise<void> => {
    try {
      const db = databaseFor(userId);
      await db.open();
      if ((await db.outbox.count()) > 0) {
        await db.transaction('rw', db.movies, db.meta, async () => {
          await db.movies.clear();
          await db.meta.clear();
        });
        return;
      }
    } catch {
      /* fall through: an unreadable database cannot be partially cleaned */
    }
    await destroy(userId);
  };

  /**
   * A database Dexie refuses to open (Dexie 4 normally tolerates a newer schema, so this is a
   * fallback for browsers or versions that do not): the copy is disposable, so remove it.
   */
  const isVersionConflict = (error: unknown) =>
    error instanceof Error && (error.name === 'VersionError' || error.name === 'UpgradeError');

  /**
   * Every account database in this browser profile. `indexedDB.databases()` is available in all
   * current browsers; where it is not, only databases this page opened are known, which still
   * covers the signed-in account and the one it replaces.
   */
  const knownDatabases = async (): Promise<string[]> => {
    const factory = options.indexedDB ?? (typeof indexedDB === 'undefined' ? null : indexedDB);
    if (!factory || typeof factory.databases !== 'function') return [];
    try {
      const all = await factory.databases();
      return all.flatMap((entry) =>
        entry.name !== undefined && isUserDatabase(entry.name) ? [entry.name] : [],
      );
    } catch {
      return [];
    }
  };

  const library: LibraryCache = {
    async read(userId) {
      let validId: string;
      try {
        validId = userOf(cacheDatabaseName(userId));
      } catch {
        return null; // not a UUID: fail closed
      }
      try {
        const db = databaseFor(validId);
        const { meta, rows } = await db.transaction('r', db.meta, db.movies, async () => ({
          meta: await db.meta.get('library'),
          rows: await db.movies.orderBy('id').toArray(),
        }));
        if (!meta) {
          // Rows without the record that vouches for them: an interrupted or foreign write. Our own
          // writes cannot produce this (rows and meta commit in one transaction), so it is doubtful
          // and private data may be sitting there. Delete it. Nothing at all is simply "no copy".
          if (rows.length > 0) await discardSnapshot(validId);
          return null;
        }

        const checked = checkSnapshot(meta, rows, validId, now());
        if (checked === null) {
          await discardSnapshot(validId);
          return null;
        }
        return checked;
      } catch (error) {
        if (isVersionConflict(error)) await destroy(validId);
        return null;
      }
    },

    async write(userId, movies) {
      let validId: string;
      try {
        validId = userOf(cacheDatabaseName(userId));
      } catch {
        return false;
      }
      const startedAt = generationOf(validId);
      // When the server's answer arrived, not when this save happens to run. Two loads in flight
      // can finish their saves in either order; the snapshot taken LATER must always win, so a
      // slow older answer can never put the saved copy back in time. Strictly increasing per
      // instance, so two saves in the same millisecond still have an order.
      const takenAt = new Date(Math.max(now().getTime(), lastTaken + 1));
      lastTaken = takenAt.getTime();
      try {
        const db = databaseFor(validId);
        await db.open();
        // The account may have been wiped (sign-out, account change) while the database opened.
        if (generationOf(validId) !== startedAt || open.get(validId) !== db) return false;
        const meta: SnapshotMeta = {
          key: 'library',
          formatVersion: CACHE_FORMAT_VERSION,
          userId: validId,
          savedAt: takenAt.toISOString(),
          count: movies.length,
          checksum: snapshotChecksum(movies),
        };
        const stored = await db.transaction('rw', db.meta, db.movies, async () => {
          const existing = await db.meta.get('library');
          if (existing && Date.parse(existing.savedAt) > takenAt.getTime()) return false; // a newer one is already here
          await db.movies.clear();
          await db.movies.bulkPut([...movies]);
          await db.meta.put(meta);
          return true;
        });
        return stored && generationOf(validId) === startedAt;
      } catch (error) {
        if (isVersionConflict(error)) await destroy(validId);
        return false; // a full disk or a private window must never break the app
      }
    },

    async forget(userId) {
      try {
        await destroy(userOf(cacheDatabaseName(userId)));
      } catch {
        /* not a valid account id: there is nothing of it to delete */
      }
    },

    async retainOnly(userId) {
      const keep = userId === null ? null : safeId(userId);
      const names = new Set<string>(await knownDatabases());
      for (const id of open.keys()) names.add(cacheDatabaseName(id));
      await Promise.all(
        [...names]
          .map(userOf)
          .filter((id) => id !== keep)
          .map((id) => destroy(id)),
      );
    },
  };

  /**
   * Runs `run` against one account's database, or returns `fallback` if the id is not an account,
   * the account was wiped meanwhile, or the browser refuses. Never throws.
   */
  const forAccount = async <T>(
    userId: string,
    fallback: T,
    run: (db: LibraryDatabase) => Promise<T>,
  ): Promise<T> => {
    const id = safeId(userId);
    if (id === null) return fallback;
    const startedAt = generationOf(id);
    try {
      const db = databaseFor(id);
      await db.open();
      if (generationOf(id) !== startedAt || open.get(id) !== db) return fallback;
      return await run(db);
    } catch (error) {
      if (isVersionConflict(error)) await destroy(id);
      return fallback;
    }
  };

  const history: HistoryStore = {
    recent: (userId, limit) =>
      forAccount<HistoryEntry[]>(userId, [], async (db) => {
        const rows = await db.history.orderBy('seq').reverse().limit(Math.max(0, limit)).toArray();
        return rows.flatMap((row) => {
          const parsed = historyRowSchema.safeParse(row);
          return parsed.success ? [parsed.data] : [];
        });
      }),
    record: (userId, entry) =>
      // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- a write has no result to return
      forAccount<void>(userId, undefined, async (db) => {
        await db.transaction('rw', db.history, async () => {
          await db.history.add({
            movieId: entry.movieId,
            genres: [...entry.genres],
            result: entry.result,
            at: entry.at,
          });
          const extra = (await db.history.count()) - HISTORY_LIMIT;
          if (extra > 0) {
            await db.history.bulkDelete(await db.history.orderBy('seq').limit(extra).primaryKeys());
          }
        });
      }),
    clear: (userId) =>
      // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- a write has no result to return
      forAccount<void>(userId, undefined, async (db) => {
        await db.history.clear();
      }),
  };

  const metadata: MetadataStore = {
    get: (userId, key) =>
      forAccount<StoredMetadata | null>(userId, null, async (db) => {
        const row = await db.metadata.get(key);
        return row ? { value: row.value, savedAt: row.savedAt } : null;
      }),
    put: (userId, key, value, at) =>
      // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- a write has no result to return
      forAccount<void>(userId, undefined, async (db) => {
        await db.transaction('rw', db.metadata, async () => {
          await db.metadata.put({ key, value, savedAt: at.toISOString() });
          const extra = (await db.metadata.count()) - METADATA_LIMIT;
          if (extra > 0) {
            await db.metadata.bulkDelete(
              await db.metadata.orderBy('savedAt').limit(extra).primaryKeys(),
            );
          }
        });
      }),
    clear: (userId) =>
      // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- a write has no result to return
      forAccount<void>(userId, undefined, async (db) => {
        await db.metadata.clear();
      }),
  };

  const snoozes: SnoozeStore = {
    active: (userId, at) =>
      forAccount<readonly string[]>(userId, [], async (db) => {
        const rows = await db.snoozed.where('until').above(at.toISOString()).toArray();
        return rows.flatMap((row) => (typeof row.movieId === 'string' ? [row.movieId] : []));
      }),
    snooze: (userId, movieId, until, at) =>
      // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- a write has no result to return
      forAccount<void>(userId, undefined, async (db) => {
        await db.transaction('rw', db.snoozed, async () => {
          await db.snoozed.put({ movieId, until: until.toISOString() });
          // Housekeeping: finished snoozes mean nothing, and the table stays small.
          await db.snoozed.where('until').belowOrEqual(at.toISOString()).delete();
          const extra = (await db.snoozed.count()) - SNOOZE_LIMIT;
          if (extra > 0) {
            await db.snoozed.bulkDelete(
              await db.snoozed.orderBy('until').limit(extra).primaryKeys(),
            );
          }
        });
      }),
    clear: (userId) =>
      // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- a write has no result to return
      forAccount<void>(userId, undefined, async (db) => {
        await db.snoozed.clear();
      }),
  };

  const outbox: OutboxStore = {
    list: (userId) =>
      forAccount<readonly OutboxEntry[]>(userId, [], async (db) => {
        const rows = await db.outbox.orderBy('queuedAt').toArray();
        return rows.flatMap((row) => {
          const parsed = outboxEntrySchema.safeParse(row);
          return parsed.success ? [toEntry(parsed.data)] : [];
        });
      }),

    enqueue: (userId, op, at) =>
      forAccount<EnqueueResult>(userId, { ok: false, reason: 'unavailable' }, async (db) =>
        db.transaction('rw', db.outbox, async (): Promise<EnqueueResult> => {
          const row = await db.outbox.get(op.movieId);
          const parsed = row ? outboxEntrySchema.safeParse(row) : null;
          // A row that cannot be read is neither overwritten nor trusted: refuse, keep it as it is.
          if (row && !parsed?.success) return { ok: false, reason: 'unavailable' };
          const result = coalesce(parsed?.success ? toEntry(parsed.data) : undefined, op, at);
          if (result.action === 'blocked') {
            return {
              ok: false,
              reason: result.reason === 'deleted' ? 'blocked_deleted' : 'blocked_needs_attention',
            };
          }
          if (result.action === 'drop') {
            await db.outbox.delete(op.movieId);
            return { ok: true, entry: null };
          }
          await db.outbox.put(result.entry);
          return { ok: true, entry: result.entry };
        }),
      ),

    settle: (userId, movieId, rev, accepted) =>
      // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- a write has no result to return
      forAccount<void>(userId, undefined, async (db) => {
        await db.transaction('rw', db.outbox, async () => {
          const row = await db.outbox.get(movieId);
          const parsed = row ? outboxEntrySchema.safeParse(row) : null;
          if (!parsed?.success) return;
          const entry = toEntry(parsed.data);
          if (entry.rev === rev) {
            await db.outbox.delete(movieId);
            return;
          }
          // Changed again while being sent. Keep the newer change, re-based onto what the server now holds.
          if (accepted.updatedAt === null) return; // the title is gone; a newer change to it cannot apply
          await db.outbox.put({
            ...entry,
            kind: entry.kind === 'create' ? 'update' : entry.kind,
            baseUpdatedAt: accepted.updatedAt,
          });
        });
      }),

    needsAttention: (userId, movieId, rev, reason, message) =>
      // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- a write has no result to return
      forAccount<void>(userId, undefined, async (db) => {
        await db.transaction('rw', db.outbox, async () => {
          const row = await db.outbox.get(movieId);
          const parsed = row ? outboxEntrySchema.safeParse(row) : null;
          if (!parsed?.success || parsed.data.rev !== rev) return;
          await db.outbox.put({ ...toEntry(parsed.data), state: 'attention', reason, message });
        });
      }),

    keepMine: (userId, movieId, baseUpdatedAt) =>
      forAccount<boolean>(userId, false, async (db) =>
        db.transaction('rw', db.outbox, async () => {
          const row = await db.outbox.get(movieId);
          const parsed = row ? outboxEntrySchema.safeParse(row) : null;
          if (!parsed?.success) return false;
          const entry = toEntry(parsed.data);
          // A create has no server version to re-base onto: it is simply tried again.
          if (entry.kind !== 'create' && baseUpdatedAt === null) return false;
          const { reason: _reason, message: _message, ...rest } = entry;
          await db.outbox.put({
            ...rest,
            state: 'pending',
            rev: entry.rev + 1,
            baseUpdatedAt: entry.kind === 'create' ? null : baseUpdatedAt,
          });
          return true;
        }),
      ),

    discard: (userId, movieId) =>
      // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- a write has no result to return
      forAccount<void>(userId, undefined, async (db) => {
        await db.outbox.delete(movieId);
      }),
  };

  const roles: RoleStore = {
    get: (userId) =>
      forAccount<StoredRole | null>(userId, null, async (db) => {
        const row = await db.session.get('role');
        // Whatever is stored is only believed if it is exactly one of the two known roles.
        const stored: string | undefined = row?.role;
        if (!row || (stored !== 'owner' && stored !== 'viewer')) return null;
        const age = now().getTime() - Date.parse(row.savedAt);
        if (Number.isNaN(age) || age > MAX_ROLE_AGE_MS || age < -5 * 60_000) return null;
        return { role: row.role, savedAt: row.savedAt };
      }),
    put: (userId, role, at) =>
      // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- a write has no result to return
      forAccount<void>(userId, undefined, async (db) => {
        await db.session.put({ key: 'role', role, savedAt: at.toISOString() });
      }),
  };

  return { library, history, metadata, snoozes, outbox, roles };
}

function safeId(userId: string): string | null {
  try {
    return userOf(cacheDatabaseName(userId));
  } catch {
    return null;
  }
}

/** Returns the snapshot if every check passes, otherwise null (the caller deletes it). */
function checkSnapshot(
  meta: SnapshotMeta,
  rows: readonly unknown[],
  userId: string,
  now: Date,
): CachedLibrary | null {
  if (meta.formatVersion !== CACHE_FORMAT_VERSION) return null;
  if (meta.userId !== userId) return null;
  const savedAt = Date.parse(meta.savedAt);
  if (Number.isNaN(savedAt)) return null;
  const age = now.getTime() - savedAt;
  if (age > MAX_CACHE_AGE_MS) return null;
  if (age < -5 * 60_000) return null; // saved "in the future": the clock was wrong, do not trust it
  // `count` is redundant with the checksum (a missing row changes it) and kept as a cheap first test.
  if (rows.length !== meta.count) return null;

  const movies: Movie[] = [];
  for (const row of rows) {
    const parsed = movieSchema.safeParse(row);
    if (!parsed.success) return null;
    movies.push(parsed.data);
  }
  if (snapshotChecksum(movies) !== meta.checksum) return null;
  return { movies, savedAt: meta.savedAt };
}
