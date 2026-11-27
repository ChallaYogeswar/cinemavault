import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LibraryCache } from '@/data/local/libraryCache';
import type { ActiveUserStore } from './activeUser';
import { attachPrivateCacheGuard } from './attachPrivateCacheGuard';

/** Mounts the account-isolation guard for the lifetime of the app. See attachPrivateCacheGuard. */
export function PrivateCacheGuard({
  store,
  saved = null,
}: {
  readonly store: ActiveUserStore;
  /** The on-device copy of the library, wiped in step with the in-memory cache. */
  readonly saved?: LibraryCache | null;
}) {
  const queryClient = useQueryClient();
  useEffect(() => attachPrivateCacheGuard(queryClient, store, saved), [queryClient, store, saved]);
  return null;
}
