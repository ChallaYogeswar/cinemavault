import { beforeEach, describe, expect, it } from 'vitest';
import { fixtureId } from '@/data/mock/fixtures';
import type { MovieRepository } from '@/data/repositories/movieRepository';
import type { Movie } from '@/domain/movie';
import { EMPTY_MOVIE_INPUT, movieToInput } from '@/domain/movieInput';
import type { Role } from '@/domain/permissions';
import type { AppError } from '@/domain/result';
import type { MovieInputValues } from '@/domain/validation';
import { findOrThrow, first, must } from '../helpers';

/** What a repository implementation must provide so the SAME rules can be asserted on each. */
export interface ContractSubject {
  readonly repo: MovieRepository;
  readonly seedCount: number;
  setRole(role: Role): void;
  /** Another device changes a stored record behind this repository's back. */
  remoteEdit(id: string, patch: Partial<MovieInputValues>): void | Promise<void>;
  /** Every stored record, tombstones included, as domain objects. */
  stored(): readonly Movie[] | Promise<readonly Movie[]>;
  /** Rewrites a record's stored normalized_title, as the original import spelled it (finding F9). */
  plantNormalizedTitle(id: string, normalized: string): void | Promise<void>;
  /** The next call fails with this error. */
  failNext(error: AppError): void;
}

const input = (patch: Partial<MovieInputValues> = {}): MovieInputValues => ({
  ...EMPTY_MOVIE_INPUT,
  title: 'A Brand New Film',
  year: 2024,
  ...patch,
});

/**
 * The MovieRepository contract. It runs against the in-memory mock AND the Supabase repository, so
 * the UI can be developed against the mock and still behave identically on real data.
 */
export function defineMovieRepositoryContract(
  name: string,
  make: () => ContractSubject | Promise<ContractSubject>,
): void {
  describe(`MovieRepository contract: ${name}`, () => {
    let s: ContractSubject;
    let repo: MovieRepository;
    beforeEach(async () => {
      s = await make();
      repo = s.repo;
    });

    describe('list and get', () => {
      it('lists live titles only', async () => {
        const all = must(await repo.list());
        expect(all).toHaveLength(s.seedCount);
        const head = first(all);
        must(await repo.remove(head.id, head.updatedAt));
        expect(must(await repo.list()).some((m) => m.id === head.id)).toBe(false);
      });
      it('get returns not_found for unknown and deleted ids', async () => {
        expect(await repo.get(fixtureId(99_999))).toMatchObject({
          ok: false,
          error: { code: 'not_found' },
        });
        const head = first(must(await repo.list()));
        must(await repo.remove(head.id, head.updatedAt));
        expect(await repo.get(head.id)).toMatchObject({ ok: false, error: { code: 'not_found' } });
      });
      it('returns every field of a seeded record unchanged', async () => {
        const stored = findOrThrow(await s.stored(), (m) => m.title === 'Parasite');
        expect(must(await repo.get(stored.id))).toEqual(stored);
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
        expect(await repo.create(input({ title: 'a brand   new film' }))).toMatchObject({
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
        expect(await repo.create(input({ year: null }))).toMatchObject({
          ok: false,
          error: { reason: 'duplicate_identity' },
        });
      });

      it('re-validates input even though the form already did', async () => {
        expect(await repo.create(input({ userRating: 4.55 }))).toMatchObject({
          ok: false,
          error: { code: 'validation' },
        });
        expect(await repo.create(input({ watched: true, watchedOn: '2026-02-31' }))).toMatchObject({
          ok: false,
          error: { code: 'validation' },
        });
      });

      it('rejects a javascript: link', async () => {
        expect(await repo.create(input({ shotLink: 'javascript:alert(1)' }))).toMatchObject({
          ok: false,
          error: { code: 'validation' },
        });
      });

      it('round-trips every editable field exactly', async () => {
        const full = input({
          title: 'Round Trip',
          year: 1999,
          genre: 'Drama, Thriller',
          runtimeMinutes: 133,
          watched: true,
          watchedOn: '2026-03-04',
          userRating: 4.5,
          verdict: 'Line one\nLine two',
          technicalNotes: 'Seen on 35mm',
          shotLink: 'https://example.com/shot.png',
          mediaType: 'tv',
        });
        const saved = must(await repo.create(full));
        expect(movieToInput(saved)).toEqual(full);
        expect(movieToInput(must(await repo.get(saved.id)))).toEqual(full);
      });
    });

    describe('update (optimistic concurrency)', () => {
      it('updates and moves updatedAt forward', async () => {
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
        await s.remoteEdit(original.id, { verdict: 'Changed on my phone' });
        expect(
          await repo.update(
            original.id,
            { ...movieToInput(original), verdict: 'Changed on my laptop' },
            original.updatedAt,
          ),
        ).toMatchObject({ ok: false, error: { code: 'conflict', reason: 'stale_version' } });
        expect(must(await repo.get(original.id)).verdict).toBe('Changed on my phone');
      });

      it('two saves from the same version: exactly one wins, the other is stale', async () => {
        const original = must(await repo.create(input()));
        const first = await repo.update(
          original.id,
          { ...movieToInput(original), verdict: 'first' },
          original.updatedAt,
        );
        const second = await repo.update(
          original.id,
          { ...movieToInput(original), verdict: 'second' },
          original.updatedAt,
        );
        expect(first.ok).toBe(true);
        expect(second).toMatchObject({ ok: false, error: { reason: 'stale_version' } });
        expect(must(await repo.get(original.id)).verdict).toBe('first');
      });

      it('allows renaming a title (the original request: “#Manhole” → “Manhole”)', async () => {
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
        expect(
          await repo.update(
            b.id,
            { ...movieToInput(b), title: 'parasite', year: a.year },
            b.updatedAt,
          ),
        ).toMatchObject({ ok: false, error: { reason: 'duplicate_identity' } });
        expect(
          (await repo.update(a.id, { ...movieToInput(a), title: 'PARASITE' }, a.updatedAt)).ok,
        ).toBe(true);
      });

      it('returns not_found for a missing record', async () => {
        expect(
          await repo.update(fixtureId(99_999), input(), '2026-01-01T00:00:00.000Z'),
        ).toMatchObject({ ok: false, error: { code: 'not_found' } });
      });

      it('returns not_found for a record deleted elsewhere, not a conflict', async () => {
        const m = must(await repo.create(input()));
        must(await repo.remove(m.id, m.updatedAt));
        expect(await repo.update(m.id, input({ userRating: 1 }), m.updatedAt)).toMatchObject({
          ok: false,
          error: { code: 'not_found' },
        });
      });
    });

    describe('remove (soft delete)', () => {
      it('keeps a tombstone so the delete can propagate, and bumps updatedAt', async () => {
        const m = must(await repo.create(input()));
        must(await repo.remove(m.id, m.updatedAt));
        const stored = findOrThrow(await s.stored(), (x) => x.id === m.id);
        expect(stored.deletedAt).not.toBeNull();
        expect(stored.updatedAt > m.updatedAt).toBe(true);
      });

      it('is version-checked', async () => {
        const m = must(await repo.create(input()));
        await s.remoteEdit(m.id, { verdict: 'edited elsewhere' });
        expect(await repo.remove(m.id, m.updatedAt)).toMatchObject({
          ok: false,
          error: { reason: 'stale_version' },
        });
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
      it('can read, but every write is forbidden and changes nothing', async () => {
        const m = must(await repo.create(input()));
        const before = await s.stored();
        s.setRole('viewer');
        expect(must(await repo.list()).length).toBeGreaterThan(0);
        expect(await repo.get(m.id)).toMatchObject({ ok: true });
        for (const attempt of [
          repo.create(input({ title: 'Nope' })),
          repo.update(m.id, input({ userRating: 1 }), m.updatedAt),
          repo.remove(m.id, m.updatedAt),
        ]) {
          expect(await attempt).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        }
        expect(await s.stored()).toEqual(before);
      });
    });

    describe('failure injection', () => {
      it('a failed call reports the failure, then the next call recovers', async () => {
        s.failNext({ code: 'network', message: 'offline' });
        expect(await repo.list()).toMatchObject({ ok: false, error: { code: 'network' } });
        expect((await repo.list()).ok).toBe(true);
      });
    });

    describe('legacy normalized titles (imported rows spell them without punctuation)', () => {
      const legacy = async (title: string, normalized: string) => {
        const created = must(await repo.create(input({ title, year: 2012 })));
        await s.plantNormalizedTitle(created.id, normalized);
        return must(await repo.get(created.id));
      };

      it('a title that differs only by punctuation or case is still a duplicate', async () => {
        await legacy('Barfi!', 'barfi');
        for (const title of ['Barfi!', 'barfi', 'BARFI?!']) {
          expect(await repo.create(input({ title, year: 2012 }))).toMatchObject({
            ok: false,
            error: { code: 'conflict', reason: 'duplicate_identity' },
          });
        }
      });

      it('but a different year or media type is a different title', async () => {
        await legacy('Barfi!', 'barfi');
        must(await repo.create(input({ title: 'Barfi!', year: 2013 })));
        must(await repo.create(input({ title: 'Barfi!', year: 2012, mediaType: 'tv' })));
      });

      it('editing another field keeps the stored spelling instead of rewriting it', async () => {
        const before = await legacy('Mr. & Mrs. Mahi', 'mr mrs mahi');
        const after = must(
          await repo.update(
            before.id,
            { ...movieToInput(before), genre: 'Drama' },
            before.updatedAt,
          ),
        );
        expect(after.genre).toBe('Drama');
        expect(after.normalizedTitle).toBe('mr mrs mahi');
      });

      it('renaming the title does recompute it', async () => {
        const before = await legacy('Mr. & Mrs. Mahi', 'mr mrs mahi');
        const after = must(
          await repo.update(
            before.id,
            { ...movieToInput(before), title: 'Mr. and Mrs. Mahi' },
            before.updatedAt,
          ),
        );
        expect(after.normalizedTitle).toBe('mr. and mrs. mahi');
      });

      it('a title is not a duplicate of itself when edited', async () => {
        const before = await legacy('Barfi!', 'barfi');
        must(
          await repo.update(
            before.id,
            { ...movieToInput(before), genre: 'Comedy' },
            before.updatedAt,
          ),
        );
      });
    });
  });
}
