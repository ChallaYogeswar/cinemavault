import { useMemo, type ReactNode } from 'react';
import { RepositoryContext } from './repository';
import { useRuntime } from './runtime';
import { useSession } from './session';

/**
 * Supplies the repository for the signed-in account. One per account (rebuilt when the account
 * changes), so a repository, its cache key and its pending requests can never be shared between
 * two people. It reads the role through the session on every call, so a role change is enforced
 * by the repository too, not only hidden in the UI.
 */
export function RuntimeRepositoryProvider({ children }: { readonly children: ReactNode }) {
  const runtime = useRuntime();
  const { getRole, userId } = useSession();
  const repository = useMemo(
    () => runtime.repositoryFor(userId, getRole),
    [runtime, userId, getRole],
  );
  return <RepositoryContext value={repository}>{children}</RepositoryContext>;
}
