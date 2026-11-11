import { useSyncExternalStore, type ReactNode } from 'react';
import type { ActiveUserStore } from '@/app/activeUser';
import { SessionProvider } from '@/app/SessionProvider';
import type { Role } from '@/domain/permissions';

/** A session whose role follows whoever is active, like the profile lookup does in production. */
export function HarnessSession({
  store,
  roleOf,
  children,
}: {
  readonly store: ActiveUserStore;
  readonly roleOf: (userId: string) => Role;
  readonly children: ReactNode;
}) {
  const userId = useSyncExternalStore(store.subscribe, store.get);
  return (
    <SessionProvider store={store} role={roleOf(userId ?? '')}>
      {children}
    </SessionProvider>
  );
}
