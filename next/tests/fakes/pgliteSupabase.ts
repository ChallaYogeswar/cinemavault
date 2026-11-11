import { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { movieToRow } from '@/data/mappers/movieMapper';
import type { Movie } from '@/domain/movie';

/**
 * A REAL Postgres (PGlite, WebAssembly) loaded with the repository's actual migrations, behind
 * the small slice of the supabase-js query builder the repositories use. Each request runs in its
 * own transaction as the `authenticated` role with `auth.uid()` set, exactly how PostgREST does,
 * so row-level security, check constraints, the unique index and the `updated_at` trigger are the
 * real thing, and rows come back through `row_to_json` in PostgREST's wire format (microsecond
 * timestamps with a +00:00 offset, numerics as JSON numbers).
 */
const MIGRATIONS = import.meta.glob<string>('../../../supabase/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const BOOTSTRAP = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(), email text, phone text,
    raw_user_meta_data jsonb default '{}'
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to authenticated, anon;
  grant usage on schema public to anon, authenticated;
`;

/** The migration files, oldest first, as `[file name, sql]`. */
export const migrationFiles = (): [string, string][] =>
  Object.keys(MIGRATIONS)
    .sort()
    .map((path): [string, string] => [path.split('/').pop() ?? path, MIGRATIONS[path] ?? '']);

/** A hash of everything the migrations create, so two databases can be compared exactly. */
export async function schemaFingerprint(db: PGlite): Promise<{ hash: string; items: number }> {
  const { rows } = await db.query<{ hash: string; items: number }>(`
    select md5(string_agg(k || v, E'\n' order by k, v)) as hash, count(*)::int as items from (
      select 'col' k, table_name||'.'||column_name||' '||data_type||' '||is_nullable||' '||coalesce(column_default,'') v from information_schema.columns where table_schema='public'
      union all select 'idx', indexdef from pg_indexes where schemaname='public'
      union all select 'pol', tablename||' '||policyname||' '||cmd||' '||coalesce(qual,'')||' | '||coalesce(with_check,'') from pg_policies where schemaname='public'
      union all select 'con', conrelid::regclass||' '||conname||' '||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace
      union all select 'fn', proname from pg_proc where pronamespace='public'::regnamespace
      union all select 'trg', tgrelid::regclass||' '||tgname from pg_trigger where not tgisinternal and tgrelid::regclass::text in ('public.movies','public.sync_state','auth.users')
      union all select 'grant', grantee||' '||table_name||' '||privilege_type from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated')
      union all select 'colgrant', grantee||' '||table_name||'.'||column_name||' '||privilege_type from information_schema.column_privileges where table_schema='public' and grantee in ('anon','authenticated') and privilege_type='UPDATE'
    ) s`);
  const row = rows[0];
  if (!row) throw new Error('no fingerprint');
  return row;
}

export async function createMigratedDatabase(
  options: { readonly skip?: (fileName: string) => boolean } = {},
): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(BOOTSTRAP);
  for (const file of Object.keys(MIGRATIONS)
    .sort()
    .filter((path) => !options.skip?.(path.split('/').pop() ?? path))) {
    const sql = (MIGRATIONS[file] ?? '').replace('create extension if not exists pgcrypto;', '');
    await db.exec(sql);
  }
  return db;
}

export interface Seeded {
  readonly ownerId: string;
  readonly viewerId: string;
}

/** Empties the library and re-creates one owner and one viewer account, then loads `seed`. */
export async function resetDatabase(
  db: PGlite,
  seed: readonly Movie[],
  ids: Seeded,
): Promise<void> {
  await db.exec('truncate public.movies, public.profiles cascade; delete from auth.users;');
  await db.query(
    `insert into auth.users(id, email) values ($1, 'owner@example.com'), ($2, 'viewer@example.com')`,
    [ids.ownerId, ids.viewerId],
  ); // the signup trigger creates both profiles as viewers
  await db.query(`update public.profiles set role = 'owner' where id = $1`, [ids.ownerId]);
  await insertMovies(db, seed);
}

const SEED_COLUMNS = [
  'id',
  'owner_id',
  'title',
  'normalized_title',
  'media_type',
  'year',
  'genre',
  'runtime_minutes',
  'watched',
  'watched_on',
  'user_rating',
  'verdict',
  'technical_notes',
  'shot_link',
  'created_at',
  'updated_at',
  'deleted_at',
] as const;

export async function insertMovies(db: PGlite, movies: readonly Movie[]): Promise<void> {
  const BATCH = 400;
  for (let start = 0; start < movies.length; start += BATCH) {
    const batch = movies.slice(start, start + BATCH);
    const params: unknown[] = [];
    const tuples = batch.map((movie) => {
      const row = movieToRow(movie) as unknown as Record<string, unknown>;
      const placeholders = SEED_COLUMNS.map((column) => {
        params.push(row[column]);
        return `$${String(params.length)}`;
      });
      return `(${placeholders.join(',')})`;
    });
    // Disable the updated_at trigger's effect: it only fires on UPDATE, so inserts keep their stamps.
    await db.query(
      `insert into public.movies (${SEED_COLUMNS.join(',')}) values ${tuples.join(',')}`,
      params,
    );
  }
}

interface Filter {
  op: 'eq' | 'neq' | 'gt' | 'is';
  column: string;
  value: unknown;
}
interface Reply {
  readonly data: unknown;
  readonly error: { message: string; code: string } | null;
  readonly status: number;
}

const IDENT = /^[a-z_]+$/;
const ident = (name: string): string => {
  if (!IDENT.test(name)) throw new Error(`bad identifier ${name}`);
  return name;
};

export interface PgClientOptions {
  /** The authenticated user's id for each request (null = no JWT). Read on every request. */
  readonly getUser: () => string | null;
  /** Rows a single response may contain (PostgREST max_rows). */
  readonly rowCap?: number;
  /**
   * Runs just before the Nth request (1-based) is sent, to simulate another client writing while
   * this one is in the middle of a multi-request operation such as a paged list.
   */
  readonly beforeRequest?: (requestNumber: number) => Promise<void> | void;
}

export interface PgClient {
  readonly client: SupabaseClient;
  /** The next request rejects like a dropped connection. */
  dropNext(): void;
  readonly requestCount: () => number;
}

export function createPgliteClient(db: PGlite, options: PgClientOptions): PgClient {
  const rowCap = options.rowCap ?? 1_000;
  let drop = false;
  let requests = 0;

  class Builder implements PromiseLike<Reply> {
    private op: 'select' | 'insert' | 'update' = 'select';
    private payload: Record<string, unknown> = {};
    private rowsToInsert: Record<string, unknown>[] = [];
    private readonly filters: Filter[] = [];
    private orderBy: { column: string; ascending: boolean } | null = null;
    private max: number | null = null;
    private mode: 'many' | 'single' | 'maybe' = 'many';
    private columns: string | null = null;

    constructor(private readonly table: string) {}

    select(columns?: string) {
      this.columns = columns ?? '*';
      return this;
    }
    insert(values: Record<string, unknown> | Record<string, unknown>[]) {
      this.op = 'insert';
      this.rowsToInsert = Array.isArray(values) ? values : [values];
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
      return this.execute().then(onfulfilled, onrejected);
    }

    private where(params: unknown[]): string {
      if (this.filters.length === 0) return '';
      const parts = this.filters.map((filter) => {
        const column = ident(filter.column);
        if (filter.op === 'is') return `${column} is null`;
        params.push(filter.value);
        const symbol = { eq: '=', neq: '<>', gt: '>' }[filter.op];
        return `${column} ${symbol} $${String(params.length)}`;
      });
      return ` where ${parts.join(' and ')}`;
    }

    private colList(): string {
      const cols = this.columns ?? '*';
      return cols === '*'
        ? '*'
        : cols
            .split(',')
            .map((c) => ident(c.trim()))
            .join(', ');
    }

    private shape(rows: unknown[]): Reply {
      if (this.mode === 'many') return { data: rows, error: null, status: 200 };
      if (this.mode === 'maybe') {
        if (rows.length > 1) {
          return { data: null, error: { code: 'PGRST116', message: 'multiple rows' }, status: 406 };
        }
        return { data: rows[0] ?? null, error: null, status: 200 };
      }
      if (rows.length !== 1) {
        return { data: null, error: { code: 'PGRST116', message: 'no rows' }, status: 406 };
      }
      return { data: rows[0], error: null, status: 200 };
    }

    private async execute(): Promise<Reply> {
      requests += 1;
      await options.beforeRequest?.(requests);
      if (drop) {
        drop = false;
        throw new TypeError('Failed to fetch');
      }
      const table = `public.${ident(this.table)}`;
      const params: unknown[] = [];
      let statement: string;
      if (this.op === 'select') {
        const order = this.orderBy
          ? ` order by ${ident(this.orderBy.column)} ${this.orderBy.ascending ? 'asc' : 'desc'}`
          : '';
        const limit = Math.min(this.max ?? rowCap, rowCap);
        statement = `select ${this.colList()} from ${table}${this.where(params)}${order} limit ${String(limit)}`;
      } else if (this.op === 'insert') {
        const keys = Object.keys(this.rowsToInsert[0] ?? {}).map(ident);
        const tuples = this.rowsToInsert.map((row) => {
          const slots = keys.map((key) => {
            params.push(row[key]);
            return `$${String(params.length)}`;
          });
          return `(${slots.join(',')})`;
        });
        statement = `insert into ${table} (${keys.join(',')}) values ${tuples.join(',')} returning ${this.colList()}`;
      } else {
        const keys = Object.keys(this.payload).map(ident);
        const sets = keys.map((key) => {
          params.push(this.payload[key]);
          return `${key} = $${String(params.length)}`;
        });
        const where = this.where(params);
        statement = `update ${table} set ${sets.join(', ')}${where} returning ${this.columns === null ? '1 as ok' : this.colList()}`;
      }

      const user = options.getUser();
      try {
        const rows = await db.transaction(async (tx) => {
          // No JWT means the `anon` role, as in PostgREST; it has no grants on these tables.
          await tx.exec(user === null ? 'set local role anon' : 'set local role authenticated');
          await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user ?? '']);
          const wrapped = `with r as (${statement}) select row_to_json(r) as j from r`;
          const result = await tx.query<{ j: unknown }>(wrapped, params);
          return result.rows.map((row) => row.j);
        });
        return this.shape(rows);
      } catch (cause) {
        const error = cause as { code?: string; message?: string };
        const code = error.code ?? '';
        const status = code === '42501' ? 403 : code === '23505' ? 409 : 400;
        return { data: null, error: { code, message: error.message ?? 'database error' }, status };
      }
    }
  }

  return {
    client: { from: (table: string) => new Builder(table) } as unknown as SupabaseClient,
    dropNext: () => {
      drop = true;
    },
    requestCount: () => requests,
  };
}
