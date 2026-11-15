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
  const { profiles, roles } = useRuntime();
  const profile = useQuery({
    queryKey: privateKey(user.id, 'profile'),
    queryFn: async (): Promise<{ readonly profile: unknown; readonly fromDevice: boolean }> => {
      if (!profiles) throw new Error('No profile source is configured');
      const result = await profiles.load(user.id);
      if (result.ok) {
        // Remember what the server confirmed, so an owner who later opens the app offline can keep working.
        if (roles) void roles.put(user.id, resolveRole(result.value), new Date());
        return { profile: result.value, fromDevice: false };
      }
      // ONLY "could not reach the server" may fall back to what this device last confirmed. A
      // refusal, a bad answer or any other failure stays fail-closed (viewer). The server checks
      // every change again when it is sent, so this is a convenience, never an authorization.
      if (result.error.code === 'network' && roles) {
        const stored = await roles.get(user.id);
        if (stored) return { profile: { role: stored.role }, fromDevice: true };
      }
      throw new RepositoryError(result.error);
    },
    // Role refresh strategy (see docs/architecture.md): the role is read again on every sign-in or
    // reload, when the tab regains focus once this is a minute old, when a write is refused as
    // forbidden, and on demand from Settings. A failed re-read falls back to viewer.
    // An answer that came from this device (offline) is checked with the server as soon as possible.
    staleTime: (query) => (query.state.data?.fromDevice ? 0 : 60_000),
    refetchOnReconnect: 'always',
  });

  if (profile.isPending) return <FullPageStatus label="Checking your permissions…" />;

  const fromDevice = profile.isSuccess && profile.data.fromDevice;
  const verified = profile.isSuccess && !fromDevice;
  return (
    <SessionProvider
      store={store}
      role={profile.isSuccess ? resolveRole(profile.data.profile) : 'viewer'}
      roleVerified={verified}
      roleFromDevice={fromDevice}
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
