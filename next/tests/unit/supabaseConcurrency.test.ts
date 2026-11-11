import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { MOCK_OWNER_ID, fixtureId, generateMovies } from '@/data/mock/fixtures';
import { createSupabaseMovieRepository } from '@/data/supabase/supabaseMovieRepository';
import type { Movie } from '@/domain/movie';
import { EMPTY_MOVIE_INPUT } from '@/domain/movieInput';
import { normalizeTitle } from '@/domain/identity';
import { must } from '../helpers';
import {
  createMigratedDatabase,
  createPgliteClient,
  insertMovies,
  resetDatabase,
} from '../fakes/pgliteSupabase';

const OWNER = MOCK_OWNER_ID;
const VIEWER = fixtureId(777);
const PAGE = 500;
const nth = <T>(list: readonly T[], index: number): T => {
  const value = list[index];
  if (value === undefined) throw new Error(`no element at ${String(index)}`);
  return value;
};
const sortedRows = (rows: readonly Movie[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));

let dbPromise: Promise<PGlite> | undefined;
const database = async () => {
  dbPromise ??= createMigratedDatabase();
  return dbPromise;
};

const sqlInsert = async (db: PGlite, movie: Movie) => {
  await insertMovies(db, [movie]);
};

describe('list() while other clients write', { timeout: 120_000 }, () => {
  const total = 2_300; // five pages of 500
  // Titles run opposite to ids, so ordering by anything but id would skip or repeat rows.
  const library = generateMovies(total, OWNER).map((m, i) => ({
    ...m,
    title: `Reverse ${String(total - i).padStart(5, '0')}`,
    normalizedTitle: `reverse ${String(total - i).padStart(5, '0')}`,
  }));

  /** Lists with `onPage3` running just before the third page request, i.e. mid-listing. */
  const listDuring = async (onPage3: (db: PGlite) => Promise<void>) => {
    const db = await database();
    await resetDatabase(db, library, { ownerId: OWNER, viewerId: VIEWER });
    const pg = createPgliteClient(db, {
      getUser: () => OWNER,
      beforeRequest: async (n) => {
        if (n === 3) await onPage3(db);
      },
    });
    const repo = createSupabaseMovieRepository({
      client: pg.client,
      userId: OWNER,
      getRole: () => 'owner',
      pageSize: PAGE,
    });
    const listed = must(await repo.list());
    return { listed, requests: pg.requestCount() };
  };

  const ids = (movies: readonly Movie[]) => movies.map((m) => m.id);
  const byId = (a: Movie, b: Movie) => (a.id < b.id ? -1 : 1);

  it('reads more than one page, and every row exactly once, when nothing changes', async () => {
    const { listed, requests } = await listDuring(() => Promise.resolve());
    expect(requests).toBeGreaterThanOrEqual(5);
    expect(listed).toHaveLength(total);
    expect(new Set(ids(listed)).size).toBe(total);
  });

  it('a row inserted AHEAD of the cursor mid-listing is seen once; one BEHIND it is missed, never duplicated', async () => {
    const ahead = {
      ...nth(library, 0),
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      title: 'Added Ahead',
      normalizedTitle: 'added ahead',
      year: 1999,
    };
    const behind = {
      ...nth(library, 0),
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Added Behind',
      normalizedTitle: 'added behind',
      year: 1998,
    };
    const { listed } = await listDuring(async (db) => {
      await sqlInsert(db, ahead);
      await sqlInsert(db, behind);
    });
    const found = ids(listed);
    expect(found.filter((id) => id === ahead.id)).toHaveLength(1);
    expect(found).not.toContain(behind.id);
    expect(new Set(found).size).toBe(found.length);
    // Every row that existed throughout is present.
    expect(library.every((m) => found.includes(m.id))).toBe(true);
  });

  it('a row soft-deleted before its page is read is absent; one already read stays, once', async () => {
    const sorted = [...library].sort(byId);
    const alreadyRead = nth(sorted, 10); // page 1
    const notYetRead = nth(sorted, 1_800); // page 4
    const { listed } = await listDuring(async (db) => {
      await db.query('update public.movies set deleted_at = now() where id = any($1)', [
        [alreadyRead.id, notYetRead.id],
      ]);
    });
    const found = ids(listed);
    expect(found).not.toContain(notYetRead.id);
    expect(found.filter((id) => id === alreadyRead.id)).toHaveLength(1);
    expect(new Set(found).size).toBe(found.length);
    expect(found).toHaveLength(total - 1);
  });

  it('a row hard-deleted ahead of the cursor is simply absent, with no error', async () => {
    const victim = nth([...library].sort(byId), 2_000);
    const { listed } = await listDuring(async (db) => {
      await db.query('delete from public.movies where id = $1', [victim.id]);
    });
    expect(ids(listed)).not.toContain(victim.id);
    expect(listed).toHaveLength(total - 1);
  });

  it('a row edited mid-listing appears exactly once, in whichever version was current when its page was read', async () => {
    const sorted = [...library].sort(byId);
    const early = nth(sorted, 5);
    const late = nth(sorted, 2_100);
    const { listed } = await listDuring(async (db) => {
      await db.query(`update public.movies set genre = 'Edited elsewhere' where id = any($1)`, [
        [early.id, late.id],
      ]);
    });
    expect(listed).toHaveLength(total);
    expect(listed.filter((m) => m.id === early.id)).toHaveLength(1);
    expect(listed.filter((m) => m.id === late.id)).toHaveLength(1);
    expect(listed.find((m) => m.id === early.id)?.genre).not.toBe('Edited elsewhere'); // already read: old version
    expect(listed.find((m) => m.id === late.id)?.genre).toBe('Edited elsewhere'); // read afterwards: new version
  });
});

describe('the page-count guard', () => {
  it('fails loudly instead of returning a partial library or looping forever', async () => {
    let calls = 0;
    // A server that never runs out of rows: every page is full, with ever-larger ids.
    const endless = {
      from: () => {
        const builder: Record<string, unknown> = {};
        for (const name of ['select', 'is', 'order', 'eq', 'neq', 'gt'])
          builder[name] = () => builder;
        builder.limit = () => builder;
        builder.then = (resolve: (value: unknown) => unknown) => {
          calls += 1;
          const base = calls * 10;
          const rows = [1, 2].map((n) => ({ id: fixtureId(base + n) }));
          return resolve({ data: rows, error: null, status: 200 });
        };
        return builder;
      },
    };
    const repo = createSupabaseMovieRepository({
      client: endless as never,
      userId: OWNER,
      getRole: () => 'owner',
      pageSize: 2,
    });
    const result = await repo.list();
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown' } });
    expect(calls).toBe(500);
  });
});

describe('duplicate detection with more candidates than one page', { timeout: 120_000 }, () => {
  /** 1,300 titles in the same year and media type: more than one 1,000-row page of candidates. */
  const crowded = (): Movie[] =>
    generateMovies(1_300, OWNER).map((m, i) => ({
      ...m,
      title: `Crowded ${String(i).padStart(4, '0')}`,
      normalizedTitle: `crowded ${String(i).padStart(4, '0')}`,
      mediaType: 'movie',
      year: 2001,
    }));

  const open = async (rows: Movie[], pageSize?: number) => {
    const db = await database();
    await resetDatabase(db, rows, { ownerId: OWNER, viewerId: VIEWER });
    const pg = createPgliteClient(db, { getUser: () => OWNER });
    const repo = createSupabaseMovieRepository({
      client: pg.client,
      userId: OWNER,
      getRole: () => 'owner',
      ...(pageSize === undefined ? {} : { pageSize }),
    });
    return { db, repo, pg };
  };

  it('finds a duplicate that sits beyond the first 1,000 candidates (highest id)', async () => {
    const rows = crowded();
    const last = nth(sortedRows(rows), rows.length - 1);
    const { repo } = await open(rows);
    expect(
      await repo.create({ ...EMPTY_MOVIE_INPUT, title: last.title, year: 2001 }),
    ).toMatchObject({
      ok: false,
      error: { code: 'conflict', reason: 'duplicate_identity' },
    });
  });

  it('also finds it through the punctuation-insensitive comparison', async () => {
    const rows = crowded();
    const last = nth(sortedRows(rows), rows.length - 1);
    const { repo, db } = await open(rows);
    await db.query('update public.movies set normalized_title = $2 where id = $1', [
      last.id,
      normalizeTitle(last.title).replace(/ /g, '  '),
    ]);
    expect(
      await repo.create({ ...EMPTY_MOVIE_INPUT, title: last.title.toUpperCase(), year: 2001 }),
    ).toMatchObject({
      ok: false,
      error: { reason: 'duplicate_identity' },
    });
  });

  it('a genuinely new title in the same crowded year is accepted after scanning every page', async () => {
    const { repo, pg } = await open(crowded());
    const before = pg.requestCount();
    must(await repo.create({ ...EMPTY_MOVIE_INPUT, title: 'Brand New Arrival', year: 2001 }));
    expect(pg.requestCount() - before).toBeGreaterThanOrEqual(3); // two candidate pages + the insert
  });

  it('the database unique index still stops an exact duplicate that slips past the client check', async () => {
    const rows = crowded();
    const { db } = await open(rows);
    const clone = { ...nth(rows, 5), id: fixtureId(555_555) };
    await expect(sqlInsert(db, clone)).rejects.toMatchObject({ code: '23505' });
  });
});
