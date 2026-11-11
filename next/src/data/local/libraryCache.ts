import type { Movie } from '@/domain/movie';

/**
 * A saved copy of the last library this device loaded successfully, for reading when the server
 * cannot be reached. It is a CACHE, never a source of truth:
 *  - it is written only from a successful server answer, never from optimistic or edited data;
 *  - it is replaced as a whole, so it is always one consistent snapshot;
 *  - anything doubtful about it (wrong shape, wrong account, old format, too old, damaged) makes
 *    it count as absent, and the damaged copy is deleted;
 *  - nothing in it ever changes the server: writes stay online-only.
 */
export interface CachedLibrary {
  readonly movies: readonly Movie[];
  /** When the snapshot was taken (ISO-8601, from this device's clock). */
  readonly savedAt: string;
}

export interface LibraryCache {
  /** The saved library of THIS account, or null when there is none or it cannot be trusted. Never throws. */
  read(userId: string): Promise<CachedLibrary | null>;
  /**
   * Replaces this account's saved library with `movies`. Returns false (and saves nothing) if the
   * account's cache was wiped while the write was waiting, if a NEWER snapshot is already saved
   * (saves may finish out of order; the later answer wins), or if the browser refused. Never throws.
   */
  write(userId: string, movies: readonly Movie[]): Promise<boolean>;
  /** Deletes this account's saved library. Never throws. */
  forget(userId: string): Promise<void>;
  /**
   * Deletes every account's saved library except `userId`'s (all of them when `userId` is null).
   * Called whenever the signed-in account changes, so a cache can never outlive its session.
   */
  retainOnly(userId: string | null): Promise<void>;
}

/**
 * Version of the stored FORMAT (what a snapshot looks like), separate from IndexedDB's own schema
 * version. Because the cache is disposable, a snapshot written by a different format version is
 * discarded and re-fetched rather than migrated in place.
 */
/** 2: the checksum covers every persisted field (version 1 covered only id and updatedAt). */
export const CACHE_FORMAT_VERSION = 2;

/** A snapshot older than this is not shown: after a long absence the server is the better answer. */
export const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
