import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import SCRIPT from '../../scripts/rls-adversarial.sql?raw';
import { MOCK_OWNER_ID, fixtureId } from '@/data/mock/fixtures';
import { createMigratedDatabase, resetDatabase } from '../fakes/pgliteSupabase';

/**
 * Runs scripts/rls-adversarial.sql, the SAME file that is run on the real development Supabase
 * project, against a Postgres built from the repository's migrations. That keeps the two honest:
 * what passes on Supabase passes here, and CI notices if a migration weakens a policy.
 *
 * Each "sabotage" test then weakens one rule and demands that the suite FAIL, proving the suite
 * can actually see the attack it claims to catch.
 */
const IDS = { ownerId: MOCK_OWNER_ID, viewerId: fixtureId(777) };

let db: PGlite;
beforeEach(async () => {
  db = await createMigratedDatabase();
  await resetDatabase(db, [], IDS);
}, 60_000);

async function runSuite(): Promise<string[]> {
  const results = await db.exec(SCRIPT);
  const rows = results.flatMap((result) =>
    result.fields.some((field) => field.name === 'result')
      ? result.rows.map((row) => String((row as { result: unknown }).result))
      : [],
  );
  await db.exec('rollback').catch(() => undefined);
  return rows;
}
const failures = (lines: readonly string[]) => lines.filter((line) => !line.startsWith('PASS'));

describe('RLS adversarial suite (real PostgreSQL)', () => {
  it('every attack is refused and every owner action works', async () => {
    const lines = await runSuite();
    expect(failures(lines)).toEqual([]);
    expect(lines.length).toBeGreaterThanOrEqual(40);
  }, 60_000);

  it('changes nothing: the transaction is rolled back', async () => {
    await runSuite();
    const { rows } = await db.query<{ movies: number; profiles: number; sync: number }>(
      `select (select count(*) from public.movies)::int movies,
              (select count(*) from public.profiles)::int profiles,
              (select count(*) from public.sync_state)::int sync`,
    );
    expect(rows[0]).toEqual({ movies: 0, profiles: 2, sync: 0 });
    const roles = await db.query<{ role: string }>(
      'select role from public.profiles order by role',
    );
    expect(roles.rows.map((row) => row.role)).toEqual(['owner', 'viewer']);
  }, 60_000);

  it.each([
    [
      'viewers may insert movies',
      `drop policy movies_insert_own on public.movies;
       create policy movies_insert_own on public.movies for insert to authenticated with check (owner_id = (select auth.uid()));`,
    ],
    [
      'viewers may update the owner’s movies',
      `drop policy movies_update_own on public.movies;
       create policy movies_update_own on public.movies for update to authenticated using (true) with check (true);`,
    ],
    [
      'viewers may delete the owner’s movies',
      `drop policy movies_delete_own on public.movies;
       create policy movies_delete_own on public.movies for delete to authenticated using (true);`,
    ],
    ['roles are self-editable', 'grant update (role) on public.profiles to authenticated;'],
    [
      'a viewer may promote themselves through a loose profile policy and grant',
      `grant update on public.profiles to authenticated;`,
    ],
    [
      'anonymous visitors may read the library',
      `grant select on public.movies to anon;
       create policy anon_reads on public.movies for select to anon using (true);`,
    ],
    [
      'viewers may edit the owner’s metadata',
      `drop policy movie_metadata_update_own on public.movie_metadata;
       create policy movie_metadata_update_own on public.movie_metadata for update to authenticated using (true) with check (true);`,
    ],
    [
      'row-level security is switched off on movies',
      'alter table public.movies disable row level security;',
    ],
    ['more than one owner is allowed', 'drop index public.profiles_single_owner_idx;'],
  ])(
    'notices when %s',
    async (_name, sabotage) => {
      await db.exec(sabotage);
      expect(failures(await runSuite()).length).toBeGreaterThan(0);
    },
    60_000,
  );
});
