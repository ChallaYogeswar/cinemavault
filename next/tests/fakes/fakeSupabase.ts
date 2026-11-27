import type { SupabaseClient } from '@supabase/supabase-js';
import { movieToRow, type MovieRow } from '@/data/mappers/movieMapper';
import type { Movie } from '@/domain/movie';

/**
 * A small PostgREST emulator for the query shapes the repositories use, with the database
 * behaviour that matters for correctness: the unique identity index (NULL years are distinct,
 * tombstones excluded), check constraints, an `updated_at` trigger with MICROSECOND precision,
 * a row cap on every response, and row-level security that silently hides rows from writes and
 * rejects inserts. It proves the repository's LOGIC; the real database is exercised separately
 * (RLS in PGlite, the full flow on a development project).
 */
type Filter =
  | { readonly op: 'eq' | 'neq' | 'gt'; readonly column: string; readonly value: unknown }
  | { readonly op: 'is'; readonly column: string; readonly value: null };

export interface LoggedRequest {
  readonly table: string;
  readonly op: 'select' | 'insert' | 'update';
  readonly filters: readonly Filter[];
  readonly payload: unknown;
}

interface DbErrorShape {
  readonly message: string;
  readonly code: string;
}

export interface FakeSupabase {
  readonly client: SupabaseClient;
  readonly requests: LoggedRequest[];
  readonly movies: () => readonly MovieRow[];
  readonly profiles: Map<string, { role: string }>;
  /** Another device changes a row: applies the patch and runs the updated_at trigger. */
  remoteUpdate(id: string, patch: Partial<MovieRow>): void;
  /** A later request answers with this database error (`skip` requests pass first). */
  failNext(error: DbErrorShape, status?: number, skip?: number): void;
  /** The next request rejects like a dropped connection (fetch throws). */
  dropNext(): void;
  setCanWrite(canWrite: boolean): void;
}

export interface FakeSupabaseOptions {
  readonly seed: readonly Movie[];
  /** Rows a single response may contain (PostgREST `max_rows`). */
  readonly rowCap?: number;
  readonly canWrite?: boolean;
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

export function createFakeSupabase(options: FakeSupabaseOptions): FakeSupabase {
  const rowCap = options.rowCap ?? 1_000;
  let canWrite = options.canWrite ?? true;
  let counter = 0;
  const base = Date.parse('2026-10-26T10:00:00.000Z');
  /** Strictly increasing, microsecond-resolution, in PostgREST's output format. */
  const tick = (): string => {
    counter += 1;
    const ms = base + Math.floor(counter / 1_000);
    const micros = counter % 1_000;
    const iso = new Date(ms).toISOString().replace('Z', '');
    return `${iso}${pad(micros, 3)}+00:00`;
  };

  const store: MovieRow[] = options.seed.map((movie) => ({ ...movieToRow(movie) }));
  const profiles = new Map<string, { role: string }>();
  const requests: LoggedRequest[] = [];
  let nextError: { error: DbErrorShape; status: number; skip: number } | null = null;
  let dropNextRequest = false;

  const get = (row: MovieRow, column: string): unknown => (row as Record<string, unknown>)[column];

  const matches = (row: MovieRow, filters: readonly Filter[]): boolean =>
    filters.every((filter) => {
      const value = get(row, filter.column);
      switch (filter.op) {
        case 'eq':
          return value === filter.value;
        case 'neq':
          return value !== filter.value;
        case 'gt':
          return (
            typeof value === 'string' && typeof filter.value === 'string' && value > filter.value
          );
        case 'is':
          return value === null;
      }
    });

  const violation = (row: MovieRow, alsoPresent: readonly MovieRow[] = []): DbErrorShape | null => {
    if (row.title.trim() === '' || row.normalized_title.trim() === '') {
      return {
        code: '23514',
        message: 'new row violates check constraint "movies_title_not_blank"',
      };
    }
    if (row.year !== null && (row.year < 1888 || row.year > 2100)) {
      return { code: '23514', message: 'new row violates check constraint "movies_year_check"' };
    }
    const rating = row.user_rating;
    if (rating !== null && (rating < 0 || rating > 5)) {
      return { code: '23514', message: 'new row violates check constraint "user_rating"' };
    }
    if (!row.watched && row.watched_on !== null) {
      return { code: '23514', message: 'violates "movies_watched_date_consistency"' };
    }
    if (row.deleted_at === null) {
      // NULL years never collide in a Postgres unique index.
      const clash = [...store, ...alsoPresent].some(
        (other) =>
          other.id !== row.id &&
          other.deleted_at === null &&
          other.owner_id === row.owner_id &&
          other.normalized_title === row.normalized_title &&
          other.media_type === row.media_type &&
          other.year !== null &&
          other.year === row.year,
      );
      if (clash) {
        return {
          code: '23505',
          message: 'duplicate key value violates unique constraint "movies_owner_identity_idx"',
        };
      }
    }
    return null;
  };

  interface Reply {
    readonly data: unknown;
    readonly error: DbErrorShape | null;
    readonly status: number;
  }

  class Builder implements PromiseLike<Reply> {
    private op: 'select' | 'insert' | 'update' = 'select';
    private payload: Record<string, unknown> | Record<string, unknown>[] = {};
    private readonly filters: Filter[] = [];
    private orderBy: { column: string; ascending: boolean } | null = null;
    private max: number | null = null;
    private mode: 'many' | 'single' | 'maybe' = 'many';
    private columns: string | null = null;

    constructor(private readonly table: string) {}

    select(columns?: string) {
      this.columns = columns ?? null;
      return this;
    }
    insert(values: Record<string, unknown> | Record<string, unknown>[]) {
      this.op = 'insert';
      this.payload = values;
      return this;
    }
    update(values: Record<string, unknown>) {
      this.op = 'update';
      this.payload = values;
      return this;
    }
    eq(column: string, value: unknown) {
      this.filters.push({ op: 'eq', column, value });
      return this;
    }
    neq(column: string, value: unknown) {
      this.filters.push({ op: 'neq', column, value });
      return this;
    }
    gt(column: string, value: unknown) {
      this.filters.push({ op: 'gt', column, value });
      return this;
    }
    is(column: string, value: null) {
      this.filters.push({ op: 'is', column, value });
      return this;
    }
    order(column: string, opts?: { ascending?: boolean }) {
      this.orderBy = { column, ascending: opts?.ascending ?? true };
      return this;
    }
    limit(count: number) {
      this.max = count;
      return this;
    }
    single() {
      this.mode = 'single';
      return this;
    }
    maybeSingle() {
      this.mode = 'maybe';
      return this;
    }

    then<R1 = Reply, R2 = never>(
      onfulfilled?: ((value: Reply) => R1 | PromiseLike<R1>) | null,
      onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
    ): PromiseLike<R1 | R2> {
      return Promise.resolve()
        .then(() => this.execute())
        .then(onfulfilled, onrejected);
    }

    private shape(rows: readonly MovieRow[]): Reply {
      const cols = this.columns?.split(',').map((c) => c.trim());
      const shaped = rows.map((row) =>
        cols && cols[0] !== '*'
          ? Object.fromEntries(cols.map((c) => [c, get(row, c)]))
          : { ...row },
      );
      if (this.mode === 'many') return { data: shaped, error: null, status: 200 };
      if (this.mode === 'maybe') {
        if (shaped.length > 1) {
          return { data: null, error: { code: 'PGRST116', message: 'multiple rows' }, status: 406 };
        }
        return { data: shaped[0] ?? null, error: null, status: 200 };
      }
      if (shaped.length !== 1) {
        return { data: null, error: { code: 'PGRST116', message: 'no rows' }, status: 406 };
      }
      return { data: shaped[0], error: null, status: 200 };
    }

    private execute(): Reply {
      requests.push({
        table: this.table,
        op: this.op,
        filters: [...this.filters],
        payload: this.payload,
      });
      if (dropNextRequest) {
        dropNextRequest = false;
        throw new TypeError('Failed to fetch');
      }
      if (nextError) {
        if (nextError.skip > 0) {
          nextError = { ...nextError, skip: nextError.skip - 1 };
        } else {
          const { error, status } = nextError;
          nextError = null;
          return { data: null, error, status };
        }
      }

      if (this.table === 'profiles') {
        const id = this.filters.find((f) => f.column === 'id')?.value;
        const profile = typeof id === 'string' ? profiles.get(id) : undefined;
        const rows = profile ? [profile] : [];
        if (this.mode === 'maybe') return { data: rows[0] ?? null, error: null, status: 200 };
        return { data: rows, error: null, status: 200 };
      }

      if (this.op === 'insert') {
        if (!canWrite) {
          return {
            data: null,
            error: {
              code: '42501',
              message: 'new row violates row-level security policy for table "movies"',
            },
            status: 403,
          };
        }
        const list = Array.isArray(this.payload) ? this.payload : [this.payload];
        const stamp = tick();
        const added: MovieRow[] = [];
        for (const values of list) {
          const row = {
            id: crypto.randomUUID(),
            deleted_at: null,
            ...values,
            created_at: stamp,
            updated_at: stamp,
          } as MovieRow;
          // The primary key: an id that exists (live or deleted) can never be inserted again.
          if ([...store, ...added].some((other) => other.id === row.id)) {
            return {
              data: null,
              error: {
                code: '23505',
                message: 'duplicate key value violates unique constraint "movies_pkey"',
              },
              status: 409,
            };
          }
          // One statement is all-or-nothing: rows added earlier in THIS statement count too.
          const problem = violation(row, added);
          if (problem)
            return { data: null, error: problem, status: problem.code === '23505' ? 409 : 400 };
          added.push(row);
        }
        store.push(...added);
        return this.shape(added);
      }

      const visible = store.filter((row) => matches(row, this.filters));

      if (this.op === 'update') {
        // RLS: rows the caller may not write are simply not matched.
        const targets = canWrite ? visible : [];
        const changed: MovieRow[] = [];
        for (const row of targets) {
          const candidate: MovieRow = Object.assign({}, row, this.payload, {
            updated_at: tick(), // the BEFORE UPDATE trigger
          });
          const problem = violation(candidate);
          if (problem)
            return { data: null, error: problem, status: problem.code === '23505' ? 409 : 400 };
          Object.assign(row, candidate);
          changed.push(row);
        }
        return this.mode === 'many' && !this.columnsRequested()
          ? { data: null, error: null, status: 204 }
          : this.shape(changed);
      }

      let rows = visible;
      const order = this.orderBy;
      if (order) {
        rows = [...rows].sort((a, b) => {
          const left = String(get(a, order.column));
          const right = String(get(b, order.column));
          return (left < right ? -1 : left > right ? 1 : 0) * (order.ascending ? 1 : -1);
        });
      }
      const limit = Math.min(this.max ?? rowCap, rowCap);
      return this.shape(rows.slice(0, limit));
    }

    private columnsRequested(): boolean {
      return this.columns !== null;
    }
  }

  const client = { from: (table: string) => new Builder(table) } as unknown as SupabaseClient;

  return {
    client,
    requests,
    movies: () => store,
    profiles,
    remoteUpdate(id, patch) {
      const row = store.find((candidate) => candidate.id === id);
      if (!row) throw new Error(`remoteUpdate: unknown id ${id}`);
      Object.assign(row, patch, { updated_at: tick() });
    },
    failNext(error, status = 400, skip = 0) {
      nextError = { error, status, skip };
    },
    dropNext() {
      dropNextRequest = true;
    },
    setCanWrite(value) {
      canWrite = value;
    },
  };
}
