import type { QueryClient } from '@tanstack/react-query';
import type { LibraryCache } from '@/data/local/libraryCache';
import type { ActiveUserStore } from './activeUser';
import { PRIVATE_ROOT, belongsToAnotherUser } from './privateKey';

/** The cache events type the key loosely; read it as `unknown` parts. */
function keyOf(query: { readonly queryKey: unknown }): readonly unknown[] {
  const key = query.queryKey;
  return Array.isArray(key) ? (key as readonly unknown[]) : [];
}

const foreignTo = (userId: string) => ({
  predicate: (query: { queryKey: readonly unknown[] }) =>
    belongsToAnotherUser(query.queryKey, userId),
});

/**
 * Enforces account isolation on the query cache, synchronously:
 *  - the moment the active account changes, every private query of another account is cancelled
 *    and REMOVED (not merely hidden), and on sign-out everything is cleared, mutations included;
 *  - the saved copy on the device (IndexedDB) is deleted in step: every other account's, and all
 *    of them on sign-out;
 *  - as a backstop, any private entry for a non-active account that ever appears in the cache
 *    (a late write, a future bug) is removed immediately.
 * Returns a function that detaches the guard.
 */
export function attachPrivateCacheGuard(
  queryClient: QueryClient,
  store: ActiveUserStore,
  saved: LibraryCache | null = null,
) {
  const purge = (atStartUp = false) => {
    const userId = store.get();
    // The copy kept on the device follows the same rule as the in-memory one: only the active
    // account's survives, and nothing survives sign-out. At start-up "nobody" only means auth has
    // not answered yet, so it must NOT wipe the copy a returning (possibly offline) person needs;
    // a definitive "signed out" is reported by the auth provider instead.
    if (userId !== null || !atStartUp) void saved?.retainOnly(userId);
    if (userId === null) {
      void queryClient.cancelQueries();
      queryClient.clear(); // sign-out: nothing from the session may survive
      return;
    }
    void queryClient.cancelQueries(foreignTo(userId));
    queryClient.removeQueries(foreignTo(userId));
  };

  const cache = queryClient.getQueryCache();
  const stopCache = cache.subscribe((event) => {
    if (event.type !== 'added' && event.type !== 'updated') return;
    const key = keyOf(event.query);
    if (key[0] !== PRIVATE_ROOT) return;
    const userId = store.get();
    if (userId === null || key[1] !== userId) cache.remove(event.query);
  });
  const stopStore = store.subscribe(() => {
    purge();
  });
  purge(true); // cover anything cached before the guard attached
  return () => {
    stopStore();
    stopCache();
  };
}
