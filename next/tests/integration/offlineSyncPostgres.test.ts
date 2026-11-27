import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MOCK_OWNER_ID, createSeedMovies, fixtureId } from '@/data/mock/fixtures';
import { movieToInput } from '@/domain/movieInput';
import { EMPTY_MOVIE_INPUT } from '@/domain/movieInput';
import type { Movie } from '@/domain/movie';
import { first, findOrThrow, must } from '../helpers';
import { createDevice, type Device } from '../fakes/device';
import { createMigratedDatabase, resetDatabase } from '../fakes/pgliteSupabase';

/**
 * OFFLINE EDITING, on real PostgreSQL (the repository's real migrations, row-level security,
 * unique index and `updated_at` trigger). Device A queues changes while its network is down and
 * sends them when it is back; device B is "someone else" editing the same library meanwhile.
 */
const OWNER = MOCK_OWNER_ID;
const VIEWER = fixtureId(777);
let db: PGlite;
beforeAll(async () => {
  db = await createMigratedDatabase();
}, 60_000);

let A: Device;
let B: Device;
let seeded: Movie[];
const live = async () => must(await B.repository.list());
const input = (title: string, year = 2024) => ({ ...EMPTY_MOVIE_INPUT, title, year });
const ADDED = fixtureId(8001);

beforeEach(async () => {
  seeded = createSeedMovies(OWNER);
  await resetDatabase(db, seeded, { ownerId: OWNER, viewerId: VIEWER });
  A = createDevice(db, OWNER, 'owner');
  B = createDevice(db, OWNER, 'owner');
}, 60_000);

const queue = async (device: Device, op: Parameters<Device['outbox']['enqueue']>[1]) => {
  const r = await device.outbox.enqueue(OWNER, op, new Date());
  expect(r.ok).toBe(true);
};

describe('a change made offline reaches the server exactly once', () => {
  it('ADD: queued offline, sent on reconnect with the id chosen at the time', async () => {
    A.net.down = true;
    await queue(A, { kind: 'create', movieId: ADDED, input: input('Added On A Plane') });
    expect(await A.sync()).toMatchObject({ applied: 0, stoppedBy: 'offline' }); // still offline: nothing lost
    expect(await A.outbox.list(OWNER)).toHaveLength(1);

    A.net.down = false;
    expect(await A.sync()).toMatchObject({ applied: 1, needAttention: 0, stoppedBy: null });
    const row = findOrThrow(await live(), (m) => m.title === 'Added On A Plane');
    expect(row.id).toBe(ADDED);
    expect(await A.outbox.list(OWNER)).toEqual([]);
  });

  it('a send whose REPLY was lost is not sent as a second copy: replaying finds its own earlier success', async () => {
    // The server accepts the create, but A never hears back and still has it queued.
    must(await B.repository.create(input('Landed Already'), { id: ADDED })); // same effect as A's first attempt
    await queue(A, { kind: 'create', movieId: ADDED, input: input('Landed Already') });
    const before = (await live()).length;
    expect(await A.sync()).toMatchObject({ applied: 1, needAttention: 0 });
    expect(await live()).toHaveLength(before); // still exactly one
    expect(await A.outbox.list(OWNER)).toEqual([]);
  });

  it('running the sync twice (or concurrently) never duplicates', async () => {
    await queue(A, { kind: 'create', movieId: ADDED, input: input('Twice') });
    const [r1, r2] = await Promise.all([A.sync(), A.sync()]);
    expect(r1.applied + r2.applied).toBeGreaterThanOrEqual(1);
    expect((await live()).filter((m) => m.title === 'Twice')).toHaveLength(1);
    expect(await A.sync()).toMatchObject({ applied: 0 });
  });

  it('EDIT: applied against the version the person saw', async () => {
    const target = first(seeded);
    await queue(A, {
      kind: 'update',
      movieId: target.id,
      input: { ...movieToInput(target), genre: 'Edited Offline' },
      baseUpdatedAt: target.updatedAt,
    });
    expect(await A.sync()).toMatchObject({ applied: 1 });
    expect(findOrThrow(await live(), (m) => m.id === target.id).genre).toBe('Edited Offline');
  });

  it('an edit whose reply was lost is recognised (the server already holds exactly those values)', async () => {
    const target = first(seeded);
    const wanted = { ...movieToInput(target), genre: 'Landed' };
    must(await B.repository.update(target.id, wanted, target.updatedAt)); // moved the version on
    await queue(A, {
      kind: 'update',
      movieId: target.id,
      input: wanted,
      baseUpdatedAt: target.updatedAt,
    });
    expect(await A.sync()).toMatchObject({ applied: 1, needAttention: 0 });
  });

  it('DELETE: soft-deletes, and deleting something already gone is a success', async () => {
    const target = first(seeded);
    await queue(A, {
      kind: 'delete',
      movieId: target.id,
      baseUpdatedAt: target.updatedAt,
      title: target.title,
    });
    expect(await A.sync()).toMatchObject({ applied: 1 });
    expect((await live()).some((m) => m.id === target.id)).toBe(false);

    const other = seeded[1];
    if (!other) throw new Error('seed');
    must(await B.repository.remove(other.id, other.updatedAt));
    await queue(A, {
      kind: 'delete',
      movieId: other.id,
      baseUpdatedAt: other.updatedAt,
      title: other.title,
    });
    expect(await A.sync()).toMatchObject({ applied: 1, needAttention: 0 });
  });

  it('several changes are all sent, in the order they were made', async () => {
    const [t0, t1] = seeded;
    if (!t0 || !t1) throw new Error('seed');
    await queue(A, { kind: 'create', movieId: ADDED, input: input('New A') });
    await queue(A, {
      kind: 'update',
      movieId: t0.id,
      input: { ...movieToInput(t0), genre: 'G0' },
      baseUpdatedAt: t0.updatedAt,
    });
    await queue(A, {
      kind: 'delete',
      movieId: t1.id,
      baseUpdatedAt: t1.updatedAt,
      title: t1.title,
    });
    expect(await A.sync()).toMatchObject({ applied: 3, needAttention: 0 });
    const now = await live();
    expect(now.some((m) => m.title === 'New A')).toBe(true);
    expect(findOrThrow(now, (m) => m.id === t0.id).genre).toBe('G0');
    expect(now.some((m) => m.id === t1.id)).toBe(false);
  });
});

describe('conflicts are never settled by guessing', () => {
  it('EDIT vs EDIT elsewhere: the other version is untouched and the change waits for the person', async () => {
    const target = first(seeded);
    await queue(A, {
      kind: 'update',
      movieId: target.id,
      input: { ...movieToInput(target), genre: 'Mine' },
      baseUpdatedAt: target.updatedAt,
    });
    must(
      await B.repository.update(
        target.id,
        { ...movieToInput(target), genre: 'Theirs' },
        target.updatedAt,
      ),
    );

    expect(await A.sync()).toMatchObject({ applied: 0, needAttention: 1 });
    expect(findOrThrow(await live(), (m) => m.id === target.id).genre).toBe('Theirs'); // not overwritten
    expect(first(await A.outbox.list(OWNER))).toMatchObject({
      state: 'attention',
      reason: 'changed',
    });
    // ...and it is not retried behind the person's back
    expect(await A.sync()).toMatchObject({ applied: 0, needAttention: 0 });
    expect(findOrThrow(await live(), (m) => m.id === target.id).genre).toBe('Theirs');
  });

  it('"keep mine" replaces the other change on purpose, against the version the server holds now', async () => {
    const target = first(seeded);
    await queue(A, {
      kind: 'update',
      movieId: target.id,
      input: { ...movieToInput(target), genre: 'Mine' },
      baseUpdatedAt: target.updatedAt,
    });
    must(
      await B.repository.update(
        target.id,
        { ...movieToInput(target), genre: 'Theirs' },
        target.updatedAt,
      ),
    );
    await A.sync();
    const current = must(await A.repository.get(target.id));
    expect(await A.outbox.keepMine(OWNER, target.id, current.updatedAt)).toBe(true);
    expect(await A.sync()).toMatchObject({ applied: 1 });
    expect(findOrThrow(await live(), (m) => m.id === target.id).genre).toBe('Mine');
  });

  it('"use the other version" just forgets the change', async () => {
    const target = first(seeded);
    await queue(A, {
      kind: 'update',
      movieId: target.id,
      input: { ...movieToInput(target), genre: 'Mine' },
      baseUpdatedAt: target.updatedAt,
    });
    must(await B.repository.remove(target.id, target.updatedAt));
    await A.sync();
    expect(first(await A.outbox.list(OWNER))).toMatchObject({ state: 'attention', reason: 'gone' });
    await A.outbox.discard(OWNER, target.id);
    expect(await A.outbox.list(OWNER)).toEqual([]);
    expect((await live()).some((m) => m.id === target.id)).toBe(false);
  });

  it('DELETE of a title edited elsewhere is not carried out', async () => {
    const target = first(seeded);
    await queue(A, {
      kind: 'delete',
      movieId: target.id,
      baseUpdatedAt: target.updatedAt,
      title: target.title,
    });
    must(
      await B.repository.update(
        target.id,
        { ...movieToInput(target), genre: 'Edited Meanwhile' },
        target.updatedAt,
      ),
    );
    expect(await A.sync()).toMatchObject({ applied: 0, needAttention: 1 });
    expect((await live()).some((m) => m.id === target.id)).toBe(true);
  });

  it('ADD of a title that was added elsewhere meanwhile is a duplicate, not a second copy', async () => {
    must(await B.repository.create(input('Same Name')));
    await queue(A, { kind: 'create', movieId: ADDED, input: input('Same Name') });
    expect(await A.sync()).toMatchObject({ applied: 0, needAttention: 1 });
    expect(first(await A.outbox.list(OWNER))).toMatchObject({
      state: 'attention',
      reason: 'duplicate',
    });
    expect((await live()).filter((m) => m.title === 'Same Name')).toHaveLength(1);
  });

  it('one refused change does not block the others', async () => {
    const [t0, t1] = seeded;
    if (!t0 || !t1) throw new Error('seed');
    await queue(A, {
      kind: 'update',
      movieId: t0.id,
      input: { ...movieToInput(t0), genre: 'Mine' },
      baseUpdatedAt: t0.updatedAt,
    });
    await queue(A, {
      kind: 'update',
      movieId: t1.id,
      input: { ...movieToInput(t1), genre: 'Also Mine' },
      baseUpdatedAt: t1.updatedAt,
    });
    must(await B.repository.update(t0.id, { ...movieToInput(t0), genre: 'Theirs' }, t0.updatedAt));
    expect(await A.sync()).toMatchObject({ applied: 1, needAttention: 1 });
    expect(findOrThrow(await live(), (m) => m.id === t1.id).genre).toBe('Also Mine');
  });
});

describe('permissions are enforced by the server, not by what the device remembered', () => {
  it('a demoted owner’s queued changes are refused by row-level security and kept for review', async () => {
    const target = first(seeded);
    const demoted = createDevice(db, OWNER, 'viewer'); // the account is now view-only
    await queue(demoted, {
      kind: 'update',
      movieId: target.id,
      input: { ...movieToInput(target), genre: 'Sneaky' },
      baseUpdatedAt: target.updatedAt,
    });
    expect(await demoted.sync()).toMatchObject({ applied: 0, needAttention: 1 });
    expect(first(await demoted.outbox.list(OWNER))).toMatchObject({
      state: 'attention',
      reason: 'refused',
    });
    expect(findOrThrow(await live(), (m) => m.id === target.id).genre).not.toBe('Sneaky');
  });
});
