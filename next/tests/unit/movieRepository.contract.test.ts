import { inputToColumns, rowToMovie } from '@/data/mappers/movieMapper';
import { MOCK_OWNER_ID, createSeedMovies } from '@/data/mock/fixtures';
import { createMockMovieRepository } from '@/data/mock/mockMovieRepository';
import { fixtureId } from '@/data/mock/fixtures';
import { createSupabaseMovieRepository } from '@/data/supabase/supabaseMovieRepository';
import { movieToInput } from '@/domain/movieInput';
import type { Role } from '@/domain/permissions';
import { defineMovieRepositoryContract } from '../contract/movieRepositoryContract';
import { createFakeSupabase } from '../fakes/fakeSupabase';
import { createMigratedDatabase, createPgliteClient, resetDatabase } from '../fakes/pgliteSupabase';

defineMovieRepositoryContract('in-memory mock', () => {
  let role: Role = 'owner';
  let tick = Date.parse('2026-10-27T10:00:00.000Z');
  const repo = createMockMovieRepository({ getRole: () => role, now: () => new Date(tick) });
  tick += 0;
  return {
    repo,
    seedCount: createSeedMovies().length,
    setRole: (next) => {
      role = next;
    },
    remoteEdit: (id, patch) => {
      repo.simulateRemoteEdit(id, patch);
    },
    stored: () => repo.snapshot(),
    plantNormalizedTitle: (id, normalized) => {
      repo.simulateRemoteEdit(id, { normalizedTitle: normalized });
    },
    failNext: (error) => {
      repo.failNext(error);
    },
  };
});

defineMovieRepositoryContract('Supabase (PostgREST emulator)', () => {
  let role: Role = 'owner';
  const fake = createFakeSupabase({ seed: createSeedMovies(MOCK_OWNER_ID) });
  const repo = createSupabaseMovieRepository({
    client: fake.client,
    userId: MOCK_OWNER_ID,
    getRole: () => role,
  });
  return {
    repo,
    seedCount: createSeedMovies().length,
    setRole: (next) => {
      role = next;
      fake.setCanWrite(next === 'owner'); // RLS agrees with the role, as in production
    },
    remoteEdit: (id, patch) => {
      const row = fake.movies().find((candidate) => candidate.id === id);
      if (!row) throw new Error(`unknown id ${id}`);
      fake.remoteUpdate(id, inputToColumns({ ...movieToInput(rowToMovie(row)), ...patch }));
    },
    stored: () => fake.movies().map((row) => rowToMovie(row)),
    plantNormalizedTitle: (id, normalized) => {
      fake.remoteUpdate(id, { normalized_title: normalized });
    },
    failNext: () => {
      fake.dropNext();
    },
  };
});

const OWNER = MOCK_OWNER_ID;
const VIEWER = fixtureId(777);
let databasePromise: ReturnType<typeof createMigratedDatabase> | undefined;

/** The same contract against a REAL Postgres with the repository's real migrations and RLS. */
defineMovieRepositoryContract(
  'Supabase repository on real Postgres (PGlite + migrations)',
  async () => {
    databasePromise ??= createMigratedDatabase();
    const db = await databasePromise;
    await resetDatabase(db, createSeedMovies(OWNER), { ownerId: OWNER, viewerId: VIEWER });

    let role: Role = 'owner';
    let actingUser = OWNER;
    const pg = createPgliteClient(db, { getUser: () => actingUser });
    const repo = createSupabaseMovieRepository({
      client: pg.client,
      userId: OWNER,
      getRole: () => role,
    });
    const readAll = async () => {
      const { rows } = await db.query<{ j: unknown }>(
        'select row_to_json(t) j from public.movies t order by id',
      );
      return rows.map((row) => rowToMovie(row.j));
    };
    return {
      repo,
      seedCount: createSeedMovies().length,
      setRole: (next) => {
        role = next;
        actingUser = next === 'owner' ? OWNER : VIEWER; // the database sees a different account
      },
      remoteEdit: async (id, patch) => {
        const current = (await readAll()).find((m) => m.id === id);
        if (!current) throw new Error(`unknown id ${id}`);
        const columns = inputToColumns({ ...movieToInput(current), ...patch });
        const keys = Object.keys(columns);
        await db.query(
          `update public.movies set ${keys.map((k, i) => `${k} = $${String(i + 2)}`).join(', ')} where id = $1`,
          [id, ...Object.values(columns)],
        );
      },
      stored: readAll,
      plantNormalizedTitle: async (id, normalized) => {
        await db.query('update public.movies set normalized_title = $2 where id = $1', [
          id,
          normalized,
        ]);
      },
      failNext: () => {
        pg.dropNext();
      },
    };
  },
);
