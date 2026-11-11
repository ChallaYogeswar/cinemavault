import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { createActiveUserStore } from '@/app/activeUser';
import { ActiveUserContext } from '@/app/activeUserContext';
import { AuthProvider } from '@/app/auth/AuthProvider';
import { PrivateCacheGuard } from '@/app/PrivateCacheGuard';
import { createQueryClient } from '@/app/queryClient';
import { createFullTestRouter } from '@/app/router';
import { RuntimeContext, type Runtime } from '@/app/runtime';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { buildMovie } from '@/data/mock/fixtures';
import {
  createMockMovieRepository,
  type MockMovieRepository,
} from '@/data/mock/mockMovieRepository';
import type { HistoryStore, SnoozeStore } from '@/data/local/deviceData';
import type { MetadataService } from '@/services/tmdb/metadataService';
import type { LibraryCache } from '@/data/local/libraryCache';
import type { Movie } from '@/domain/movie';
import { err, type AppError, type Result } from '@/domain/result';
import type { FakeAuth } from './fakes/fakeAuthService';
import type { FakeProfiles } from './fakes/fakeProfiles';

export const OWNER_ID = '00000000-0000-4000-8000-00000000c0a1';
export const FRIEND_ID = '00000000-0000-4000-8000-00000000f1e2';

const libraryOf = (owner: string): Movie[] => [
  buildMovie(301, ['Shared Alpha', 'movie', 2001, 'Drama', 100, 3, '2026-01-01', null], owner),
  buildMovie(302, ['Shared Beta', 'movie', 2002, 'Comedy', 90, null, 'unwatched', null], owner),
];

interface Options {
  readonly auth: FakeAuth;
  readonly profiles: FakeProfiles;
  readonly path?: string;
  /** Give each account its own library (default: everyone reads the owner's shared one). */
  readonly libraryFor?: (userId: string) => Movie[];
  /** While this returns true the SERVER refuses every write, as row-level security does. */
  /** Use this repository instead of the in-memory one (for example a real-Postgres device). */
  readonly repositoryFor?: Runtime['repositoryFor'];
  /** The on-device saved copy (default: none). */
  readonly cache?: LibraryCache | null;
  /** Per-account history and metadata on the device (default: none). */
  readonly device?: {
    history: HistoryStore | null;
    metadata: MetadataService | null;
    snoozes?: SnoozeStore | null;
  };
  /** While this returns true every repository call fails as if the connection were down. */
  readonly networkDown?: () => boolean;
  /** While this returns an error, the library cannot be listed and fails with exactly that error. */
  readonly listError?: () => AppError | null;
  readonly refuseWrites?: () => boolean | Promise<boolean>;
}

/**
 * The WHOLE application as production wires it (auth state machine, route guard, role from the
 * profile, per-account repository, cache guard), with the network replaced by fakes. Both the
 * owner and a friend read the same (owner's) library, as row-level security makes them.
 */
export function renderFullApp({
  auth,
  profiles,
  path = '/library',
  libraryFor,
  refuseWrites,
  networkDown,
  listError,
  repositoryFor: customRepository,
  cache = null,
  device,
}: Options) {
  const queryClient = createQueryClient({ retry: false });
  const store = createActiveUserStore(null);
  const router = createFullTestRouter([path]);
  const user = userEvent.setup();
  const repos = new Map<string, MockMovieRepository>();
  const shared = libraryOf(OWNER_ID);

  const runtime: Runtime = {
    kind: 'supabase',
    profiles,
    libraryCache: cache,
    history: device?.history ?? null,
    metadata: device?.metadata ?? null,
    snoozes: device?.snoozes ?? null,
    repositoryFor: (userId, getRole) => {
      if (customRepository) return customRepository(userId, getRole);
      const repo = createMockMovieRepository({
        seed: libraryFor ? libraryFor(userId) : shared,
        ownerId: OWNER_ID,
        getRole,
      });
      repos.set(userId, repo);
      if (!refuseWrites && !networkDown && !listError) return repo;
      const refuse = () => err('forbidden', 'new row violates row-level security policy');
      const offline = () => err('network', 'Couldn’t reach the server. Check your connection.');
      const guard = async <T,>(
        run: () => Promise<Result<T>>,
        write: boolean,
      ): Promise<Result<T>> => {
        if (networkDown?.()) return offline();
        if (write && refuseWrites && (await refuseWrites())) return refuse();
        return run();
      };
      return {
        ...repo,
        list: () => {
          const fault = listError?.() ?? null;
          return fault
            ? Promise.resolve({ ok: false, error: fault } as const)
            : guard(() => repo.list(), false);
        },
        get: (id) => guard(() => repo.get(id), false),
        create: (input) => guard(() => repo.create(input), true),
        update: (id, input, at) => guard(() => repo.update(id, input, at), true),
        remove: (id, at) => guard(() => repo.remove(id, at), true),
      };
    },
  };

  const view = render(
    <QueryClientProvider client={queryClient}>
      <ActiveUserContext value={store}>
        <PrivateCacheGuard store={store} saved={cache} />
        <RuntimeContext value={runtime}>
          <AuthProvider service={auth.service} store={store} saved={cache}>
            <ToastProvider>
              <RouterProvider router={router} />
            </ToastProvider>
          </AuthProvider>
        </RuntimeContext>
      </ActiveUserContext>
    </QueryClientProvider>,
  );
  return { user, router, queryClient, store, repos, unmount: view.unmount };
}
