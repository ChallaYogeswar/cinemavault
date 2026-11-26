import { beforeAll, describe, expect, it } from 'vitest';
import { MOCK_OWNER_ID, fixtureId, generateMovies } from '@/data/mock/fixtures';
import { movieToRow } from '@/data/mappers/movieMapper';
import {
  assertSafeTargets,
  diffRows,
  digestRows,
  profileRows,
  readAllRows,
  rehearse,
  type Row,
} from '../../scripts/rehearsal-lib.mjs';
import { first } from '../helpers';
import { createMigratedDatabase, createPgliteClient, resetDatabase } from '../fakes/pgliteSupabase';

const OWNER = MOCK_OWNER_ID;
const VIEWER = fixtureId(777);

/** A library shaped like production: thousands of rows, tombstones, year-less, µs version stamps. */
/** Postgres' own rendering: microseconds with trailing zeros trimmed, as PostgREST returns them. */
const stamp = (day: string, micros: number): string => {
  const fraction = String(micros).padStart(6, '0').replace(/0+$/, '');
  return `2026-10-${day}${fraction === '' ? '' : `.${fraction}`}+00:00`;
};

function library(count: number): Row[] {
  return generateMovies(count, OWNER).map((movie, index) => {
    const row = movieToRow({
      ...movie,
      createdAt: stamp('15T18:16:47', 846_001 + (index % 50)),
      updatedAt: stamp('15T18:16:47', 846_001 + (index % 53)),
      deletedAt: index % 400 === 0 ? stamp('16T09:00:00', 100_001 + index) : null,
      year: index % 55 === 0 ? null : movie.year,
    }) as unknown as Row;
    return row;
  });
}

let databasePromise: ReturnType<typeof createMigratedDatabase> | undefined;
const freshDestination = async () => {
  databasePromise ??= createMigratedDatabase();
  const db = await databasePromise;
  await resetDatabase(db, [], { ownerId: OWNER, viewerId: VIEWER });
  return { db, client: createPgliteClient(db, { getUser: () => OWNER }).client };
};

describe('rehearsal: pure helpers', () => {
  const base = library(40);

  it('digest ignores order but not content', () => {
    expect(digestRows([...base].reverse())).toBe(digestRows(base));
    const changed = base.map((r, i) => (i === 7 ? { ...r, genre: 'tampered' } : r));
    expect(digestRows(changed)).not.toBe(digestRows(base));
  });

  it('diff finds a missing row, an extra row and a changed field, by id and column', () => {
    const target = base.slice(1).map((r, i) => (i === 3 ? { ...r, user_rating: 4.5 } : r));
    target.push({ ...first(base), id: fixtureId(424_242) });
    const d = diffRows(base, target);
    expect(d.identical).toBe(false);
    expect(d.missing).toEqual([first(base).id]);
    expect(d.extra).toEqual([fixtureId(424_242)]);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]?.fields.map((f) => f.column)).toEqual(['user_rating']);
  });

  it('diff sees a truncated microsecond timestamp (the version-token bug)', () => {
    const target = base.map((r, i) =>
      i === 5 ? { ...r, updated_at: String(r.updated_at).replace(/(\.\d{3})\d{3}/, '$1000') } : r,
    );
    expect(diffRows(base, target).changed[0]?.fields.map((f) => f.column)).toEqual(['updated_at']);
  });

  it('refuses a production destination and a same-project copy', () => {
    expect(() => {
      assertSafeTargets({
        sourceUrl: 'https://devref.supabase.co',
        destUrl: 'https://ermjvreodaeovawbsbyh.supabase.co',
      });
    }).toThrow(/PRODUCTION/);
    expect(() => {
      assertSafeTargets({ sourceUrl: 'https://a.supabase.co', destUrl: 'https://a.supabase.co' });
    }).toThrow(/same project/);
    expect(() => {
      assertSafeTargets({
        sourceUrl: 'https://ermjvreodaeovawbsbyh.supabase.co',
        destUrl: 'https://dev.supabase.co',
      });
    }).not.toThrow(); // reading production as the SOURCE is the whole point
  });

  it('profiles what is being moved', () => {
    const p = profileRows(base);
    expect(p.total).toBe(40);
    expect(p.tombstones).toBe(1);
    expect(p.yearless).toBeGreaterThan(0);
    expect(p.microsecondTimestamps).toBe(40);
  });
});

describe('rehearsal against a real Postgres (migrations + RLS)', { timeout: 60_000 }, () => {
  let rows: Row[];
  beforeAll(() => {
    rows = library(3_243);
  });

  it('a dry run reads and profiles but writes nothing', async () => {
    const { client, db } = await freshDestination();
    const report = await rehearse({
      source: { readAll: () => Promise.resolve(rows) },
      dest: client,
      apply: false,
    });
    expect(report.applied).toBe(false);
    expect(report.profile.total).toBe(3_243);
    const { rows: count } = await db.query<{ n: number }>(
      'select count(*)::int n from public.movies',
    );
    expect(count[0]?.n).toBe(0);
  });

  it('copies 3,243 rows through paging and batching, and the copy is exact', async () => {
    const { client } = await freshDestination();
    const report = await rehearse({
      source: { readAll: () => Promise.resolve(rows) },
      dest: client,
      apply: true,
      batchSize: 250,
    });
    expect(report.diff?.sourceCount).toBe(3_243);
    expect(report.diff?.targetCount).toBe(3_243);
    expect(JSON.stringify(report.diff?.changed.slice(0, 2))).toBe('[]');
    expect(report.identical).toBe(true);
    expect(report.targetDigest).toBe(report.sourceDigest);
    // Tombstones and µs stamps survived the round trip.
    const back = await readAllRows(client);
    expect(back.filter((r) => r.deleted_at !== null).length).toBe(
      rows.filter((r) => r.deleted_at !== null).length,
    );
    expect(new Set(back.map((r) => r.updated_at)).size).toBe(
      new Set(rows.map((r) => r.updated_at)).size,
    );
  });

  it('refuses to copy into a destination that already holds rows', async () => {
    const { client } = await freshDestination();
    const source = { readAll: () => Promise.resolve(rows.slice(0, 20)) };
    await rehearse({ source, dest: client, apply: true });
    await expect(rehearse({ source, dest: client, apply: true })).rejects.toThrow(
      /already holds 20 rows/,
    );
  });

  it('a destination that alters data on the way in is reported as a mismatch', async () => {
    const { db, client } = await freshDestination();
    // A trigger that quietly rewrites a field, the kind of drift a rehearsal exists to catch.
    await db.exec(`create function pg_temp.drift() returns trigger language plpgsql as $$
      begin new.genre := upper(coalesce(new.genre,'')); return new; end $$;
      create trigger drift before insert on public.movies for each row execute function pg_temp.drift();`);
    const report = await rehearse({
      source: { readAll: () => Promise.resolve(rows.slice(0, 50)) },
      dest: client,
      apply: true,
    });
    expect(report.identical).toBe(false);
    expect(report.diff?.changed.length).toBeGreaterThan(0);
    await db.exec('drop trigger drift on public.movies');
  });

  it('a failed write names the rows and says production was not touched', async () => {
    const { client } = await freshDestination();
    const bad = [
      ...rows.slice(0, 30),
      { ...first(rows), id: fixtureId(9_999_001), user_rating: 9 },
    ];
    await expect(
      rehearse({
        source: { readAll: () => Promise.resolve(bad) },
        dest: client,
        apply: true,
        batchSize: 10,
      }),
    ).rejects.toThrow(/write failed at rows 30-30.*production was changed/is);
  });
});
