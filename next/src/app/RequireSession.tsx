import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { FullPageStatus } from '@/components/ui/FullPageStatus';
import { Button } from '@/components/ui/Button';
import { useQueryClient } from '@tanstack/react-query';
import { useLibrarySource } from '@/features/library/queries';
import { SyncProvider } from '@/features/sync/SyncProvider';
import { SyncStatus } from '@/features/sync/SyncStatus';
import { describeAge } from '@/features/library/format';
import { moviesKey } from './privateKey';
import { useAuth } from './auth/auth';
import { RuntimeRepositoryProvider } from './RuntimeRepositoryProvider';
import { useRuntime } from './runtime';
import { useSession } from './session';
import { SignedInSession } from './SignedInSession';

/**
 * Banners that must be impossible to miss: sample data, a library shown from the copy saved on
 * this device, or a role that could not be verified.
 */
function StatusBanners() {
  const runtime = useRuntime();
  const session = useSession();
  const queryClient = useQueryClient();
  const source = useLibrarySource();
  const savedCopy = source?.origin === 'cache';
  return (
    <>
      {savedCopy ? (
        <div
          role="status"
          className="bg-gold/15 text-gold flex flex-wrap items-center justify-center gap-3 px-4 py-2 text-center text-sm"
        >
          <span>
            Can’t reach the server — showing your library as saved{' '}
            {describeAge(source.at, new Date())}.{' '}
            {runtime.outbox
              ? 'You can still add, edit and delete: changes are kept on this device and sync when you’re back online.'
              : 'Adding, editing and deleting need a connection.'}
          </span>
          <Button
            variant="secondary"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: moviesKey(session.userId) });
            }}
          >
            Try again
          </Button>
        </div>
      ) : null}
      {runtime.kind === 'mock' ? (
        <p role="note" className="bg-gold/15 text-gold px-4 py-1.5 text-center text-xs">
          Preview mode — sample data only. Nothing here is your real library.
        </p>
      ) : null}
      {session.roleVerified || session.roleFromDevice || savedCopy ? null : (
        <div
          role="alert"
          className="bg-danger/10 flex flex-wrap items-center justify-center gap-3 px-4 py-2 text-center text-sm"
        >
          <span>We couldn’t verify your permissions, so you’re in view-only mode.</span>
          <Button variant="secondary" onClick={session.retryRole}>
            Try again
          </Button>
        </div>
      )}
    </>
  );
}

/**
 * Layout route for everything that needs an account. Signed-out visitors are sent to sign in;
 * nothing private renders (and no repository is even created) until a session exists.
 */
export function RequireSession() {
  const { state } = useAuth();
  const location = useLocation();

  switch (state.status) {
    case 'loading':
      return <FullPageStatus label="Loading…" />;
    case 'recovery':
      return <Navigate to="/reset-password" replace />;
    case 'signed_out':
      return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
    case 'signed_in':
      return (
        <SignedInSession user={state.user}>
          <RuntimeRepositoryProvider>
            <SyncProvider>
              <StatusBanners />
              <SyncStatus />
              <Outlet />
            </SyncProvider>
          </RuntimeRepositoryProvider>
        </SignedInSession>
      );
  }
}
