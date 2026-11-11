import { describe, expect, it } from 'vitest';
import { createMigratedDatabase, migrationFiles, schemaFingerprint } from '../fakes/pgliteSupabase';

/**
 * The history recorded in production's `supabase_migrations.schema_migrations`, read-only,
 * 2026-11-01. Applied migrations are never edited, renamed or deleted: the files below are the
 * record of what production ran. See docs/migration-baseline.md.
 */
const PRODUCTION_HISTORY = [
  '20260927000100_initial_schema.sql',
  '20261015175602_cinemavault_initial_schema.sql',
  '20261015175654_align_movie_rating_scale.sql',
  '20261019120000_owner_viewer_roles.sql',
  '20261021120000_profile_contact_sync.sql',
];

describe('migration history', { timeout: 60_000 }, () => {
  it('the repository holds exactly the history production recorded, in order', () => {
    expect(migrationFiles().map(([name]) => name)).toEqual(PRODUCTION_HISTORY);
  });

  it('the two initial-schema files are byte-identical, so the second is a recorded no-op', () => {
    const files = new Map(migrationFiles());
    expect(files.get(PRODUCTION_HISTORY[0] ?? '')).toBe(files.get(PRODUCTION_HISTORY[1] ?? ''));
  });

  it('a completely fresh database built from the full history equals one built without the duplicate', async () => {
    const full = await createMigratedDatabase();
    const canonical = await createMigratedDatabase({
      skip: (name) => name === '20261015175602_cinemavault_initial_schema.sql',
    });
    const a = await schemaFingerprint(full);
    const b = await schemaFingerprint(canonical);
    expect(a).toEqual(b);
    expect(a.items).toBeGreaterThan(100);
  });

  it('a fresh database ends in the intended security posture', async () => {
    const db = await createMigratedDatabase();
    const { rows } = await db.query<{ n: string; rel: string }>(`
      select relname as rel, relrowsecurity::text as n from pg_class
      where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`);
    expect(rows).toEqual([
      { rel: 'movie_metadata', n: 'true' },
      { rel: 'movies', n: 'true' },
      { rel: 'profiles', n: 'true' },
      { rel: 'sync_state', n: 'true' },
    ]);
    const { rows: rating } = await db.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'movies_user_rating_check'`,
    );
    expect(rating[0]?.def).toContain('5');
    expect(rating[0]?.def).not.toContain('10');
  });
});
