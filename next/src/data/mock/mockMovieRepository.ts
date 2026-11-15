import { normalizeTitle, isSameIdentity } from '@/domain/identity';
import type { Movie } from '@/domain/movie';
import { can, type Role } from '@/domain/permissions';
import { conflict, err, ok, type AppError, type Result } from '@/domain/result';
import { movieInputSchema, type MovieInputValues } from '@/domain/validation';
import {
  CREATE_MANY_MAX,
  type CreateManyOutcome,
  type MovieRepository,
} from '@/data/repositories/movieRepository';
import { MOCK_OWNER_ID, createSeedMovies } from './fixtures';

export interface MockRepositoryOptions {
  readonly seed?: readonly Movie[];
  /** Read on every call so switching role in the UI takes effect immediately. */
  readonly getRole?: () => Role;
  readonly ownerId?: string;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Artificial delay so loading states are visible in demos. */
  readonly latencyMs?: number;
  /** Demo hook: every call fails with this error (used by the `?scenario=error` preview). */
  readonly alwaysFail?: AppError;
}

export type HoldableMethod = 'list' | 'create' | 'createMany' | 'update' | 'remove';

export interface MockMovieRepository extends MovieRepository {
  /** Demo/test hook: the next call, whichever method, fails with this error. */
  failNext(error: AppError): void;
  /**
   * Test hook: the next `list()` takes its snapshot immediately but does not RETURN it until the
   * returned function is called. Models a slow request that started before a later write.
   */
  holdNextList(): () => void;
  /**
   * Test hook: the next call to `method` APPLIES its effect immediately (the write is committed)
   * but its response is not delivered until the returned function is called. Models a slow
   * request whose outcome arrives after the user has moved on.
   */
  holdNext(method: HoldableMethod): () => void;
  /** Demo/test hook: pretend another device changed a record. Returns the new version. */
  simulateRemoteEdit(
    id: string,
    patch: Partial<MovieInputValues> & { readonly normalizedTitle?: string },
  ): Movie;
  /** Everything stored, tombstones included. */
  snapshot(): readonly Movie[];
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * In-memory implementation of the MovieRepository contract. It enforces the SAME rules the real
 * one must (blueprint section 4) so the UI is built against real failure modes, not a happy path:
 *   - viewers cannot write (forbidden)
 *   - input is re-validated with the shared schema (validation)
 *   - duplicate identity among LIVE titles is rejected (conflict / duplicate_identity)
 *   - updates and deletes are version-checked (conflict / stale_version)
 *   - delete is a soft delete, and a tombstone frees the identity for re-use
 * It never touches the network, Supabase or any browser storage.
 */
export function createMockMovieRepository(
  options: MockRepositoryOptions = {},
): MockMovieRepository {
  const ownerId = options.ownerId ?? MOCK_OWNER_ID;
  const getRole = options.getRole ?? ((): Role => 'owner');
  const now = options.now ?? ((): Date => new Date());
  const newId = options.newId ?? ((): string => crypto.randomUUID());
  const latencyMs = options.latencyMs ?? 0;

  const store = new Map<string, Movie>();
  for (const movie of options.seed ?? createSeedMovies(ownerId)) store.set(movie.id, movie);

  let pendingFailure: AppError | null = null;
  const gates = new Map<HoldableMethod, Promise<void>>();

  /** Waits on a hold placed with `holdNext`, if any, after the effect has been applied. */
  const settle = async <T>(method: HoldableMethod, result: T): Promise<T> => {
    const gate = gates.get(method);
    if (gate) {
      gates.delete(method);
      await gate;
    }
    return result;
  };

  /** Strictly increasing per record, even if the clock does not advance between two writes. */
  const nextTimestamp = (previous: string | null): string => {
    const current = now().getTime();
    const floor = previous === null ? current : Math.max(current, Date.parse(previous) + 1);
    return new Date(floor).toISOString();
  };

  const live = (): Movie[] => [...store.values()].filter((m) => m.deletedAt === null);

  const duplicateOf = (input: MovieInputValues, ignoreId: string | null): Movie | undefined => {
    const candidate = {
      normalizedTitle: normalizeTitle(input.title),
      mediaType: input.mediaType,
      year: input.year,
    };
    return live().find((m) => m.id !== ignoreId && isSameIdentity(m, candidate));
  };

  /** Runs the shared preamble: latency, injected failure. Returns the failure to short-circuit. */
  const begin = async (): Promise<Result<never> | null> => {
    await sleep(latencyMs);
    if (options.alwaysFail) return { ok: false, error: options.alwaysFail };
    if (pendingFailure) {
      const error = pendingFailure;
      pendingFailure = null;
      return { ok: false, error };
    }
    return null;
  };

  const forbidden = (verb: string): Result<never> =>
    err('forbidden', `Your account is view-only, so you can’t ${verb} titles.`);

  const parse = (input: MovieInputValues): Result<MovieInputValues> => {
    const parsed = movieInputSchema.safeParse(input);
    if (parsed.success) return ok(parsed.data);
    return err('validation', parsed.error.issues[0]?.message ?? 'Check the highlighted fields.');
  };

  const duplicateError = (existing: Movie): Result<never> =>
    conflict('duplicate_identity', `“${existing.title}” is already in your library.`);

  const holdNext = (method: HoldableMethod): (() => void) => {
    let release: () => void = () => undefined;
    gates.set(
      method,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return release;
  };

  return {
    async list() {
      const failure = await begin();
      if (failure) return failure;
      const snapshot = live(); // taken now, even if the response is held back
      return settle('list', ok(snapshot));
    },

    async get(id) {
      const failure = await begin();
      if (failure) return failure;
      const movie = store.get(id);
      return movie?.deletedAt === null ? ok(movie) : err('not_found', 'Title not found.');
    },

    async create(input, createOptions) {
      const failure = await begin();
      if (failure) return failure;
      if (!can(getRole(), 'movie:create')) return forbidden('add');
      const parsed = parse(input);
      if (!parsed.ok) return parsed;
      const existing = duplicateOf(parsed.value, null);
      if (existing) return duplicateError(existing);
      // Like the database's primary key: an id that exists (even as a tombstone) is never reused.
      if (createOptions?.id !== undefined && store.has(createOptions.id)) {
        return conflict('duplicate_identity', 'A title with this id already exists.');
      }
      const stamp = nextTimestamp(null);
      const movie: Movie = {
        ...parsed.value,
        id: createOptions?.id ?? newId(),
        ownerId,
        normalizedTitle: normalizeTitle(parsed.value.title),
        createdAt: stamp,
        updatedAt: stamp,
        deletedAt: null,
      };
      store.set(movie.id, movie);
      return settle('create', ok(movie));
    },

    async createMany(inputs) {
      const failure = await begin();
      if (failure) return failure;
      if (!can(getRole(), 'movie:create')) return forbidden('add');
      if (inputs.length > CREATE_MANY_MAX) {
        return err('validation', `Add at most ${String(CREATE_MANY_MAX)} titles at a time.`);
      }
      const created: Movie[] = [];
      const skipped: { index: number; error: AppError }[] = [];
      inputs.forEach((input, index) => {
        const parsed = parse(input);
        if (!parsed.ok) {
          skipped.push({ index, error: parsed.error });
          return;
        }
        const existing = duplicateOf(parsed.value, null);
        if (existing) {
          skipped.push({
            index,
            error: {
              code: 'conflict',
              reason: 'duplicate_identity',
              message: `“${existing.title}” is already in your library.`,
            },
          });
          return;
        }
        const stamp = nextTimestamp(null);
        const movie: Movie = {
          ...parsed.value,
          id: newId(),
          ownerId,
          normalizedTitle: normalizeTitle(parsed.value.title),
          createdAt: stamp,
          updatedAt: stamp,
          deletedAt: null,
        };
        store.set(movie.id, movie);
        created.push(movie);
      });
      const outcome: CreateManyOutcome = { created, skipped };
      return settle('createMany', ok(outcome));
    },

    async update(id, input, expectedUpdatedAt) {
      const failure = await begin();
      if (failure) return failure;
      if (!can(getRole(), 'movie:update')) return forbidden('edit');
      const current = store.get(id);
      if (current?.deletedAt !== null) return err('not_found', 'Title not found.');
      if (current.updatedAt !== expectedUpdatedAt) {
        return conflict(
          'stale_version',
          'This title was changed somewhere else since you opened it.',
        );
      }
      const parsed = parse(input);
      if (!parsed.ok) return parsed;
      const existing = duplicateOf(parsed.value, id);
      if (existing) return duplicateError(existing);
      const next: Movie = {
        ...current,
        ...parsed.value,
        // An unchanged title keeps its stored identity (imported rows use another spelling, F9).
        normalizedTitle:
          parsed.value.title === current.title
            ? current.normalizedTitle
            : normalizeTitle(parsed.value.title),
        updatedAt: nextTimestamp(current.updatedAt),
      };
      store.set(id, next);
      return settle('update', ok(next));
    },

    async remove(id, expectedUpdatedAt) {
      const failure = await begin();
      if (failure) return failure;
      if (!can(getRole(), 'movie:delete')) return forbidden('delete');
      const current = store.get(id);
      if (current?.deletedAt !== null) return err('not_found', 'Title not found.');
      if (current.updatedAt !== expectedUpdatedAt) {
        return conflict(
          'stale_version',
          'This title was changed somewhere else since you opened it.',
        );
      }
      const stamp = nextTimestamp(current.updatedAt);
      store.set(id, { ...current, deletedAt: stamp, updatedAt: stamp });
      return settle('remove', ok(undefined));
    },

    holdNext,

    holdNextList() {
      return holdNext('list');
    },

    failNext(error) {
      pendingFailure = error;
    },

    simulateRemoteEdit(id, patch) {
      const current = store.get(id);
      if (!current) throw new Error(`simulateRemoteEdit: unknown id ${id}`);
      const next: Movie = {
        ...current,
        ...patch,
        normalizedTitle: patch.normalizedTitle ?? normalizeTitle(patch.title ?? current.title),
        updatedAt: nextTimestamp(current.updatedAt),
      };
      store.set(id, next);
      return next;
    },

    snapshot() {
      return [...store.values()];
    },
  };
}
