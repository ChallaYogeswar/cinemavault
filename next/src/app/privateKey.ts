/**
 * Every query that holds a signed-in user's private data is keyed `['u', userId, ...]`.
 * Two consequences, both deliberate:
 *  1. Data cached for one account can never be served under another account's key.
 *  2. A single predicate can find (and remove) everything belonging to anyone else.
 * Keying alone is not enough: stale data of the previous account would still sit in memory, so
 * `PrivateCacheGuard` also removes it. UI permissions are never a substitute for server-side
 * authorization (RLS), which remains the real control.
 */
export const PRIVATE_ROOT = 'u';

export const privateKey = (userId: string, ...parts: readonly string[]) =>
  [PRIVATE_ROOT, userId, ...parts] as const;

export const moviesKey = (userId: string) => privateKey(userId, 'movies');

/** Where the library on screen came from (server or the saved copy). Lives and dies with `moviesKey`. */
export const librarySourceKey = (userId: string) => privateKey(userId, 'library-source');

/** Changes made offline that are still waiting to be sent (device data; see features/sync). */
export const outboxKey = (userId: string) => privateKey(userId, 'outbox');

/** True for a private query that belongs to someone other than `userId`. */
export const belongsToAnotherUser = (queryKey: readonly unknown[], userId: string): boolean =>
  queryKey[0] === PRIVATE_ROOT && queryKey[1] !== userId;
