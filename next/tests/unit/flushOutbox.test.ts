import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDexieDeviceStore } from '@/data/local/dexieLibraryCache';
import { MOCK_OWNER_ID, createSeedMovies, fixtureId } from '@/data/mock/fixtures';
import { createMockMovieRepository } from '@/data/mock/mockMovieRepository';
import type { MovieRepository } from '@/data/repositories/movieRepository';
import { createOutboxSync, flushOutbox } from '@/data/sync/flushOutbox';
import { EMPTY_MOVIE_INPUT, movieToInput } from '@/domain/movieInput';
import type { QueueOp } from '@/domain/outbox';
import { first } from '../helpers';

const USER = MOCK_OWNER_ID;
let store: ReturnType<typeof createDexieDeviceStore>;
let repo: ReturnType<typeof createMockMovieRepository>;
const ids = [fixtureId(801), fixtureId(802), fixtureId(803)] as const;
const input = (title: string) => ({ ...EMPTY_MOVIE_INPUT, title, year: 2024 });
const create = (id: string, title: string): QueueOp => ({
  kind: 'create',
  movieId: id,
  input: input(title),
});
const enqueue = (op: QueueOp) => store.outbox.enqueue(USER, op, new Date());
const run = (overrides: Partial<Parameters<typeof flushOutbox>[0]> = {}) =>
  flushOutbox({
    repository: repo,
    store: store.outbox,
    userId: USER,
    isCurrent: () => true,
    ...overrides,
  });

beforeEach(() => {
  store = createDexieDeviceStore({ indexedDB: new IDBFactory(), IDBKeyRange });
  repo = createMockMovieRepository({ seed: createSeedMovies(USER) });
});

describe('flushOutbox', () => {
  it('with nothing waiting does nothing', async () => {
    expect(await run()).toEqual({ applied: 0, needAttention: 0, stoppedBy: null });
  });

  it('a connection failure stops the run, keeps EVERYTHING queued, and the next run finishes the job', async () => {
    await enqueue(create(ids[0], 'One'));
    await enqueue(create(ids[1], 'Two'));
    repo.failNext({ code: 'network', message: 'offline' });
    expect(await run()).toMatchObject({ applied: 0, stoppedBy: 'offline' });
    expect(await store.outbox.list(USER)).toHaveLength(2);
    expect(await run()).toMatchObject({ applied: 2, stoppedBy: null });
    expect(await store.outbox.list(USER)).toEqual([]);
  });

  it('an unexpected error or a repository that throws is treated like a lost connection (retry later), never as success', async () => {
    await enqueue(create(ids[0], 'One'));
    const broken: MovieRepository = { ...repo, create: () => Promise.reject(new Error('boom')) };
    expect(await run({ repository: broken })).toMatchObject({ applied: 0, stoppedBy: 'offline' });
    repo.failNext({ code: 'unknown', message: 'x' });
    expect(await run()).toMatchObject({ applied: 0, stoppedBy: 'offline' });
    expect(await store.outbox.list(USER)).toHaveLength(1);
  });

  it('a signed-out answer stops the run and keeps the change', async () => {
    await enqueue(create(ids[0], 'One'));
    repo.failNext({ code: 'unauthenticated', message: 'expired' });
    expect(await run()).toMatchObject({ stoppedBy: 'signed_out' });
    expect(await store.outbox.list(USER)).toHaveLength(1);
  });

  it('stops without sending once the account is no longer current, and applies nothing that was in flight', async () => {
    await enqueue(create(ids[0], 'One'));
    await enqueue(create(ids[1], 'Two'));
    let current = true;
    const slow: MovieRepository = {
      ...repo,
      create: async (value, options) => {
        const result = await repo.create(value, options);
        current = false; // the account changes while the request is out
        return result;
      },
    };
    const outcome = await run({ repository: slow, isCurrent: () => current });
    expect(outcome).toMatchObject({ applied: 0, stoppedBy: 'signed_out' });
    // The second change was never sent.
    expect(repo.snapshot().some((m) => m.title === 'Two')).toBe(false);
    // The first reached the server but its outcome was not applied to this (former) session's store.
    expect(await store.outbox.list(USER)).toHaveLength(2);
  });

  it('a refused change (view-only, invalid, deleted elsewhere) is kept with a reason, in the person’s words', async () => {
    const target = first(repo.snapshot());
    await enqueue({
      kind: 'update',
      movieId: target.id,
      input: movieToInput(target),
      baseUpdatedAt: 'stale',
    });
    await enqueue(create(ids[0], 'Fresh'));
    const viewer = createMockMovieRepository({
      seed: createSeedMovies(USER),
      getRole: () => 'viewer',
    });
    const out = await run({ repository: viewer });
    expect(out).toMatchObject({ applied: 0, needAttention: 2 });
    const entries = await store.outbox.list(USER);
    expect(entries.every((e) => e.state === 'attention' && e.reason === 'refused')).toBe(true);
    expect(entries.every((e) => (e.message ?? '').length > 10)).toBe(true);
  });

  it('a validation failure is kept for editing, not retried forever', async () => {
    await enqueue(create(ids[0], 'One'));
    repo.failNext({ code: 'validation', message: 'bad' });
    expect(await run()).toMatchObject({ needAttention: 1 });
    expect(first(await store.outbox.list(USER))).toMatchObject({
      state: 'attention',
      reason: 'invalid',
    });
    expect(await run()).toMatchObject({ applied: 0, needAttention: 0 }); // attention entries are not resent
  });

  it('an edit made while its predecessor was being sent is sent next, against the version the server just returned', async () => {
    const target = first(repo.snapshot());
    await enqueue({
      kind: 'update',
      movieId: target.id,
      input: { ...movieToInput(target), genre: 'First' },
      baseUpdatedAt: target.updatedAt,
    });
    const racing: MovieRepository = {
      ...repo,
      update: async (id, value, base) => {
        // the person edits again while this request is out
        await enqueue({
          kind: 'update',
          movieId: id,
          input: { ...movieToInput(target), genre: 'Second' },
          baseUpdatedAt: base,
        });
        return repo.update(id, value, base);
      },
    };
    expect(await run({ repository: racing })).toMatchObject({ applied: 1 });
    expect(repo.snapshot().find((m) => m.id === target.id)?.genre).toBe('First');
    expect(await run()).toMatchObject({ applied: 1, needAttention: 0 }); // not a false conflict
    expect(repo.snapshot().find((m) => m.id === target.id)?.genre).toBe('Second');
  });
});

describe('createOutboxSync: one sender at a time', () => {
  it('overlapping requests share one run (plus at most one follow-up), so a change is never sent twice at once', async () => {
    await enqueue(create(ids[0], 'One'));
    let inFlight = 0;
    let peak = 0;
    const counting: MovieRepository = {
      ...repo,
      create: async (value, options) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        const result = await repo.create(value, options);
        inFlight -= 1;
        return result;
      },
    };
    const sync = createOutboxSync({
      repository: counting,
      store: store.outbox,
      userId: USER,
      isCurrent: () => true,
    });
    const all = await Promise.all([sync.flush(), sync.flush(), sync.flush()]);
    expect(peak).toBe(1);
    expect(first(all).applied).toBe(1);
    expect(repo.snapshot().filter((m) => m.title === 'One')).toHaveLength(1);
  });

  it('picks up a change queued while a run was sending', async () => {
    await enqueue(create(ids[0], 'One'));
    const sync = createOutboxSync({
      repository: repo,
      store: store.outbox,
      userId: USER,
      isCurrent: () => true,
    });
    const running = sync.flush();
    await enqueue(create(ids[1], 'Two'));
    void sync.flush(); // asks for another pass
    const total = await running;
    expect(total.applied).toBe(2);
    expect(await store.outbox.list(USER)).toEqual([]);
  });
});
