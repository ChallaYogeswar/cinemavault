import type { HistoryEntry } from '@/domain/recommend';

/**
 * Small per-account things kept on this device next to the saved library, in the SAME database
 * (so they are wiped with it, and an account switch cannot carry them over):
 *  - what Discover has shown lately (so the next pick feels fresh);
 *  - titles the person asked Discover to hide for a while;
 *  - public metadata looked up for titles in the library (posters, trailers), so a library of
 *    thousands is not looked up again on every visit.
 * Both are conveniences, never sources of truth, and every method is total: a full disk, a private
 * window or a wiped account turns into "nothing saved", never an exception.
 */
export const HISTORY_LIMIT = 40;
export const METADATA_LIMIT = 6_000;
/** "Not now" hides a title from Discover for this long. */
export const SNOOZE_DAYS = 7;
export const SNOOZE_LIMIT = 500;

export interface HistoryStore {
  /** Newest first. Rows that fail validation are skipped. */
  recent(userId: string, limit: number): Promise<HistoryEntry[]>;
  record(userId: string, entry: HistoryEntry): Promise<void>;
  /** Forgets this account's history only (the library copy is untouched). */
  clear(userId: string): Promise<void>;
}

export interface SnoozeStore {
  /** Ids of the titles hidden at `now` (a snooze that has run out no longer counts). */
  active(userId: string, now: Date): Promise<readonly string[]>;
  /** Hides a title until `until`; hiding it again simply extends or replaces the time. */
  snooze(userId: string, movieId: string, until: Date, now: Date): Promise<void>;
  /** Shows everything again. Only this account, only the hiding: the library is untouched. */
  clear(userId: string): Promise<void>;
}

export interface StoredMetadata {
  readonly value: unknown;
  /** When this was looked up (ISO-8601). */
  readonly savedAt: string;
}

export interface MetadataStore {
  get(userId: string, key: string): Promise<StoredMetadata | null>;
  put(userId: string, key: string, value: unknown, at: Date): Promise<void>;
  /** Forgets every saved lookup for this account only (the library copy is untouched). */
  clear(userId: string): Promise<void>;
}
