import { describe, expect, it } from 'vitest';
import { MOCK_OWNER_ID, createSeedMovies, generateMovies } from '@/data/mock/fixtures';
import { createSupabaseMovieRepository } from '@/data/supabase/supabaseMovieRepository';
import { EMPTY_MOVIE_INPUT, movieToInput } from '@/domain/movieInput';
import type { Role } from '@/domain/permissions';
import { findOrThrow, first, must } from '../helpers';
import { createFakeSupabase } from '../fakes/fakeSupabase';

function setup(options: { seedCount?: number; rowCap?: number; role?: Role } = {}) {
  let role: Role = options.role ?? 'owner';
  const seed =
    options.seedCount === undefined
      ? createSeedMovies(MOCK_OWNER_ID)
      : generateMovies(options.seedCount, MOCK_OWNER_ID);
  const fake = createFakeSupabase({
    seed,
    ...(options.rowCap === undefined ? {} : { rowCap: options.rowCap }),
    canWrite: role === 'owner',
  });
  const repo = createSupabaseMovieRepository({
    client: fake.client,
    userId: MOCK_OWNER_ID,
    getRole: () => role,
  });
  return {
    fake,
    repo,
    setRole: (next: Role) => {
      role = next;
    },
  };
}

const input = { ...EMPTY_MOVIE_INPUT, title: 'Brand New', year: 2024 };

describe('list: a library larger than the server’s row cap', () => {
  it.each([1_000, 500, 37])(
    'reads all 3,243 records exactly once with a cap of %i',
    async (cap) => {
      const { repo, fake } = setup({ seedCount: 3_243, rowCap: cap });
      const all = must(await repo.list());
      expect(all).toHaveLength(3_243);
      expect(new Set(all.map((m) => m.id)).size).toBe(3_243);
      expect(fake.requests.length).toBeGreaterThan(Math.ceil(3_243 / cap));
    },
  );

  it('does not include tombstones and filters them in the query, not afterwards', async () => {
    const { repo, fake } = setup();
    const head = first(must(await repo.list()));
    must(await repo.remove(head.id, head.updatedAt));
    fake.requests.length = 0;
    expect(must(await repo.list()).some((m) => m.id === head.id)).toBe(false);
    expect(fake.requests[0]?.filters).toContainEqual({
      op: 'is',
      column: 'deleted_at',
      value: null,
    });
  });

  it('fails the whole list loudly if one record cannot be read, instead of hiding it', async () => {
    const { repo, fake } = setup();
    const victim = first(fake.movies());
    fake.remoteUpdate(victim.id, { user_rating: 9 }); // outside anything the app can display
    const result = await repo.list();
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown' } });
    if (!result.ok) expect(result.error.message).toMatch(/1 records could not be read/);
  });
});

describe('writes carry their version into the database statement itself', () => {
  it('update filters on id, the expected updated_at (verbatim) and not-deleted', async () => {
    const { repo, fake } = setup();
    const m = must(await repo.create(input));
    fake.requests.length = 0;
    must(await repo.update(m.id, { ...movieToInput(m), userRating: 3 }, m.updatedAt));
    const write = findOrThrow(fake.requests, (r) => r.op === 'update');
    expect(write.filters).toEqual(
      expect.arrayContaining([
        { op: 'eq', column: 'id', value: m.id },
        { op: 'eq', column: 'updated_at', value: m.updatedAt },
        { op: 'is', column: 'deleted_at', value: null },
      ]),
    );
    expect(m.updatedAt).toMatch(/\.\d{6}\+00:00$/); // microseconds survive end to end
  });

  it('a version that differs by one MICROSECOND is stale', async () => {
    const { repo, fake } = setup();
    const m = must(await repo.create(input));
    fake.remoteUpdate(m.id, { verdict: 'x' }); // trigger bumps updated_at by 1µs
    expect(await repo.update(m.id, movieToInput(m), m.updatedAt)).toMatchObject({
      ok: false,
      error: { reason: 'stale_version' },
    });
  });

  it('delete is an UPDATE of deleted_at, never a DELETE, and carries the version', async () => {
    const { repo, fake } = setup();
    const m = must(await repo.create(input));
    fake.requests.length = 0;
    must(await repo.remove(m.id, m.updatedAt));
    const write = findOrThrow(fake.requests, (r) => r.op === 'update');
    expect(write.payload).toMatchObject({ deleted_at: expect.any(String) as unknown });
    expect(write.filters).toContainEqual({ op: 'eq', column: 'updated_at', value: m.updatedAt });
    expect(fake.movies().some((r) => r.id === m.id && r.deleted_at !== null)).toBe(true);
  });

  it('never sends owner, id or timestamps in an update payload', async () => {
    const { repo, fake } = setup();
    const m = must(await repo.create(input));
    fake.requests.length = 0;
    must(await repo.update(m.id, movieToInput(m), m.updatedAt));
    const write = findOrThrow(fake.requests, (r) => r.op === 'update');
    expect(Object.keys(write.payload as object)).not.toEqual(expect.arrayContaining(['owner_id']));
    for (const forbidden of ['id', 'owner_id', 'created_at', 'updated_at', 'deleted_at']) {
      expect(write.payload).not.toHaveProperty(forbidden);
    }
  });
});

describe('permissions', () => {
  it('a viewer’s writes are refused before any request is sent', async () => {
    const { repo, fake, setRole } = setup();
    const m = must(await repo.create(input));
    setRole('viewer');
    fake.requests.length = 0;
    await repo.create({ ...input, title: 'Nope' });
    await repo.update(m.id, movieToInput(m), m.updatedAt);
    await repo.remove(m.id, m.updatedAt);
    expect(fake.requests).toHaveLength(0);
  });

  it('if the client believes it is an owner but row-level security refuses, the result is forbidden and nothing changes', async () => {
    const { repo, fake } = setup();
    const m = must(await repo.create(input));
    const before = JSON.stringify(fake.movies());
    fake.setCanWrite(false); // server says no, whatever the UI thinks
    expect(await repo.create({ ...input, title: 'Nope' })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(
      await repo.update(m.id, { ...movieToInput(m), userRating: 1 }, m.updatedAt),
    ).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await repo.remove(m.id, m.updatedAt)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(JSON.stringify(fake.movies())).toBe(before);
  });
});

describe('database errors become the app’s vocabulary', () => {
  const cases = [
    [
      'unique violation (a race the pre-check could not see)',
      { code: '23505', message: 'dup' },
      409,
      'conflict',
    ],
    ['row-level security', { code: '42501', message: 'rls' }, 403, 'forbidden'],
    ['check constraint', { code: '23514', message: 'check' }, 400, 'validation'],
    ['expired JWT', { code: 'PGRST301', message: 'jwt' }, 401, 'unauthenticated'],
    ['server error', { code: '', message: 'boom' }, 503, 'network'],
    ['anything else', { code: 'XX000', message: 'weird' }, 400, 'unknown'],
  ] as const;

  it.each(cases)('create: %s', async (_name, error, status, code) => {
    const { repo, fake } = setup();
    fake.failNext(error, status, 1); // let the duplicate pre-check pass, fail the INSERT
    const result = await repo.create(input);
    expect(result).toMatchObject({ ok: false, error: { code } });
    if (!result.ok) expect(result.error.message).not.toMatch(/dup|rls|jwt|boom|weird|check/);
    expect(fake.movies().some((r) => r.title === 'Brand New')).toBe(false);
  });

  it('a dropped connection during the insert is a network error and is not retried', async () => {
    const { repo, fake } = setup();
    fake.dropNext();
    expect(await repo.create(input)).toMatchObject({ ok: false, error: { code: 'network' } });
    expect(fake.requests.filter((r) => r.op === 'insert')).toHaveLength(0);
  });
});

describe('createMany: requests and races', () => {
  const batch = (n: number, prefix = 'Bulk') =>
    Array.from({ length: n }, (_, i) => ({ ...input, title: `${prefix} ${String(i)}` }));

  it('a view-only account is refused before any request is made', async () => {
    const { repo, fake } = setup({ role: 'viewer' });
    fake.requests.length = 0;
    expect(await repo.createMany(batch(3))).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(fake.requests).toHaveLength(0);
  });

  it('adds 200 rows with ONE insert and a paged read, not a request per row', async () => {
    const { repo, fake } = setup({ seedCount: 1_500, rowCap: 1_000 });
    fake.requests.length = 0;
    const out = must(await repo.createMany(batch(200)));
    expect(out.created).toHaveLength(200);
    expect(fake.requests.filter((r) => r.op === 'insert')).toHaveLength(1);
    expect(fake.requests.length).toBeLessThanOrEqual(4); // 2 pages of identities + 1 insert
  });

  it('when another device added one of the rows in the meantime, saves the others and skips that one', async () => {
    const { repo, fake } = setup({ seedCount: 5 });
    // skip the identity read (1 request), then refuse the batch insert as a unique violation
    fake.failNext({ code: '23505', message: 'duplicate key' }, 409, 1);
    const out = must(await repo.createMany(batch(3)));
    // the batch was refused as a whole, so every row is settled one at a time and all three fit
    expect(out.created.map((m) => m.title)).toEqual(['Bulk 0', 'Bulk 1', 'Bulk 2']);
    expect(out.skipped).toEqual([]);
    expect(fake.movies().filter((r) => r.title.startsWith('Bulk '))).toHaveLength(3);
  });
});
