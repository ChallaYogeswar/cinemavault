import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { RepositoryError } from '@/data/repositories/repositoryError';
import { resolveRole } from '@/domain/permissions';
import type { AuthUser } from '@/services/auth/authService';
import { useActiveUser } from './activeUserContext';
import { useAuth } from './auth/auth';
import { privateKey } from './privateKey';
import { useRuntime } from './runtime';
import { SessionProvider } from './SessionProvider';
import { FullPageStatus } from '@/components/ui/FullPageStatus';

/**
 * Resolves the role for a signed-in user and opens the session. On a real backend the role comes
 * from the profiles table through `resolveRole`, which FAILS CLOSED: a missing profile, a failed
 * request or an unexpected shape all mean "viewer". The app waits for the first answer rather than
 * briefly showing owner controls, and a failed answer is shown to the user, not hidden.
 */
function ProfileSession({
  user,
  children,
}: {
  readonly user: AuthUser;
  readonly children: ReactNode;
}) {
  const store = useActiveUser();
  const { profiles } = useRuntime();
  const profile = useQuery({
    queryKey: privateKey(user.id, 'profile'),
    queryFn: async (): Promise<unknown> => {
      if (!profiles) throw new Error('No profile source is configured');
      const result = await profiles.load(user.id);
      if (!result.ok) throw new RepositoryError(result.error);
      return result.value;
    },
    // Role refresh strategy (see docs/architecture.md): the role is read again on every sign-in or
    // reload, when the tab regains focus once this is a minute old, when a write is refused as
    // forbidden, and on demand from Settings. A failed re-read falls back to viewer.
    staleTime: 60_000,
  });

  if (profile.isPending) return <FullPageStatus label="Checking your permissions…" />;

  const verified = profile.isSuccess;
  return (
    <SessionProvider
      store={store}
      role={verified ? resolveRole(profile.data) : 'viewer'}
      roleVerified={verified}
      retryRole={() => {
        void profile.refetch();
      }}
      email={user.email}
    >
      {children}
    </SessionProvider>
  );
}

export function SignedInSession({
  user,
  children,
}: {
  readonly user: AuthUser;
  readonly children: ReactNode;
}) {
  const auth = useAuth();
  const store = useActiveUser();
  if (auth.mock) {
    return (
      <SessionProvider store={store} role={auth.mock.role} email={user.email}>
        {children}
      </SessionProvider>
    );
  }
  return <ProfileSession user={user}>{children}</ProfileSession>;
}
