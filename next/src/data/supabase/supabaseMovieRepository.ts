import type { SupabaseClient } from '@supabase/supabase-js';
import { MOVIE_COLUMNS, inputToColumns, rowToMovie } from '@/data/mappers/movieMapper';
import {
  CREATE_MANY_MAX,
  type CreateManyOutcome,
  type MovieRepository,
} from '@/data/repositories/movieRepository';
import { comparableTitle, normalizeTitle } from '@/domain/identity';
import type { Movie } from '@/domain/movie';
import { can, type Role } from '@/domain/permissions';
import { conflict, err, ok, type AppError, type Result } from '@/domain/result';
import { movieInputSchema, type MovieInputValues } from '@/domain/validation';
import { mapDbError, networkError, type DbError } from './dbErrors';

export interface SupabaseMovieRepositoryOptions {
  readonly client: SupabaseClient;
  /** The signed-in account this repository belongs to. One repository per account, never shared. */
  readonly userId: string;
  /** Read on every call; a viewer's write is refused here AND by row-level security. */
  readonly getRole: () => Role;
  readonly now?: () => Date;
  /** Rows per request when listing. The server may return fewer; paging continues until empty. */
  readonly pageSize?: number;
}

/** Guard against a runaway loop: 500 pages is far beyond any realistic personal library. */
const MAX_PAGES = 500;
const STALE = 'This title was changed somewhere else since you opened it.';

interface Reply<T> {
  readonly data: T | null;
  readonly error: DbError | null;
  readonly status: number;
}

const fail = (error: DbError, status: number): Result<never> => ({
  ok: false,
  error: mapDbError(error, status),
});

/**
 * Supabase implementation of the MovieRepository contract. The rules are the SAME as the mock's
 * (that is what the contract tests assert) and are enforced twice: here, for a good error message
 * and no wasted request, and by Postgres row-level security, which is the real control.
 *
 *  - list: keyset-paginated by id, so a library larger than the server's row cap is read completely.
 *    The guarantee is exactly this: a row that exists for the whole listing appears exactly once
 *    (ids are immutable and ordered, so a write cannot move it across the cursor). It is NOT a
 *    snapshot: a row added behind the cursor mid-listing is missed, one added ahead of it is seen,
 *    and a row deleted before its page is read is absent. The next refetch reconciles.
 *  - update/remove: the WHERE clause itself carries the expected `updated_at`, so the version check
 *    and the write are ONE atomic statement. Zero rows is then diagnosed (stale / deleted / refused).
 *  - remove: a soft delete (tombstone), never a DELETE, so other devices see it.
 *  - a row that cannot be read fails the whole list loudly instead of being silently omitted.
 */
export function createSupabaseMovieRepository(
  options: SupabaseMovieRepositoryOptions,
): MovieRepository {
  const { client, userId, getRole } = options;
  const now = options.now ?? ((): Date => new Date());
  const pageSize = options.pageSize ?? 1_000;

  const run = async <T>(operation: () => PromiseLike<Reply<T>>): Promise<Result<T | null>> => {
    try {
      const { data, error, status } = await operation();
      return error ? fail(error, status) : ok(data);
    } catch (cause) {
      return { ok: false, error: networkError(cause) };
    }
  };

  const forbidden = (verb: string): Result<never> =>
    err('forbidden', `Your account is view-only, so you can’t ${verb} titles.`);

  const parse = (input: MovieInputValues): Result<MovieInputValues> => {
    const parsed = movieInputSchema.safeParse(input);
    if (parsed.success) return ok(parsed.data);
    return err('validation', parsed.error.issues[0]?.message ?? 'Check the highlighted fields.');
  };

  const readMovie = (raw: unknown): Result<Movie> => {
    try {
      return ok(rowToMovie(raw));
    } catch (cause) {
      return err('unknown', 'A record could not be read, so nothing was changed.', cause);
    }
  };

  /**
   * The database index treats two year-less titles as distinct, so this check is the only guard
   * for them (finding F2); for dated titles it also yields a friendlier message than the index.
   */
  const findDuplicate = async (
    input: MovieInputValues,
    ignoreId: string | null,
  ): Promise<Result<string | null>> => {
    // Candidates are fetched by media type and year and compared in code, because stored
    // `normalized_title` values come in two spellings (see comparableTitle, finding F9). Every
    // candidate is examined: pages are read until one comes back short, so a duplicate can never
    // hide behind a row cap. The database index remains the final authority for exact matches.
    const wanted = comparableTitle(normalizeTitle(input.title));
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const lastId: string | null = after;
      const reply = await run<{ id: string; title: string; normalized_title: string }[]>(() => {
        let query = client
          .from('movies')
          .select('id, title, normalized_title')
          .eq('owner_id', userId)
          .eq('media_type', input.mediaType)
          .is('deleted_at', null)
          .order('id', { ascending: true });
        query = input.year === null ? query.is('year', null) : query.eq('year', input.year);
        if (ignoreId !== null) query = query.neq('id', ignoreId);
        if (lastId !== null) query = query.gt('id', lastId);
        return query.limit(pageSize);
      });
      if (!reply.ok) return reply;
      const batch = reply.value ?? [];
      const hit = batch.find((row) => comparableTitle(row.normalized_title) === wanted);
      if (hit) return ok(hit.title);
      const last = batch[batch.length - 1];
      if (batch.length < pageSize || last === undefined) return ok(null);
      after = last.id;
    }
    return err('unknown', 'The library is too large to check for duplicates safely.');
  };

  const duplicate = (title: string): Result<never> =>
    conflict('duplicate_identity', `“${title}” is already in your library.`);

  /** A guarded write touched no row: say why, instead of guessing. */
  const diagnose = async (id: string, expectedUpdatedAt: string): Promise<AppError> => {
    const reply = await run<{ updated_at: string; deleted_at: string | null }>(() =>
      client.from('movies').select('updated_at, deleted_at').eq('id', id).maybeSingle(),
    );
    if (!reply.ok) return reply.error;
    const row = reply.value;
    if (row?.deleted_at !== null) return { code: 'not_found', message: 'Title not found.' };
    if (row.updated_at !== expectedUpdatedAt) {
      return { code: 'conflict', reason: 'stale_version', message: STALE };
    }
    // Visible, unchanged and still refused: row-level security said no.
    return { code: 'forbidden', message: 'Your account isn’t allowed to make this change.' };
  };

  const duplicateError = (title: string): AppError => ({
    code: 'conflict',
    reason: 'duplicate_identity',
    message: `“${title}” is already in your library.`,
  });

  /** Identity keys of every live title, read page by page (no row cap can hide a duplicate). */
  const listIdentities = async (): Promise<Result<Set<string>>> => {
    const keys = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const lastId: string | null = after;
      const reply = await run<
        { id: string; normalized_title: string; media_type: string; year: number | null }[]
      >(() => {
        let query = client
          .from('movies')
          .select('id, normalized_title, media_type, year')
          .eq('owner_id', userId)
          .is('deleted_at', null)
          .order('id', { ascending: true })
          .limit(pageSize);
        if (lastId !== null) query = query.gt('id', lastId);
        return query;
      });
      if (!reply.ok) return reply;
      const batch = reply.value ?? [];
      for (const row of batch) {
        keys.add(
          `${row.media_type}|${comparableTitle(row.normalized_title)}|${row.year === null ? '' : String(row.year)}`,
        );
      }
      const last = batch[batch.length - 1];
      if (batch.length < pageSize || last === undefined) return ok(keys);
      after = last.id;
    }
    return err('unknown', 'The library is too large to check for duplicates safely.');
  };

  const createOne = async (input: MovieInputValues, id?: string): Promise<Result<Movie>> => {
    if (!can(getRole(), 'movie:create')) return forbidden('add');
    const parsed = parse(input);
    if (!parsed.ok) return parsed;
    const existing = await findDuplicate(parsed.value, null);
    if (!existing.ok) return existing;
    if (existing.value !== null) return duplicate(existing.value);

    const reply = await run<Record<string, unknown>>(() =>
      client
        .from('movies')
        .insert({
          ...(id === undefined ? {} : { id }),
          owner_id: userId,
          ...inputToColumns(parsed.value),
        })
        .select(MOVIE_COLUMNS)
        .single(),
    );
    if (!reply.ok) return reply;
    return reply.value === null
      ? err('unknown', 'The server did not return the saved title.')
      : readMovie(reply.value);
  };

  return {
    async list() {
      const rows: unknown[] = [];
      let after: string | null = null;
      for (let page = 0; ; page += 1) {
        if (page >= MAX_PAGES) return err('unknown', 'The library is too large to load safely.');
        const lastId: string | null = after;
        const reply = await run<Record<string, unknown>[]>(() => {
          let query = client
            .from('movies')
            .select(MOVIE_COLUMNS)
            .is('deleted_at', null)
            .order('id', { ascending: true })
            .limit(pageSize);
          if (lastId !== null) query = query.gt('id', lastId);
          return query;
        });
        if (!reply.ok) return reply;
        const batch = reply.value ?? [];
        if (batch.length === 0) break;
        rows.push(...batch);
        const last = batch[batch.length - 1];
        const lastValue = last?.id;
        if (typeof lastValue !== 'string')
          return err('unknown', 'Unexpected response from the server.');
        after = lastValue;
      }

      const movies: Movie[] = [];
      const unreadable: string[] = [];
      const seen = new Set<string>();
      for (const raw of rows) {
        const movie = readMovie(raw);
        if (!movie.ok) {
          unreadable.push(String((raw as { id?: unknown }).id));
        } else if (!seen.has(movie.value.id)) {
          seen.add(movie.value.id);
          movies.push(movie.value);
        }
      }
      if (unreadable.length > 0) {
        return err(
          'unknown',
          `${String(unreadable.length)} records could not be read, so nothing was shown to avoid hiding data.`,
          { unreadable },
        );
      }
      return ok(movies);
    },

    async get(id) {
      const reply = await run<Record<string, unknown>>(() =>
        client
          .from('movies')
          .select(MOVIE_COLUMNS)
          .eq('id', id)
          .is('deleted_at', null)
          .maybeSingle(),
      );
      if (!reply.ok) return reply;
      if (reply.value === null) return err('not_found', 'Title not found.');
      return readMovie(reply.value);
    },

    create: (input, createOptions) => createOne(input, createOptions?.id),

    async createMany(inputs) {
      if (!can(getRole(), 'movie:create')) return forbidden('add');
      if (inputs.length > CREATE_MANY_MAX) {
        return err('validation', `Add at most ${String(CREATE_MANY_MAX)} titles at a time.`);
      }
      const skipped: { index: number; error: AppError }[] = [];
      const accepted: { index: number; input: MovieInputValues }[] = [];
      inputs.forEach((raw, index) => {
        const parsed = parse(raw);
        if (parsed.ok) accepted.push({ index, input: parsed.value });
        else skipped.push({ index, error: parsed.error });
      });
      if (accepted.length === 0) return ok({ created: [], skipped });

      // One read of every live identity, then every row is compared in code (finding F9: the stored
      // spellings differ, so the database cannot do this comparison itself).
      const known = await listIdentities();
      if (!known.ok) return known;
      const fresh: { index: number; input: MovieInputValues }[] = [];
      const inBatch = new Set<string>();
      for (const row of accepted) {
        const key = `${row.input.mediaType}|${comparableTitle(normalizeTitle(row.input.title))}|${row.input.year === null ? '' : String(row.input.year)}`;
        if (known.value.has(key) || inBatch.has(key)) {
          skipped.push({ index: row.index, error: duplicateError(row.input.title) });
        } else {
          inBatch.add(key);
          fresh.push(row);
        }
      }
      if (fresh.length === 0) return ok({ created: [], skipped });

      const reply = await run<Record<string, unknown>[]>(() =>
        client
          .from('movies')
          .insert(fresh.map((row) => ({ owner_id: userId, ...inputToColumns(row.input) })))
          .select(MOVIE_COLUMNS),
      );
      if (reply.ok) {
        const created: Movie[] = [];
        for (const raw of reply.value ?? []) {
          const movie = readMovie(raw);
          if (!movie.ok) return movie;
          created.push(movie.value);
        }
        return ok<CreateManyOutcome>({ created, skipped });
      }
      // Someone else added one of these between our read and our insert (the database index
      // refused the whole statement, so nothing was saved). Settle it row by row instead.
      if (reply.error.code !== 'conflict') return reply;
      const created: Movie[] = [];
      for (const row of fresh) {
        const one = await createOne(row.input);
        if (one.ok) created.push(one.value);
        else if (one.error.code === 'conflict')
          skipped.push({ index: row.index, error: one.error });
        else return one;
      }
      return ok<CreateManyOutcome>({ created, skipped });
    },

    async update(id, input, expectedUpdatedAt) {
      if (!can(getRole(), 'movie:update')) return forbidden('edit');
      const parsed = parse(input);
      if (!parsed.ok) return parsed;
      const existing = await findDuplicate(parsed.value, id);
      if (!existing.ok) return existing;
      if (existing.value !== null) return duplicate(existing.value);

      // A title that did not change keeps its stored identity: imported rows use a different
      // spelling of normalized_title and must not be silently rewritten by an unrelated edit (F9).
      // The guarded update below still fails if the row changes after this read.
      const before = await run<{ title: string } | null>(() =>
        client.from('movies').select('title').eq('id', id).is('deleted_at', null).maybeSingle(),
      );
      if (!before.ok) return before;
      const { normalized_title: renamed, ...unchanged } = inputToColumns(parsed.value);
      const columns =
        before.value?.title === parsed.value.title
          ? unchanged
          : { ...unchanged, normalized_title: renamed };

      const reply = await run<Record<string, unknown>[]>(() =>
        client
          .from('movies')
          .update(columns)
          .eq('id', id)
          .eq('updated_at', expectedUpdatedAt)
          .is('deleted_at', null)
          .select(MOVIE_COLUMNS),
      );
      if (!reply.ok) return reply;
      const row = reply.value?.[0];
      if (row) return readMovie(row);
      return { ok: false, error: await diagnose(id, expectedUpdatedAt) };
    },

    async remove(id, expectedUpdatedAt) {
      if (!can(getRole(), 'movie:delete')) return forbidden('delete');
      const reply = await run<{ id: string }[]>(() =>
        client
          .from('movies')
          .update({ deleted_at: now().toISOString() })
          .eq('id', id)
          .eq('updated_at', expectedUpdatedAt)
          .is('deleted_at', null)
          .select('id'),
      );
      if (!reply.ok) return reply;
      if ((reply.value?.length ?? 0) > 0) return ok(undefined);
      return { ok: false, error: await diagnose(id, expectedUpdatedAt) };
    },
  };
}
