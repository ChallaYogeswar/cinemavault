import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { createActiveUserStore } from '@/app/activeUser';
import { PrivateCacheGuard } from '@/app/PrivateCacheGuard';
import { createQueryClient } from '@/app/queryClient';
import { createTestRouter } from '@/app/router';
import { RuntimeContext, type Runtime } from '@/app/runtime';
import { AccountRepository } from './AccountRepository';
import { HarnessSession } from './HarnessSession';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { buildMovie } from '@/data/mock/fixtures';
import {
  createMockMovieRepository,
  type MockMovieRepository,
} from '@/data/mock/mockMovieRepository';
import type { Movie } from '@/domain/movie';
import type { Role } from '@/domain/permissions';

export const ALICE = '00000000-0000-4000-8000-0000000000a1';
export const BOB = '00000000-0000-4000-8000-0000000000b2';

/** Each account owns a clearly different library so any leak between them is visible. */
const libraryOf = (owner: string): Movie[] =>
  owner === ALICE
    ? [
        buildMovie(101, ['Alice Alpha', 'movie', 2001, 'Drama', 100, 3, '2026-01-01', null], ALICE),
        buildMovie(
          102,
          ['Alice Beta', 'movie', 2002, 'Comedy', 90, null, 'unwatched', null],
          ALICE,
        ),
      ]
    : [
        buildMovie(201, ['Bob Alpha', 'movie', 2011, 'Horror', 95, 4, '2026-02-02', null], BOB),
        buildMovie(202, ['Bob Beta', 'tv', 2012, 'Thriller', 45, null, 'unwatched', null], BOB),
      ];

interface Options {
  /** Who is signed in at the start. Defaults to Alice. */
  readonly start?: string | null;
  /** Role per account; anyone not listed is an owner. */
  readonly roles?: Readonly<Record<string, Role>>;
  readonly path?: string;
  /** Runs before anything renders, e.g. to hold back an account's first request. */
  readonly prepare?: (repoFor: (userId: string) => MockMovieRepository) => void;
  /** Rendered inside the signed-in tree next to the router (hooks probes). */
  readonly extra?: React.ReactNode;
}

/**
 * The real provider stack with TWO accounts that outlive each other's sessions, mirroring how M3
 * wires Supabase: the active-user store and the cache guard sit OUTSIDE the signed-in tree, the
 * session and repository sit inside it, and each account has its own repository whose pending
 * calls can be held back to model slow requests.
 */
export function renderAccounts({
  start = ALICE,
  roles = {},
  path = '/library',
  prepare,
  extra,
}: Options = {}) {
  const queryClient = createQueryClient({ retry: false });
  const store = createActiveUserStore(start);
  const router = createTestRouter([path]);
  const user = userEvent.setup();
  const repos = new Map<string, MockMovieRepository>();
  const roleOf = (userId: string): Role => roles[userId] ?? 'owner';

  const repoFor = (userId: string): MockMovieRepository => {
    let repo = repos.get(userId);
    if (!repo) {
      repo = createMockMovieRepository({
        seed: libraryOf(userId),
        ownerId: userId,
        getRole: () => roleOf(userId),
      });
      repos.set(userId, repo);
    }
    return repo;
  };

  prepare?.(repoFor);

  const runtime: Runtime = {
    kind: 'mock',
    profiles: null,
    libraryCache: null,
    history: null,
    snoozes: null,
    outbox: null,
    roles: null,
    metadata: null,
    repositoryFor: () => {
      throw new Error('the harness supplies repositories itself');
    },
  };

  render(
    <QueryClientProvider client={queryClient}>
      <PrivateCacheGuard store={store} />
      <RuntimeContext value={runtime}>
        <HarnessSession store={store} roleOf={roleOf}>
          <AccountRepository repoFor={repoFor}>
            <ToastProvider>
              {extra}
              <RouterProvider router={router} />
            </ToastProvider>
          </AccountRepository>
        </HarnessSession>
      </RuntimeContext>
    </QueryClientProvider>,
  );

  return {
    user,
    router,
    queryClient,
    store,
    repoFor,
    signInAs: (userId: string) => {
      store.set(userId);
    },
    signOut: () => {
      store.set(null);
    },
  };
}
