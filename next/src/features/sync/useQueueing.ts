import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { moviesKey, outboxKey } from '@/app/privateKey';
import { useRuntime } from '@/app/runtime';
import { useSession } from '@/app/session';
import type { Movie } from '@/domain/movie';
import {
  applyOutbox,
  findDuplicateIn,
  movieFromInput,
  type OutboxEntry,
  type QueueOp,
} from '@/domain/outbox';
import { can } from '@/domain/permissions';
import { err, sessionChanged, type Result } from '@/domain/result';
import { movieInputSchema, type MovieInputValues } from '@/domain/validation';
import { useSync } from './syncContext';

const queued = <T>(value: T): Result<T> => ({ ok: true, value, queued: true });

/**
 * Keeps a change on this device when the server cannot be reached, to be sent later (see
 * data/sync/flushOutbox). Every rule the repository applies to a write is applied here too, against
 * what is on screen, so a change that is certain to be refused is refused now rather than hours
 * later; the server still has the last word when the change is sent.
 *
 * `available` is false on sample data, where nothing is kept on the device and writes stay online-only.
 */
export function useQueueing() {
  const { outbox } = useRuntime();
  const session = useSession();
  const queryClient = useQueryClient();
  const sync = useSync();
  const { userId, isCurrent, getRole } = session;

  return useMemo(() => {
    const entriesNow = async (): Promise<readonly OutboxEntry[]> =>
      outbox ? outbox.list(userId) : [];

    /** The library as the person sees it: the loaded list with waiting changes laid over it. */
    const libraryNow = async (): Promise<readonly Movie[]> =>
      applyOutbox(
        queryClient.getQueryData<readonly Movie[]>(moviesKey(userId)) ?? [],
        await entriesNow(),
        userId,
      );

    const commit = async (op: QueueOp): Promise<Result<undefined>> => {
      if (!outbox) return err('network', 'Couldn’t reach the server. Check your connection.');
      const result = await outbox.enqueue(userId, op, new Date());
      if (!isCurrent()) return sessionChanged();
      if (!result.ok) {
        if (result.reason === 'blocked_needs_attention') {
          return err(
            'conflict',
            'This title has a change that needs your review. Open “Sync issues” and decide about it first.',
          );
        }
        if (result.reason === 'blocked_deleted') return err('not_found', 'Title not found.');
        return err(
          'network',
          'Couldn’t reach the server, and this device couldn’t keep the change either. Nothing was saved.',
        );
      }
      queryClient.setQueryData(outboxKey(userId), await outbox.list(userId));
      sync.requestFlush();
      return { ok: true, value: undefined };
    };

    const checked = (
      action: 'movie:create' | 'movie:update' | 'movie:delete',
      verb: string,
    ): Result<undefined> =>
      can(getRole(), action)
        ? { ok: true, value: undefined }
        : err('forbidden', `Your account is view-only, so you can’t ${verb} titles.`);

    const validated = (input: MovieInputValues): Result<MovieInputValues> => {
      const parsed = movieInputSchema.safeParse(input);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : err('validation', parsed.error.issues[0]?.message ?? 'Check the highlighted fields.');
    };

    return {
      available: outbox !== null,

      hasEntry: async (movieId: string): Promise<boolean> =>
        (await entriesNow()).some((entry) => entry.movieId === movieId),

      async create(movieId: string, input: MovieInputValues): Promise<Result<Movie>> {
        const allowed = checked('movie:create', 'add');
        if (!allowed.ok) return allowed;
        const parsed = validated(input);
        if (!parsed.ok) return parsed;
        const twin = findDuplicateIn(await libraryNow(), parsed.value, null);
        if (twin) {
          return {
            ok: false,
            error: {
              code: 'conflict',
              reason: 'duplicate_identity',
              message: `“${twin.title}” is already in your library.`,
            },
          };
        }
        const done = await commit({ kind: 'create', movieId, input: parsed.value });
        if (!done.ok) return done;
        return queued(movieFromInput(parsed.value, movieId, userId, new Date().toISOString()));
      },

      async update(
        movieId: string,
        input: MovieInputValues,
        baseUpdatedAt: string,
      ): Promise<Result<Movie>> {
        const allowed = checked('movie:update', 'edit');
        if (!allowed.ok) return allowed;
        const parsed = validated(input);
        if (!parsed.ok) return parsed;
        const library = await libraryNow();
        const twin = findDuplicateIn(library, parsed.value, movieId);
        if (twin) {
          return {
            ok: false,
            error: {
              code: 'conflict',
              reason: 'duplicate_identity',
              message: `“${twin.title}” is already in your library.`,
            },
          };
        }
        const done = await commit({
          kind: 'update',
          movieId,
          input: parsed.value,
          baseUpdatedAt,
        });
        if (!done.ok) return done;
        const current = library.find((movie) => movie.id === movieId);
        return queued(
          current
            ? { ...current, ...parsed.value }
            : movieFromInput(parsed.value, movieId, userId, new Date().toISOString()),
        );
      },

      async remove(movieId: string, baseUpdatedAt: string): Promise<Result<undefined>> {
        const allowed = checked('movie:delete', 'delete');
        if (!allowed.ok) return allowed;
        const title =
          (await libraryNow()).find((movie) => movie.id === movieId)?.title ?? 'this title';
        const done = await commit({ kind: 'delete', movieId, baseUpdatedAt, title });
        return done.ok ? queued(undefined) : done;
      },
    };
  }, [outbox, userId, isCurrent, getRole, queryClient, sync]);
}
