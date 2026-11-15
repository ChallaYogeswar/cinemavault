import { useCallback, useMemo } from 'react';
import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { librarySourceKey, moviesKey, privateKey } from '@/app/privateKey';
import { useMovieRepository } from '@/app/repository';
import { useRuntime } from '@/app/runtime';
import { loadLibrary, type LibrarySource } from '@/data/local/loadLibrary';
import { useSession } from '@/app/session';
import { useOutboxEntries } from '@/features/sync/useOutbox';
import { useQueueing } from '@/features/sync/useQueueing';
import type { Movie } from '@/domain/movie';
import { applyOutbox } from '@/domain/outbox';
import { can } from '@/domain/permissions';
import { RepositoryError } from '@/data/repositories/repositoryError';
import { SESSION_CHANGED, err, sessionChanged, type Result } from '@/domain/result';
import type { MovieInputValues } from '@/domain/validation';

/**
 * Binds a request to the sign-in session it STARTED under. The repository, the cache key and
 * `userId` all come from the same render, so they always agree; `isCurrent()` then asks the live,
 * synchronous session whether that session is still the active one. Nothing about a request may be
 * applied (cache, toast, navigation) once this returns false.
 */
interface Origin {
  readonly userId: string;
  readonly queryKey: ReturnType<typeof moviesKey>;
  readonly isCurrent: () => boolean;
}

function useOrigin(): Origin {
  const { userId, isCurrent } = useSession();
  return useMemo(() => ({ userId, queryKey: moviesKey(userId), isCurrent }), [userId, isCurrent]);
}

/** A copy shown from the device is checked again soon, so the server's answer is never kept waiting. */
const SAVED_COPY_STALE_MS = 5_000;
const SERVER_ANSWER_STALE_MS = 30_000;

/**
 * The library for the signed-in account: the server's answer, or — only when the server cannot be
 * reached — the copy this device saved last time. `useLibrarySource` says which one is on screen.
 */
export function useMoviesQuery() {
  const repository = useMovieRepository();
  const { libraryCache } = useRuntime();
  const origin = useOrigin();
  const queryClient = useQueryClient();
  const entries = useOutboxEntries();
  // The loaded list stays exactly what the server (or the saved copy) said; changes still waiting
  // to be sent are laid over it only for display, so they never reach the saved copy.
  const withWaitingChanges = useCallback(
    (movies: readonly Movie[]) => applyOutbox(movies, entries, origin.userId),
    [entries, origin.userId],
  );
  return useQuery({
    queryKey: origin.queryKey,
    select: withWaitingChanges,
    queryFn: async (): Promise<readonly Movie[]> => {
      const loaded = await loadLibrary({
        repository,
        cache: libraryCache,
        userId: origin.userId,
        isCurrent: origin.isCurrent,
      });
      // A list that belongs to a previous account must never become data for the current one.
      if (!origin.isCurrent()) throw new RepositoryError(SESSION_CHANGED);
      if (!loaded.ok) throw new RepositoryError(loaded.error);
      queryClient.setQueryData<LibrarySource>(librarySourceKey(origin.userId), loaded.value.source);
      return loaded.value.movies;
    },
    staleTime: () =>
      queryClient.getQueryData<LibrarySource>(librarySourceKey(origin.userId))?.origin === 'cache'
        ? SAVED_COPY_STALE_MS
        : SERVER_ANSWER_STALE_MS,
    // Coming back online must replace a saved copy straight away, however recent it is.
    refetchOnReconnect: 'always',
  });
}

/** Where the library on screen came from, or null before the first answer. Reactive. */
export function useLibrarySource(): LibrarySource | null {
  const { userId } = useSession();
  const source = useQuery<LibrarySource>({
    queryKey: librarySourceKey(userId),
    queryFn: skipToken, // set by `useMoviesQuery`; this observer only listens
  });
  return source.data ?? null;
}

/**
 * What the signed-in person may do RIGHT NOW. On a real account, a change made while the server
 * cannot be reached is kept on this device and sent later, so the saved copy does not stop it. On
 * sample data nothing is kept on the device, so there writes stay online-only. Either way the
 * server remains the authority on role; this only avoids offering actions that cannot succeed.
 */
export function useWriteAccess() {
  const session = useSession();
  const source = useLibrarySource();
  const queueing = useQueueing().available;
  const savedCopy = source?.origin === 'cache';
  return {
    /** The saved copy is on screen. */
    savedCopy,
    /** Allowed by role AND possible right now (a change is queued if the server cannot be reached). */
    can: (action: Parameters<typeof can>[1]) =>
      can(session.role, action) && (queueing || !savedCopy),
    /** Allowed by role, whether or not the server is reachable. */
    roleAllows: (action: Parameters<typeof can>[1]) => can(session.role, action),
  };
}

/** True while the library on screen is the copy saved on this device, i.e. the server was unreachable. */
function onSavedCopy(queryClient: QueryClient, userId: string): boolean {
  return queryClient.getQueryData<LibrarySource>(librarySourceKey(userId))?.origin === 'cache';
}

/**
 * Applies a successful write to the cached library WITHOUT ever treating a partial list as the
 * whole library:
 *  - A list request that started before this write may still be in flight. Its snapshot cannot
 *    contain the write, so it is cancelled rather than allowed to overwrite the cache with it.
 *  - If nothing is cached yet (for example the dialog was opened by a deep link before the first
 *    list arrived), the cache is left EMPTY, never seeded with just the one changed title.
 *  - In every case the library is then refetched, so the server stays the source of truth.
 */
async function reconcileLibrary(
  queryClient: QueryClient,
  { queryKey, isCurrent }: Origin,
  change: (cached: readonly Movie[]) => readonly Movie[],
): Promise<void> {
  if (!isCurrent()) return;
  await queryClient.cancelQueries({ queryKey });
  // The account may have changed while cancelling; writing now would resurrect its data.
  if (!isCurrent()) return;
  const cached = queryClient.getQueryData<readonly Movie[]>(queryKey);
  if (cached) queryClient.setQueryData<readonly Movie[]>(queryKey, change(cached));
  void queryClient.invalidateQueries({ queryKey });
}

/**
 * Mutations must resolve to a Result, never throw, so every caller handles the failure state.
 * They are also bound to the account that started them:
 *  - if that account is no longer signed in, the request is not even sent;
 *  - if the account changes while it is in flight, its outcome is replaced by `session_changed`,
 *    which callers treat as "stop silently". (The write itself may have reached the server; it
 *    belongs to the account that made it and will be there when that account next loads.)
 */
async function guarded<T>(origin: Origin, run: () => Promise<Result<T>>): Promise<Result<T>> {
  if (!origin.isCurrent()) return sessionChanged();
  let result: Result<T>;
  try {
    result = await run();
  } catch (cause) {
    result = err('unknown', 'Something went wrong. Please try again.', cause);
  }
  return origin.isCurrent() ? result : sessionChanged();
}

/**
 * A write the server refused as forbidden usually means this account's role changed after it was
 * loaded (for example an owner was demoted). The database was right to refuse; the screen should
 * learn the new role now rather than at the next reload. Fail-closed: a failed re-read is a viewer.
 */
function relearnRoleIfRefused<T>(queryClient: QueryClient, origin: Origin, result: Result<T>) {
  if (!result.ok && result.error.code === 'forbidden' && origin.isCurrent()) {
    void queryClient.invalidateQueries({ queryKey: privateKey(origin.userId, 'profile') });
  }
}

export function useCreateMovie() {
  const repository = useMovieRepository();
  const origin = useOrigin();
  const queryClient = useQueryClient();
  const queue = useQueueing();
  return useMutation({
    mutationFn: (input: MovieInputValues) =>
      guarded(origin, async () => {
        // The id is chosen here, before anything is sent. If the reply is lost and the change is
        // then queued and sent again, the SAME id makes the repeat harmless: never two copies.
        const id = crypto.randomUUID();
        if (queue.available && onSavedCopy(queryClient, origin.userId)) {
          return queue.create(id, input);
        }
        const result = await repository.create(input, { id });
        if (!result.ok && result.error.code === 'network' && queue.available) {
          return queue.create(id, input);
        }
        return result;
      }),
    onSuccess: async (result) => {
      relearnRoleIfRefused(queryClient, origin, result);
      if (!result.ok || result.queued) return; // a queued title is shown from the waiting list, never written into the loaded one
      const created = result.value;
      await reconcileLibrary(queryClient, origin, (list) =>
        list.some((movie) => movie.id === created.id) ? list : [...list, created],
      );
    },
  });
}

interface UpdateVariables {
  readonly id: string;
  readonly input: MovieInputValues;
  /** The version the user was looking at when they started editing. Never the live cache value. */
  readonly expectedUpdatedAt: string;
}

export function useUpdateMovie() {
  const repository = useMovieRepository();
  const origin = useOrigin();
  const queryClient = useQueryClient();
  const queue = useQueueing();
  return useMutation({
    mutationFn: ({ id, input, expectedUpdatedAt }: UpdateVariables) =>
      guarded(origin, async () => {
        // A title that already has a waiting change keeps going through the queue, so the two
        // can never reach the server in the wrong order.
        if (
          queue.available &&
          (onSavedCopy(queryClient, origin.userId) || (await queue.hasEntry(id)))
        ) {
          return queue.update(id, input, expectedUpdatedAt);
        }
        const result = await repository.update(id, input, expectedUpdatedAt);
        if (!result.ok && result.error.code === 'network' && queue.available) {
          return queue.update(id, input, expectedUpdatedAt);
        }
        return result;
      }),
    onSuccess: async (result) => {
      relearnRoleIfRefused(queryClient, origin, result);
      if (result.ok && result.queued) return;
      if (result.ok) {
        const updated = result.value;
        await reconcileLibrary(queryClient, origin, (list) =>
          list.map((movie) => (movie.id === updated.id ? updated : movie)),
        );
      } else if (result.error.code === 'conflict' || result.error.code === 'not_found') {
        void queryClient.invalidateQueries({ queryKey: origin.queryKey });
      }
    },
  });
}

interface RemoveVariables {
  readonly id: string;
  readonly expectedUpdatedAt: string;
}

export function useRemoveMovie() {
  const repository = useMovieRepository();
  const origin = useOrigin();
  const queryClient = useQueryClient();
  const queue = useQueueing();
  return useMutation({
    mutationFn: ({ id, expectedUpdatedAt }: RemoveVariables) =>
      guarded(origin, async (): Promise<Result<void>> => {
        if (
          queue.available &&
          (onSavedCopy(queryClient, origin.userId) || (await queue.hasEntry(id)))
        ) {
          return queue.remove(id, expectedUpdatedAt);
        }
        const result = await repository.remove(id, expectedUpdatedAt);
        if (!result.ok && result.error.code === 'network' && queue.available) {
          return queue.remove(id, expectedUpdatedAt);
        }
        return result;
      }),
    onSuccess: async (result, { id }) => {
      relearnRoleIfRefused(queryClient, origin, result);
      if (result.ok && result.queued) return;
      if (result.ok) {
        await reconcileLibrary(queryClient, origin, (list) =>
          list.filter((movie) => movie.id !== id),
        );
      } else if (result.error.code === 'conflict' || result.error.code === 'not_found') {
        void queryClient.invalidateQueries({ queryKey: origin.queryKey });
      }
    },
  });
}
