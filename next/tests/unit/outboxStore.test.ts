import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDexieDeviceStore } from '@/data/local/dexieLibraryCache';
import { MAX_ROLE_AGE_MS } from '@/data/local/outboxStore';
import { cacheDatabaseName } from '@/data/local/scope';
import { MOCK_OWNER_ID, fixtureId, generateMovies } from '@/data/mock/fixtures';
import { EMPTY_MOVIE_INPUT } from '@/domain/movieInput';
import type { QueueOp } from '@/domain/outbox';
import { first } from '../helpers';

const ALICE = fixtureId(0xa11ce);
const BOB = fixtureId(0xb0b);
const M1 = fixtureId(601);
const M2 = fixtureId(602);

let factory: IDBFactory;
let clock: Date;
const make = () => createDexieDeviceStore({ indexedDB: factory, IDBKeyRange, now: () => clock });
const input = (title: string) => ({ ...EMPTY_MOVIE_INPUT, title, year: 2020 });
const create = (id: string, title: string): QueueOp => ({
  kind: 'create',
  movieId: id,
  input: input(title),
});
const update = (id: string, title: string, base = 'v1'): QueueOp => ({
  kind: 'update',
  movieId: id,
  input: input(title),
  baseUpdatedAt: base,
});
const del = (id: string): QueueOp => ({
  kind: 'delete',
  movieId: id,
  baseUpdatedAt: 'v1',
  title: 'T',
});
const names = async () => (await factory.databases()).map((d) => d.name);

beforeEach(() => {
  factory = new IDBFactory();
  clock = new Date('2026-11-13T10:00:00.000Z');
});

describe('outbox store: keeping changes on the device', () => {
  it('keeps a queued change across a restart (a new store on the same IndexedDB)', async () => {
    const first1 = make();
    expect((await first1.outbox.enqueue(ALICE, create(M1, 'Offline Add'), clock)).ok).toBe(true);
    const reopened = await make().outbox.list(ALICE);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toMatchObject({
      movieId: M1,
      kind: 'create',
      title: 'Offline Add',
      state: 'pending',
    });
  });

  it('folds a second change to the same title into the first, atomically', async () => {
    const { outbox } = make();
    await outbox.enqueue(ALICE, create(M1, 'One'), clock);
    await outbox.enqueue(ALICE, update(M1, 'Two'), clock);
    const list = await outbox.list(ALICE);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'create', rev: 2, title: 'Two' });
    // create then delete removes the entry entirely
    expect(await outbox.enqueue(ALICE, del(M1), clock)).toEqual({ ok: true, entry: null });
    expect(await outbox.list(ALICE)).toEqual([]);
  });

  it('many changes made at the same moment all land: none overwrites another', async () => {
    const { outbox } = make();
    const ids = Array.from({ length: 25 }, (_, i) => fixtureId(700 + i));
    await Promise.all(
      ids.map((id, i) => outbox.enqueue(ALICE, create(id, `T${String(i)}`), clock)),
    );
    expect((await outbox.list(ALICE)).map((e) => e.movieId).sort()).toEqual([...ids].sort());
  });

  it('lists oldest first', async () => {
    const { outbox } = make();
    await outbox.enqueue(ALICE, create(M2, 'Second'), new Date('2026-11-13T10:00:05.000Z'));
    await outbox.enqueue(ALICE, create(M1, 'First'), new Date('2026-11-13T10:00:01.000Z'));
    expect((await outbox.list(ALICE)).map((e) => e.title)).toEqual(['First', 'Second']);
  });

  it('reports blocked changes instead of overwriting', async () => {
    const { outbox } = make();
    const queued = await outbox.enqueue(ALICE, update(M1, 'x'), clock);
    if (!queued.ok || !queued.entry) throw new Error('queued');
    await outbox.needsAttention(ALICE, M1, queued.entry.rev, 'changed', 'm');
    expect(await outbox.enqueue(ALICE, update(M1, 'y'), clock)).toEqual({
      ok: false,
      reason: 'blocked_needs_attention',
    });
    expect(first(await outbox.list(ALICE)).title).toBe('x'); // what the person typed is untouched
  });

  it('says plainly when nothing could be kept (not an account id)', async () => {
    const result = await make().outbox.enqueue('not-a-uuid', create(M1, 'x'), clock);
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('a damaged row is skipped when listing, never repaired, and never overwritten by a new change', async () => {
    const store = make();
    await store.outbox.enqueue(ALICE, create(M2, 'Good'), clock);
    const db = new Dexie(cacheDatabaseName(ALICE), { indexedDB: factory, IDBKeyRange });
    db.version(4).stores({
      movies: 'id',
      meta: 'key',
      history: '++seq',
      metadata: 'key, savedAt',
      snoozed: 'movieId, until',
      outbox: 'movieId, queuedAt',
      session: 'key',
    });
    await db.table('outbox').put({ movieId: M1, kind: 'update', rev: 1 }); // missing everything else
    db.close();
    const fresh = make();
    expect((await fresh.outbox.list(ALICE)).map((e) => e.title)).toEqual(['Good']);
    expect(await fresh.outbox.enqueue(ALICE, update(M1, 'x'), clock)).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });
});

describe('settling what the server answered', () => {
  it('removes the entry when the accepted revision is still current', async () => {
    const { outbox } = make();
    const queued = await outbox.enqueue(ALICE, update(M1, 'x'), clock);
    if (!queued.ok || !queued.entry) throw new Error('queued');
    await outbox.settle(ALICE, M1, queued.entry.rev, { updatedAt: 'v2' });
    expect(await outbox.list(ALICE)).toEqual([]);
  });

  it('keeps a change made WHILE the first was being sent, re-based onto what the server now holds', async () => {
    const { outbox } = make();
    const sent = await outbox.enqueue(ALICE, update(M1, 'first edit', 'v1'), clock);
    if (!sent.ok || !sent.entry) throw new Error('queued');
    await outbox.enqueue(ALICE, update(M1, 'second edit', 'v1'), clock); // typed during the send
    await outbox.settle(ALICE, M1, sent.entry.rev, { updatedAt: 'v2' }); // the server accepted the FIRST
    expect(await outbox.list(ALICE)).toMatchObject([
      { kind: 'update', title: 'second edit', baseUpdatedAt: 'v2', state: 'pending' },
    ]);
  });

  it('a create edited while being sent becomes an edit of the title the server now has', async () => {
    const { outbox } = make();
    const sent = await outbox.enqueue(ALICE, create(M1, 'v-one'), clock);
    if (!sent.ok || !sent.entry) throw new Error('queued');
    await outbox.enqueue(ALICE, update(M1, 'v-two', 'ignored'), clock);
    await outbox.settle(ALICE, M1, sent.entry.rev, { updatedAt: 'created-at' });
    expect(await outbox.list(ALICE)).toMatchObject([
      { kind: 'update', title: 'v-two', baseUpdatedAt: 'created-at' },
    ]);
  });

  it('needsAttention for an entry that has since moved on is ignored', async () => {
    const { outbox } = make();
    const sent = await outbox.enqueue(ALICE, update(M1, 'a'), clock);
    if (!sent.ok || !sent.entry) throw new Error('queued');
    await outbox.enqueue(ALICE, update(M1, 'b'), clock);
    await outbox.needsAttention(ALICE, M1, sent.entry.rev, 'changed', 'm');
    expect(first(await outbox.list(ALICE))).toMatchObject({ title: 'b', state: 'pending' });
  });
});

describe('the person’s decisions', () => {
  it('keepMine re-bases an edit onto the given server version and makes it pending again', async () => {
    const { outbox } = make();
    const queued = await outbox.enqueue(ALICE, update(M1, 'mine', 'v1'), clock);
    if (!queued.ok || !queued.entry) throw new Error('queued');
    await outbox.needsAttention(ALICE, M1, queued.entry.rev, 'changed', 'm');
    expect(await outbox.keepMine(ALICE, M1, 'v9')).toBe(true);
    const entry = first(await outbox.list(ALICE));
    expect(entry).toMatchObject({ state: 'pending', baseUpdatedAt: 'v9', title: 'mine' });
    expect(entry.reason).toBeUndefined();
    expect(entry.message).toBeUndefined();
  });

  it('keepMine for an edit needs a server version; a create does not', async () => {
    const { outbox } = make();
    await outbox.enqueue(ALICE, update(M1, 'x'), clock);
    expect(await outbox.keepMine(ALICE, M1, null)).toBe(false);
    await outbox.enqueue(ALICE, create(M2, 'y'), clock);
    expect(await outbox.keepMine(ALICE, M2, null)).toBe(true);
  });

  it('discard removes only that title’s change', async () => {
    const { outbox } = make();
    await outbox.enqueue(ALICE, create(M1, 'a'), clock);
    await outbox.enqueue(ALICE, create(M2, 'b'), clock);
    await outbox.discard(ALICE, M1);
    expect((await outbox.list(ALICE)).map((e) => e.movieId)).toEqual([M2]);
  });
});

describe('accounts and wiping', () => {
  it('one account never sees another’s waiting changes', async () => {
    const { outbox } = make();
    await outbox.enqueue(ALICE, create(M1, 'alice only'), clock);
    expect(await outbox.list(BOB)).toEqual([]);
  });

  it('signing out (retainOnly(null)) deletes waiting changes with the rest of the account’s data', async () => {
    const store = make();
    await store.outbox.enqueue(ALICE, create(M1, 'x'), clock);
    await store.roles.put(ALICE, 'owner', clock);
    await store.library.retainOnly(null);
    expect(await names()).toEqual([]);
    expect(await make().outbox.list(ALICE)).toEqual([]);
    expect(await make().roles.get(ALICE)).toBeNull();
  });

  it('switching to another account deletes the first one’s waiting changes', async () => {
    const store = make();
    await store.outbox.enqueue(ALICE, create(M1, 'x'), clock);
    await store.library.retainOnly(BOB);
    expect(await make().outbox.list(ALICE)).toEqual([]);
  });
});

describe('a damaged saved library must not take waiting changes with it', () => {
  it('rows without their meta record are dropped, the waiting change stays', async () => {
    const store = make();
    await store.library.write(ALICE, generateMovies(5, MOCK_OWNER_ID));
    await store.outbox.enqueue(ALICE, create(M1, 'precious'), clock);
    const db = new Dexie(cacheDatabaseName(ALICE), { indexedDB: factory, IDBKeyRange });
    db.version(4).stores({
      movies: 'id',
      meta: 'key',
      history: '++seq',
      metadata: 'key, savedAt',
      snoozed: 'movieId, until',
      outbox: 'movieId, queuedAt',
      session: 'key',
    });
    await db.table('meta').clear(); // movies without the record that vouches for them
    db.close();
    const fresh = make();
    expect(await fresh.library.read(ALICE)).toBeNull();
    expect((await fresh.outbox.list(ALICE)).map((e) => e.title)).toEqual(['precious']);
  });

  it('an expired saved library is dropped, the waiting change stays', async () => {
    const store = make();
    await store.library.write(ALICE, generateMovies(3, MOCK_OWNER_ID));
    await store.outbox.enqueue(ALICE, create(M1, 'precious'), clock);
    clock = new Date(clock.getTime() + 40 * 24 * 60 * 60 * 1000);
    expect(await store.library.read(ALICE)).toBeNull();
    expect(await store.outbox.list(ALICE)).toHaveLength(1);
  });

  it('with nothing waiting, a damaged copy still deletes the whole database as before', async () => {
    const store = make();
    await store.library.write(ALICE, generateMovies(3, MOCK_OWNER_ID));
    clock = new Date(clock.getTime() + 40 * 24 * 60 * 60 * 1000);
    expect(await store.library.read(ALICE)).toBeNull();
    expect(await names()).not.toContain(cacheDatabaseName(ALICE));
  });
});

describe('the last confirmed role', () => {
  it('round-trips, and is per account', async () => {
    const { roles } = make();
    await roles.put(ALICE, 'owner', clock);
    expect(await roles.get(ALICE)).toMatchObject({ role: 'owner' });
    expect(await roles.get(BOB)).toBeNull();
  });

  it('is not used once it is too old, or if the clock says it is from the future', async () => {
    const { roles } = make();
    await roles.put(ALICE, 'owner', clock);
    clock = new Date(clock.getTime() + MAX_ROLE_AGE_MS + 1000);
    expect(await roles.get(ALICE)).toBeNull();
    clock = new Date('2026-11-13T09:00:00.000Z'.replace('09', '03'));
    await roles.put(BOB, 'owner', new Date('2027-01-01T00:00:00.000Z'));
    expect(await roles.get(BOB)).toBeNull();
  });

  it('an unknown stored role is ignored (fail closed)', async () => {
    const store = make();
    await store.roles.put(ALICE, 'owner', clock);
    const db = new Dexie(cacheDatabaseName(ALICE), { indexedDB: factory, IDBKeyRange });
    db.version(4).stores({
      movies: 'id',
      meta: 'key',
      history: '++seq',
      metadata: 'key, savedAt',
      snoozed: 'movieId, until',
      outbox: 'movieId, queuedAt',
      session: 'key',
    });
    await db.table('session').put({ key: 'role', role: 'admin', savedAt: clock.toISOString() });
    db.close();
    expect(await make().roles.get(ALICE)).toBeNull();
  });
});
