import { beforeEach, describe, expect, it } from 'vitest';
import { createSeedMovies, fixtureId } from '@/data/mock/fixtures';
import {
  createMockMovieRepository,
  type MockMovieRepository,
} from '@/data/mock/mockMovieRepository';
import { EMPTY_MOVIE_INPUT, movieToInput } from '@/domain/movieInput';
import type { Role } from '@/domain/permissions';
import type { MovieInputValues } from '@/domain/validation';
import { findOrThrow, first, must } from '../helpers';

const input = (patch: Partial<MovieInputValues> = {}): MovieInputValues => ({
  ...EMPTY_MOVIE_INPUT,
  title: 'A Brand New Film',
  year: 2024,
  ...patch,
});

let role: Role;
let tick: number;
let idCounter: number;
let repo: MockMovieRepository;

beforeEach(() => {
  role = 'owner';
  tick = Date.parse('2026-10-27T10:00:00.000Z');
  idCounter = 5_000;
  repo = createMockMovieRepository({
    getRole: () => role,
    now: () => new Date(tick), // frozen clock: proves versions still strictly increase
    newId: () => fixtureId(idCounter++),
  });
});

describe('list and get', () => {
  it('lists live titles only', async () => {
    const all = must(await repo.list());
    expect(all).toHaveLength(createSeedMovies().length);
    const head = first(all);
    must(await repo.remove(head.id, head.updatedAt));
    expect(must(await repo.list()).some((m) => m.id === head.id)).toBe(false);
  });
  it('get returns not_found for unknown and deleted ids', async () => {
    const unknown = await repo.get(fixtureId(99_999));
    expect(unknown).toMatchObject({ ok: false, error: { code: 'not_found' } });
    const head = first(must(await repo.list()));
    must(await repo.remove(head.id, head.updatedAt));
    expect(await repo.get(head.id)).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });
});

describe('create', () => {
  it('creates a titled record with derived normalizedTitle and equal timestamps', async () => {
    const movie = must(await repo.create(input({ title: '  The   New   Film (TV) ' })));
    expect(movie.title).toBe('The New Film (TV)');
    expect(movie.normalizedTitle).toBe('the new film');
    expect(movie.createdAt).toBe(movie.updatedAt);
    expect(movie.deletedAt).toBeNull();
    expect(must(await repo.list())).toContainEqual(movie);
  });

  it('rejects a duplicate identity with reason duplicate_identity', async () => {
    must(await repo.create(input()));
    const again = await repo.create(input({ title: 'a brand   new film' }));
    expect(again).toMatchObject({
      ok: false,
      error: { code: 'conflict', reason: 'duplicate_identity' },
    });
  });

  it('allows the same title for a different year or media type', async () => {
    must(await repo.create(input()));
    expect(must(await repo.create(input({ year: 2025 })))).toBeTruthy();
    expect(must(await repo.create(input({ mediaType: 'tv' })))).toBeTruthy();
  });

  it('treats two year-less titles as duplicates (the DB index would not — finding F2)', async () => {
    must(await repo.create(input({ year: null })));
    const again = await repo.create(input({ year: null }));
    expect(again).toMatchObject({ ok: false, error: { reason: 'duplicate_identity' } });
  });

  it('re-validates input even though the form already did', async () => {
    const bad = await repo.create(input({ userRating: 4.55 }));
    expect(bad).toMatchObject({ ok: false, error: { code: 'validation' } });
    const impossibleDate = await repo.create(input({ watched: true, watchedOn: '2026-02-31' }));
    expect(impossibleDate).toMatchObject({ ok: false, error: { code: 'validation' } });
  });

  it('rejects a javascript: link', async () => {
    const result = await repo.create(input({ shotLink: 'javascript:alert(1)' }));
    expect(result).toMatchObject({ ok: false, error: { code: 'validation' } });
  });
});

describe('update (optimistic concurrency)', () => {
  it('updates and moves updatedAt forward even on a frozen clock', async () => {
    const original = must(await repo.create(input()));
    const updated = must(
      await repo.update(
        original.id,
        { ...movieToInput(original), userRating: 4 },
        original.updatedAt,
      ),
    );
    expect(updated.userRating).toBe(4);
    expect(updated.updatedAt > original.updatedAt).toBe(true);
    expect(updated.createdAt).toBe(original.createdAt);
  });

  it('rejects a stale expectedUpdatedAt and leaves the record untouched', async () => {
    const original = must(await repo.create(input()));
    repo.simulateRemoteEdit(original.id, { verdict: 'Changed on my phone' });
    const stale = await repo.update(
      original.id,
      { ...movieToInput(original), verdict: 'Changed on my laptop' },
      original.updatedAt,
    );
    expect(stale).toMatchObject({
      ok: false,
      error: { code: 'conflict', reason: 'stale_version' },
    });
    expect(must(await repo.get(original.id)).verdict).toBe('Changed on my phone');
  });

  it('allows renaming a title to a new name (the original request: “#Manhole” → “Manhole”)', async () => {
    const manhole = findOrThrow(must(await repo.list()), (m) => m.title === '#Manhole');
    const renamed = must(
      await repo.update(
        manhole.id,
        { ...movieToInput(manhole), title: 'Manhole' },
        manhole.updatedAt,
      ),
    );
    expect(renamed.title).toBe('Manhole');
    expect(renamed.normalizedTitle).toBe('manhole');
  });

  it('rejects renaming onto another live title but not onto itself', async () => {
    const list = must(await repo.list());
    const a = findOrThrow(list, (m) => m.title === 'Parasite');
    const b = findOrThrow(list, (m) => m.title === 'Oldboy');
    const clash = await repo.update(
      b.id,
      { ...movieToInput(b), title: 'parasite', year: a.year },
      b.updatedAt,
    );
    expect(clash).toMatchObject({ ok: false, error: { reason: 'duplicate_identity' } });
    const same = await repo.update(a.id, { ...movieToInput(a), title: 'PARASITE' }, a.updatedAt);
    expect(same.ok).toBe(true);
  });

  it('returns not_found for a missing or deleted record', async () => {
    const result = await repo.update(fixtureId(99_999), input(), '2026-01-01T00:00:00.000Z');
    expect(result).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });
});

describe('remove (soft delete)', () => {
  it('keeps a tombstone so the delete can propagate, and bumps updatedAt', async () => {
    const m = must(await repo.create(input()));
    must(await repo.remove(m.id, m.updatedAt));
    const stored = findOrThrow(repo.snapshot(), (x) => x.id === m.id);
    expect(stored.deletedAt).not.toBeNull();
    expect(stored.updatedAt > m.updatedAt).toBe(true);
  });

  it('is version-checked', async () => {
    const m = must(await repo.create(input()));
    repo.simulateRemoteEdit(m.id, { verdict: 'edited elsewhere' });
    const result = await repo.remove(m.id, m.updatedAt);
    expect(result).toMatchObject({ ok: false, error: { reason: 'stale_version' } });
    expect(must(await repo.list()).some((x) => x.id === m.id)).toBe(true);
  });

  it('frees the identity so the same title can be added again', async () => {
    const m = must(await repo.create(input()));
    must(await repo.remove(m.id, m.updatedAt));
    expect(must(await repo.create(input())).id).not.toBe(m.id);
  });

  it('deleting twice reports not_found the second time', async () => {
    const m = must(await repo.create(input()));
    must(await repo.remove(m.id, m.updatedAt));
    expect(await repo.remove(m.id, m.updatedAt)).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });
});

describe('viewer role (fail closed)', () => {
  it('can read but every write is forbidden and changes nothing', async () => {
    const m = must(await repo.create(input()));
    const before = repo.snapshot();
    role = 'viewer';
    expect(must(await repo.list()).length).toBeGreaterThan(0);
    expect(await repo.get(m.id)).toMatchObject({ ok: true });
    expect(await repo.create(input({ title: 'Nope' }))).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await repo.update(m.id, input({ userRating: 1 }), m.updatedAt)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await repo.remove(m.id, m.updatedAt)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(repo.snapshot()).toEqual(before);
  });
});

describe('failure injection', () => {
  it('fails exactly one call, then recovers', async () => {
    repo.failNext({ code: 'network', message: 'offline' });
    expect(await repo.list()).toMatchObject({ ok: false, error: { code: 'network' } });
    expect((await repo.list()).ok).toBe(true);
  });
});
