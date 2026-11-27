import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { MOCK_OWNER_ID, createSeedMovies, fixtureId, generateMovies } from '@/data/mock/fixtures';
import { createSupabaseMovieRepository } from '@/data/supabase/supabaseMovieRepository';
import { createSupabaseProfileRepository } from '@/data/supabase/supabaseProfileRepository';
import { EMPTY_MOVIE_INPUT, movieToInput } from '@/domain/movieInput';
import { resolveRole, type Role } from '@/domain/permissions';
import { first, must } from '../helpers';
import { createMigratedDatabase, createPgliteClient, resetDatabase } from '../fakes/pgliteSupabase';

const OWNER = MOCK_OWNER_ID;
const VIEWER = fixtureId(777);
const input = { ...EMPTY_MOVIE_INPUT, title: 'Brand New', year: 2024 };

let db: PGlite;
beforeAll(async () => {
  db = await createMigratedDatabase();
}, 60_000);

/** `actingAs` is who the DATABASE believes is calling; `believedRole` is what the client thinks. */
async function setup(opts: {
  actingAs: string | null;
  believedRole?: Role;
  seed?: ReturnType<typeof createSeedMovies>;
  rowCap?: number;
}) {
  await resetDatabase(db, opts.seed ?? createSeedMovies(OWNER), {
    ownerId: OWNER,
    viewerId: VIEWER,
  });
  const pg = createPgliteClient(db, {
    getUser: () => opts.actingAs,
    ...(opts.rowCap === undefined ? {} : { rowCap: opts.rowCap }),
  });
  const repo = createSupabaseMovieRepository({
    client: pg.client,
    userId: opts.actingAs ?? OWNER,
    getRole: () => opts.believedRole ?? 'owner',
  });
  const dump = async () =>
    (
      await db.query<{ j: unknown }>('select row_to_json(t) j from public.movies t order by id')
    ).rows.map((r) => r.j);
  return { pg, repo, dump };
}

describe('real Postgres: a library the size of production', () => {
  it('reads all 3,243 records through the 1,000-row response cap, exactly once', async () => {
    const { repo } = await setup({ actingAs: OWNER, seed: generateMovies(3_243, OWNER) });
    const all = must(await repo.list());
    expect(all).toHaveLength(3_243);
    expect(new Set(all.map((m) => m.id)).size).toBe(3_243);
  }, 60_000);

  it('the viewer reads the owner’s library, not an empty one', async () => {
    const { repo } = await setup({ actingAs: VIEWER, believedRole: 'viewer' });
    expect(must(await repo.list())).toHaveLength(createSeedMovies().length);
  });

  it('a signed-out client (no JWT) cannot read anything', async () => {
    const { repo } = await setup({ actingAs: null });
    expect(await repo.list()).toMatchObject({ ok: false });
    expect((await repo.list()).ok).toBe(false);
  });
});

describe('real Postgres: row-level security is the real wall', () => {
  it('a client that WRONGLY believes it is the owner is still refused, and nothing changes', async () => {
    const { repo, dump } = await setup({ actingAs: VIEWER, believedRole: 'owner' });
    const target = first(must(await repo.list()));
    const before = JSON.stringify(await dump());

    expect(await repo.create(input)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(
      await repo.update(target.id, { ...movieToInput(target), userRating: 1 }, target.updatedAt),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await repo.remove(target.id, target.updatedAt)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(JSON.stringify(await dump())).toBe(before);
  });

  it('raw requests that bypass the repository fare no better', async () => {
    const { pg, dump } = await setup({ actingAs: VIEWER, believedRole: 'viewer' });
    const before = JSON.stringify(await dump());
    const hijack = await pg.client
      .from('movies')
      .update({ title: 'pwn' })
      .neq('title', '')
      .select('id');
    expect(hijack.data).toEqual([]);
    const insert = await pg.client
      .from('movies')
      .insert({ owner_id: VIEWER, title: 'x', normalized_title: 'x' })
      .select('id')
      .single();
    expect(insert.error?.code).toBe('42501');
    const asOwner = await pg.client
      .from('movies')
      .insert({ owner_id: OWNER, title: 'x', normalized_title: 'x' })
      .select('id')
      .single();
    expect(asOwner.error?.code).toBe('42501');
    expect(JSON.stringify(await dump())).toBe(before);
  });

  it('the owner’s role resolves from the real profiles table; the viewer’s does not', async () => {
    const owner = await setup({ actingAs: OWNER });
    const ownerProfile = await createSupabaseProfileRepository(owner.pg.client).load(OWNER);
    expect(resolveRole(must(ownerProfile))).toBe('owner');
    const viewer = await setup({ actingAs: VIEWER });
    const viewerProfile = await createSupabaseProfileRepository(viewer.pg.client).load(VIEWER);
    expect(resolveRole(must(viewerProfile))).toBe('viewer');
  });

  it('a user can only read their own profile row', async () => {
    const { pg } = await setup({ actingAs: VIEWER });
    const other = await createSupabaseProfileRepository(pg.client).load(OWNER);
    expect(must(other)).toBeNull(); // RLS hides it: treated as "no profile" and so fails closed
    expect(resolveRole(must(other))).toBe('viewer');
  });
});

describe('real Postgres: the profile a person may change', () => {
  const nameOf = async (id: string) =>
    (
      await db.query<{ display_name: string | null }>(
        'select display_name from public.profiles where id = $1',
        [id],
      )
    ).rows[0]?.display_name;

  it('a user sets, reads and clears their own display name', async () => {
    const { pg } = await setup({ actingAs: VIEWER });
    const profiles = createSupabaseProfileRepository(pg.client);
    expect(must(await profiles.updateDisplayName(VIEWER, 'Friend'))).toBe('Friend');
    expect(must(await profiles.loadDisplayName(VIEWER))).toBe('Friend');
    expect(await nameOf(VIEWER)).toBe('Friend');
    expect(must(await profiles.updateDisplayName(VIEWER, null))).toBeNull();
    expect(must(await profiles.loadDisplayName(VIEWER))).toBeNull();
  });

  it('changing the name never changes the role', async () => {
    const { pg } = await setup({ actingAs: VIEWER });
    const profiles = createSupabaseProfileRepository(pg.client);
    await profiles.updateDisplayName(VIEWER, 'Friend');
    expect(resolveRole(must(await profiles.load(VIEWER)))).toBe('viewer');
  });

  it('a viewer cannot promote themselves, by the API or by raw update', async () => {
    const { pg } = await setup({ actingAs: VIEWER });
    const raw = await pg.client.from('profiles').update({ role: 'owner' }).eq('id', VIEWER);
    expect(raw.error).not.toBeNull();
    const { rows } = await db.query<{ role: string }>(
      'select role from public.profiles where id = $1',
      [VIEWER],
    );
    expect(rows[0]?.role).not.toBe('owner');
  });

  it('a user cannot rename someone else; the attempt is reported, not silently "saved"', async () => {
    const { pg } = await setup({ actingAs: VIEWER });
    const before = await nameOf(OWNER);
    const result = await createSupabaseProfileRepository(pg.client).updateDisplayName(
      OWNER,
      'Hijacked',
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await nameOf(OWNER)).toBe(before);
  });

  it('cannot read another user’s display name either', async () => {
    const { pg } = await setup({ actingAs: VIEWER });
    expect(
      must(await createSupabaseProfileRepository(pg.client).loadDisplayName(OWNER)),
    ).toBeNull();
  });
});

describe('real Postgres: behaviours the emulator could only imitate', () => {
  it('the version token is a microsecond timestamp and a delete bumps it', async () => {
    const { repo, dump } = await setup({ actingAs: OWNER });
    const m = must(await repo.create(input));
    expect(m.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{1,6}\+00:00$/);
    must(await repo.remove(m.id, m.updatedAt));
    const row = (await dump()).find((r) => (r as { id: string }).id === m.id) as {
      updated_at: string;
      deleted_at: string | null;
    };
    expect(row.deleted_at).not.toBeNull();
    expect(row.updated_at > m.updatedAt).toBe(true);
  });

  it('the application blocks two year-less duplicates that the database index alone would allow', async () => {
    const { repo, pg } = await setup({ actingAs: OWNER });
    must(await repo.create({ ...input, year: null }));
    expect(await repo.create({ ...input, year: null })).toMatchObject({
      ok: false,
      error: { reason: 'duplicate_identity' },
    });
    // Finding F2, demonstrated: bypassing the repository, Postgres accepts the duplicate.
    const raw = await pg.client
      .from('movies')
      .insert({
        owner_id: OWNER,
        title: 'Brand New',
        normalized_title: 'brand new',
        media_type: 'movie',
      })
      .select('id')
      .single();
    expect(raw.error).toBeNull();
  });

  it('two racing creates of the same dated title: exactly one wins, the other is a duplicate', async () => {
    const { repo, dump } = await setup({ actingAs: OWNER });
    const results = await Promise.all([repo.create(input), repo.create(input)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ error: { reason: 'duplicate_identity' } });
    expect(
      (await dump()).filter((r) => (r as { title: string }).title === 'Brand New'),
    ).toHaveLength(1);
  });

  it('two racing updates from the same version: exactly one wins, the other is stale', async () => {
    const { repo } = await setup({ actingAs: OWNER });
    const m = must(await repo.create(input));
    const results = await Promise.all([
      repo.update(m.id, { ...movieToInput(m), verdict: 'A' }, m.updatedAt),
      repo.update(m.id, { ...movieToInput(m), verdict: 'B' }, m.updatedAt),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ error: { reason: 'stale_version' } });
  });
});
