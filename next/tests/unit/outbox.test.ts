import { describe, expect, it } from 'vitest';
import { buildMovie, fixtureId } from '@/data/mock/fixtures';
import { EMPTY_MOVIE_INPUT, movieToInput } from '@/domain/movieInput';
import {
  applyOutbox,
  coalesce,
  findDuplicateIn,
  holdsValues,
  outboxEntrySchema,
  outboxStatus,
  type OutboxEntry,
  type QueueOp,
} from '@/domain/outbox';
import { first } from '../helpers';

const OWNER = fixtureId(1);
const NOW = new Date('2026-11-13T10:00:00.000Z');
const ID = fixtureId(500);
const input = (title: string, year: number | null = 2020) => ({
  ...EMPTY_MOVIE_INPUT,
  title,
  year,
});

const create = (title = 'Alpha'): QueueOp => ({ kind: 'create', movieId: ID, input: input(title) });
const update = (title: string, base = 'v1'): QueueOp => ({
  kind: 'update',
  movieId: ID,
  input: input(title),
  baseUpdatedAt: base,
});
const del = (base = 'v1'): QueueOp => ({
  kind: 'delete',
  movieId: ID,
  baseUpdatedAt: base,
  title: 'Alpha',
});

const put = (existing: OutboxEntry | undefined, op: QueueOp): OutboxEntry => {
  const result = coalesce(existing, op, NOW);
  if (result.action !== 'put') throw new Error(`expected put, got ${result.action}`);
  return result.entry;
};

describe('coalesce: one entry per title', () => {
  it('a first change becomes an entry of its own kind', () => {
    expect(put(undefined, create())).toMatchObject({
      kind: 'create',
      rev: 1,
      baseUpdatedAt: null,
      state: 'pending',
    });
    expect(put(undefined, update('B', 'v7'))).toMatchObject({
      kind: 'update',
      baseUpdatedAt: 'v7',
    });
    expect(put(undefined, del('v7'))).toMatchObject({ kind: 'delete', input: null });
  });

  it('create then edit stays ONE create with the newest values', () => {
    const entry = put(put(undefined, create('Alpha')), update('Beta'));
    expect(entry).toMatchObject({ kind: 'create', rev: 2, title: 'Beta', baseUpdatedAt: null });
    expect(entry.input?.title).toBe('Beta');
  });

  it('create then delete cancels out: it never reached the server', () => {
    expect(coalesce(put(undefined, create()), del(), NOW)).toEqual({ action: 'drop' });
  });

  it('edit then edit keeps the OLDEST base version and the newest values', () => {
    const entry = put(
      put(undefined, update('One', 'v1')),
      update('Two', 'v2-never-seen-by-server'),
    );
    expect(entry).toMatchObject({ kind: 'update', baseUpdatedAt: 'v1', title: 'Two', rev: 2 });
  });

  it('edit then delete is ONE delete, from the oldest base', () => {
    const entry = put(put(undefined, update('One', 'v1')), del('v9'));
    expect(entry).toMatchObject({ kind: 'delete', baseUpdatedAt: 'v1', input: null, rev: 2 });
  });

  it('refuses any change to a title that waits for a decision', () => {
    const waiting: OutboxEntry = {
      ...put(undefined, update('One')),
      state: 'attention',
      reason: 'changed',
    };
    for (const op of [update('X'), del(), create()]) {
      expect(coalesce(waiting, op, NOW)).toEqual({ action: 'blocked', reason: 'needs_attention' });
    }
  });

  it('refuses edits to a title already queued for deletion', () => {
    const deleting = put(undefined, del());
    expect(coalesce(deleting, update('X'), NOW)).toEqual({ action: 'blocked', reason: 'deleted' });
  });

  it('never loses what the person typed: every accepted result carries the latest values', () => {
    let entry: OutboxEntry | undefined;
    for (const title of ['a', 'b', 'c', 'd']) entry = put(entry, update(title, 'v1'));
    expect(entry?.input?.title).toBe('d');
    expect(entry?.baseUpdatedAt).toBe('v1');
  });
});

describe('applyOutbox: the library as this device shows it', () => {
  const library = [
    buildMovie(1, ['Alpha', 'movie', 2001, 'Drama', 100, 3, '2026-01-01', null], OWNER),
    buildMovie(2, ['Beta', 'movie', 2002, 'Comedy', 90, null, 'unwatched', null], OWNER),
  ];
  const a = first(library);
  const entryFor = (op: QueueOp, patch: Partial<OutboxEntry> = {}): OutboxEntry => ({
    ...put(undefined, op),
    ...patch,
  });

  it('with nothing waiting it returns the very same list (no needless re-render)', () => {
    expect(applyOutbox(library, [], OWNER)).toBe(library);
  });

  it('a waiting create is added; an edit is laid over the version in the list; a delete hides the title', () => {
    const created = entryFor({ kind: 'create', movieId: fixtureId(900), input: input('New One') });
    const edited = entryFor({
      kind: 'update',
      movieId: a.id,
      input: { ...movieToInput(a), title: 'Alpha Renamed' },
      baseUpdatedAt: a.updatedAt,
    });
    const out = applyOutbox(library, [created, edited], OWNER);
    expect(out.map((m) => m.title).sort()).toEqual(['Alpha Renamed', 'Beta', 'New One']);
    expect(out.find((m) => m.id === a.id)?.updatedAt).toBe(a.updatedAt); // the server's version stays
    expect(out.find((m) => m.title === 'New One')).toMatchObject({
      ownerId: OWNER,
      deletedAt: null,
    });

    const deleted = entryFor({
      kind: 'delete',
      movieId: a.id,
      baseUpdatedAt: a.updatedAt,
      title: 'Alpha',
    });
    expect(applyOutbox(library, [deleted], OWNER).map((m) => m.title)).toEqual(['Beta']);
  });

  it('is safe to apply twice: a create the server already accepted adds no second copy', () => {
    const create = entryFor({ kind: 'create', movieId: a.id, input: input('Alpha') });
    const out = applyOutbox(library, [create], OWNER);
    expect(out).toHaveLength(2);
    expect(out.find((m) => m.id === a.id)).toBe(a);
    // ...and a delete of a title that is already gone changes nothing.
    const gone = entryFor({
      kind: 'delete',
      movieId: fixtureId(999),
      baseUpdatedAt: 'x',
      title: 'Ghost',
    });
    expect(applyOutbox(library, [gone], OWNER)).toBe(library);
  });

  it('a change that needs a decision is NOT shown as done, except a create (it would look lost)', () => {
    const editWaiting = entryFor(
      { kind: 'update', movieId: a.id, input: input('Changed'), baseUpdatedAt: a.updatedAt },
      { state: 'attention', reason: 'changed' },
    );
    const deleteWaiting = entryFor(
      { kind: 'delete', movieId: fixtureId(2), baseUpdatedAt: 'x', title: 'Beta' },
      { state: 'attention', reason: 'changed' },
    );
    const createWaiting = entryFor(
      { kind: 'create', movieId: fixtureId(901), input: input('Kept Visible') },
      { state: 'attention', reason: 'duplicate' },
    );
    const out = applyOutbox(library, [editWaiting, deleteWaiting, createWaiting], OWNER);
    expect(out.map((m) => m.title).sort()).toEqual(['Alpha', 'Beta', 'Kept Visible']);
  });

  it('an unchanged title keeps its stored normalized spelling (F9); a renamed one gets a new one', () => {
    const legacy = { ...a, normalizedTitle: 'the pope s exorcist', title: "The Pope's Exorcist" };
    const same = entryFor({
      kind: 'update',
      movieId: a.id,
      input: { ...movieToInput(legacy), genre: 'Horror' },
      baseUpdatedAt: legacy.updatedAt,
    });
    expect(applyOutbox([legacy], [same], OWNER)[0]?.normalizedTitle).toBe('the pope s exorcist');
    const renamed = entryFor({
      kind: 'update',
      movieId: a.id,
      input: { ...movieToInput(legacy), title: 'Renamed' },
      baseUpdatedAt: legacy.updatedAt,
    });
    expect(applyOutbox([legacy], [renamed], OWNER)[0]?.normalizedTitle).toBe('renamed');
  });
});

describe('helpers', () => {
  it('outboxStatus separates waiting from needs-a-decision', () => {
    const p = put(undefined, create());
    const q: OutboxEntry = {
      ...put(undefined, { ...update('x'), movieId: fixtureId(501) }),
      state: 'attention',
    };
    const status = outboxStatus([p, q]);
    expect([...status.pending]).toEqual([ID]);
    expect([...status.attention]).toEqual([fixtureId(501)]);
  });

  it('findDuplicateIn compares by the identity rule and can ignore the title being edited', () => {
    const a = buildMovie(
      1,
      ['The Matrix', 'movie', 1999, 'Sci-Fi', 136, 5, '2026-01-01', null],
      OWNER,
    );
    expect(findDuplicateIn([a], input('the  matrix', 1999), null)?.id).toBe(a.id);
    expect(findDuplicateIn([a], input('the matrix', 1999), a.id)).toBeUndefined();
    expect(findDuplicateIn([a], input('the matrix', 2003), null)).toBeUndefined();
  });

  it('holdsValues is true only when every editable field matches', () => {
    const a = buildMovie(1, ['A', 'movie', 2000, 'Drama', 100, 3, '2026-01-01', null], OWNER);
    expect(holdsValues(a, movieToInput(a))).toBe(true);
    for (const patch of [
      { title: 'B' },
      { mediaType: 'tv' as const },
      { year: 2001 },
      { genre: 'x' },
      { runtimeMinutes: 1 },
      { watched: false, watchedOn: null },
      { watchedOn: '2026-02-02' },
      { userRating: 1 },
      { verdict: 'v' },
      { technicalNotes: 'n' },
      { shotLink: 'https://x.test' },
    ]) {
      expect(holdsValues(a, { ...movieToInput(a), ...patch })).toBe(false);
    }
  });

  it('the stored-entry schema rejects inconsistent rows', () => {
    const good = put(undefined, update('x'));
    expect(outboxEntrySchema.safeParse(good).success).toBe(true);
    expect(outboxEntrySchema.safeParse({ ...good, input: null }).success).toBe(false); // edit without values
    expect(outboxEntrySchema.safeParse({ ...good, baseUpdatedAt: null }).success).toBe(false); // edit without a base
    expect(
      outboxEntrySchema.safeParse({ ...put(undefined, del()), input: good.input }).success,
    ).toBe(false);
    expect(
      outboxEntrySchema.safeParse({ ...put(undefined, create()), baseUpdatedAt: 'v' }).success,
    ).toBe(false);
    expect(outboxEntrySchema.safeParse({ ...good, movieId: 'not-a-uuid' }).success).toBe(false);
  });
});
