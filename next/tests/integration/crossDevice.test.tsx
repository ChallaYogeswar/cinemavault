import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MOCK_OWNER_ID, createSeedMovies, fixtureId, generateMovies } from '@/data/mock/fixtures';
import { EMPTY_MOVIE_INPUT, movieToInput } from '@/domain/movieInput';
import type { Movie } from '@/domain/movie';
import { findOrThrow, first, must } from '../helpers';
import { createDevice, type Device } from '../fakes/device';
import { createMigratedDatabase, resetDatabase } from '../fakes/pgliteSupabase';

/**
 * CROSS-DEVICE VALIDATION. Device A → cloud → Device B, on real PostgreSQL with the repository's
 * real migrations, row-level security, unique index and `updated_at` trigger. Each device has its
 * own connection, its own IndexedDB and its own network switch; they share nothing except the
 * database, exactly like two phones.
 */
const OWNER = MOCK_OWNER_ID;
const VIEWER = fixtureId(777);

let db: PGlite;
beforeAll(async () => {
  db = await createMigratedDatabase();
}, 60_000);

let A: Device; // the owner's laptop
let B: Device; // the owner's phone
let seeded: Movie[];

const titles = (movies: readonly Movie[]) => movies.map((m) => m.title).sort();
const opened = async (device: Device) => must(await device.open()).movies;
const named = (movies: readonly Movie[], title: string) =>
  findOrThrow(movies, (m) => m.title === title);

beforeEach(async () => {
  seeded = createSeedMovies(OWNER);
  await resetDatabase(db, seeded, { ownerId: OWNER, viewerId: VIEWER });
  A = createDevice(db, OWNER, 'owner');
  B = createDevice(db, OWNER, 'owner');
}, 60_000);

describe('what one device does shows up on the other', () => {
  it('ADD: a title added on A appears on B, and B’s saved copy follows', async () => {
    const before = await opened(B);
    const created = must(
      await A.repository.create({ ...EMPTY_MOVIE_INPUT, title: 'Added On Laptop', year: 2024 }),
    );

    const after = await opened(B);
    expect(after).toHaveLength(before.length + 1);
    expect(named(after, 'Added On Laptop').id).toBe(created.id);
    expect(await B.saved(after.length)).toHaveLength(after.length);
  });

  it('EDIT: a changed title, genre and runtime reach B with the new version token', async () => {
    const target = first(seeded);
    const seen = named(await opened(B), target.title);
    must(
      await A.repository.update(
        target.id,
        { ...movieToInput(target), genre: 'Edited Genre', runtimeMinutes: 142 },
        target.updatedAt,
      ),
    );

    const now = findOrThrow(await opened(B), (m) => m.id === target.id);
    expect(now.genre).toBe('Edited Genre');
    expect(now.runtimeMinutes).toBe(142);
    expect(now.updatedAt).not.toBe(seen.updatedAt); // the server stamped a new version
    expect(now.updatedAt).toMatch(/\+00:00$/); // the server's own text, passed through verbatim
  });

  it('RATING: a rating changed on A shows on B', async () => {
    const target = findOrThrow(seeded, (m) => m.userRating === null);
    must(
      await A.repository.update(
        target.id,
        { ...movieToInput(target), userRating: 4.5, watched: true, watchedOn: '2026-11-01' },
        target.updatedAt,
      ),
    );
    const now = findOrThrow(await opened(B), (m) => m.id === target.id);
    expect(now.userRating).toBe(4.5);
    expect(now.watched).toBe(true);
  });

  it('DELETE: a title deleted on A disappears from B, from its list AND from its saved copy', async () => {
    const target = first(seeded);
    const before = await opened(B);
    expect(before.some((m) => m.id === target.id)).toBe(true);
    await B.saved(before.length);

    must(await A.repository.remove(target.id, target.updatedAt));

    const after = await opened(B);
    expect(after.some((m) => m.id === target.id)).toBe(false);
    const copy = await B.saved(before.length - 1);
    expect(copy?.some((m) => m.id === target.id)).toBe(false); // a stale copy cannot resurrect it
  });

  it('keeps a production-sized library consistent across devices', async () => {
    const big = generateMovies(3_243, OWNER);
    await resetDatabase(db, big, { ownerId: OWNER, viewerId: VIEWER });
    const target = first(big);
    expect(await opened(A)).toHaveLength(3_243);
    expect(await opened(B)).toHaveLength(3_243);
    must(
      await A.repository.update(
        target.id,
        { ...movieToInput(target), verdict: 'Rewatch' },
        target.updatedAt,
      ),
    );
    const onB = await opened(B);
    expect(onB).toHaveLength(3_243);
    expect(findOrThrow(onB, (m) => m.id === target.id).verdict).toBe('Rewatch');
    expect(await B.saved(3_243)).toHaveLength(3_243);
  }, 120_000);

  it('each device keeps its own saved copy; one device’s copy never changes the other’s', async () => {
    await opened(A);
    await opened(B);
    await A.saved();
    await B.saved();
    must(
      await A.repository.create({ ...EMPTY_MOVIE_INPUT, title: 'Only A Sees It Yet', year: 2020 }),
    );
    await opened(A); // A refreshes; B does not
    const a = await A.saved(seeded.length + 1);
    const b = await B.saved(seeded.length);
    expect(a).toHaveLength(seeded.length + 1);
    expect(b).toHaveLength(seeded.length);
    expect(titles(b ?? [])).not.toContain('Only A Sees It Yet');
  });
});

describe('a device that was away', () => {
  it('shows its last saved copy while offline, then the server’s truth when back', async () => {
    const before = await opened(B);
    await B.saved(before.length);
    B.net.down = true;

    // While B is away, A adds, edits and deletes.
    const edited = first(seeded);
    const deleted = findOrThrow(seeded, (m) => m.id !== edited.id);
    must(
      await A.repository.create({ ...EMPTY_MOVIE_INPUT, title: 'Added While B Away', year: 2025 }),
    );
    must(
      await A.repository.update(
        edited.id,
        { ...movieToInput(edited), genre: 'Changed While Away' },
        edited.updatedAt,
      ),
    );
    must(await A.repository.remove(deleted.id, deleted.updatedAt));

    // B, offline, shows exactly what it last saw: stale on purpose, and labelled as saved.
    const offline = must(await B.open());
    expect(offline.source.origin).toBe('cache');
    expect(titles(offline.movies)).toEqual(titles(before));
    expect(findOrThrow(offline.movies, (m) => m.id === edited.id).genre).toBe(edited.genre);

    // B reconnects and the server's version replaces it.
    B.net.down = false;
    const online = must(await B.open());
    expect(online.source.origin).toBe('network');
    expect(titles(online.movies)).toContain('Added While B Away');
    expect(online.movies.some((m) => m.id === deleted.id)).toBe(false);
    expect(findOrThrow(online.movies, (m) => m.id === edited.id).genre).toBe('Changed While Away');
    expect(await B.saved(online.movies.length)).toHaveLength(online.movies.length);
  });

  it('a device that never loaded anything has nothing to show offline, rather than someone else’s data', async () => {
    await opened(A);
    await A.saved();
    B.net.down = true;
    expect(await B.open()).toMatchObject({ ok: false, error: { code: 'network' } });
  });
});

describe('two devices editing the same title (the stored version token decides)', () => {
  it('B’s edit of an out-of-date title is refused, and A’s change survives', async () => {
    const target = first(seeded);
    const onB = named(await opened(B), target.title); // B opens the edit form here

    must(
      await A.repository.update(
        target.id,
        { ...movieToInput(target), verdict: 'A was first' },
        target.updatedAt,
      ),
    );

    const result = await B.repository.update(
      target.id,
      { ...movieToInput(onB), verdict: 'B was late' },
      onB.updatedAt,
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(findOrThrow(await opened(B), (m) => m.id === target.id).verdict).toBe('A was first');
  });

  it('B cannot rate or delete a title whose version A has since changed', async () => {
    const target = first(seeded);
    const onB = named(await opened(B), target.title);
    must(
      await A.repository.update(
        target.id,
        { ...movieToInput(target), genre: 'Moved On' },
        target.updatedAt,
      ),
    );

    expect(
      await B.repository.update(target.id, { ...movieToInput(onB), userRating: 1 }, onB.updatedAt),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await B.repository.remove(target.id, onB.updatedAt)).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    expect(findOrThrow(await opened(B), (m) => m.id === target.id).genre).toBe('Moved On');
  });

  it('an edit to a title another device deleted is refused, not resurrected', async () => {
    const target = first(seeded);
    const onB = named(await opened(B), target.title);
    must(await A.repository.remove(target.id, target.updatedAt));

    const result = await B.repository.update(
      target.id,
      { ...movieToInput(onB), verdict: 'Too late' },
      onB.updatedAt,
    );
    expect(result.ok).toBe(false);
    expect((await opened(B)).some((m) => m.id === target.id)).toBe(false);
  });

  it('the same new title added on both devices at once: one is kept, the other told it is a duplicate', async () => {
    const input = { ...EMPTY_MOVIE_INPUT, title: 'Race For The Same Title', year: 2024 };
    const [fromA, fromB] = await Promise.all([
      A.repository.create(input),
      B.repository.create(input),
    ]);
    expect([fromA.ok, fromB.ok].filter(Boolean)).toHaveLength(1);
    const loser = fromA.ok ? fromB : fromA;
    expect(loser).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect((await opened(A)).filter((m) => m.title === input.title)).toHaveLength(1);
  });
});

describe('a second person on another device (the view-only account)', () => {
  it('sees what the owner adds, edits and deletes, and can change nothing', async () => {
    const viewer = createDevice(db, VIEWER, 'viewer');
    const before = await opened(viewer);
    expect(before).toHaveLength(seeded.length);

    const created = must(
      await A.repository.create({ ...EMPTY_MOVIE_INPUT, title: 'For The Viewer', year: 2023 }),
    );
    const gone = first(seeded);
    must(await A.repository.remove(gone.id, gone.updatedAt));

    const after = await opened(viewer);
    expect(after.some((m) => m.id === created.id)).toBe(true);
    expect(after.some((m) => m.id === gone.id)).toBe(false);
    expect(await viewer.saved(after.length)).toHaveLength(after.length);

    const attempt = await viewer.repository.update(
      created.id,
      { ...movieToInput(created), verdict: 'Viewer was here' },
      created.updatedAt,
    );
    expect(attempt).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('the viewer’s device has its own saved copy, separate from the owner’s', async () => {
    const viewer = createDevice(db, VIEWER, 'viewer');
    await opened(viewer);
    await opened(A);
    expect(viewer.factory).not.toBe(A.factory);
    expect(await viewer.saved()).not.toBeNull();
  });
});
