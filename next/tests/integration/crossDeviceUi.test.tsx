import type { PGlite } from '@electric-sql/pglite';
import { focusManager, onlineManager } from '@tanstack/react-query';
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeedMovies } from '@/data/mock/fixtures';
import { EMPTY_MOVIE_INPUT, movieToInput } from '@/domain/movieInput';
import type { Movie } from '@/domain/movie';
import { at, first, must } from '../helpers';
import { createDevice, type Device } from '../fakes/device';
import { createFakeAuth } from '../fakes/fakeAuthService';
import { createFakeProfiles } from '../fakes/fakeProfiles';
import { createMigratedDatabase, resetDatabase } from '../fakes/pgliteSupabase';
import { FRIEND_ID, OWNER_ID, renderFullApp } from '../renderFullApp';
import { cardName } from '../cardName';

/**
 * Device B is the WHOLE APP (sign-in, session, role, query cache, saved copy) on a real Postgres
 * database; device A is another phone changing the same library. What B's screen shows after A
 * has acted is what the person would see.
 */
let db: PGlite;
beforeAll(async () => {
  db = await createMigratedDatabase();
}, 60_000);

let A: Device;
let B: Device;
let seeded: Movie[];
const label = (m: Movie) => `${m.title} (${String(m.year)})`;
const link = (name: string) => screen.findByRole('link', { name: cardName(name) });
const missing = (name: string) => screen.queryByRole('link', { name: cardName(name) });

beforeEach(async () => {
  seeded = createSeedMovies(OWNER_ID);
  await resetDatabase(db, seeded, { ownerId: OWNER_ID, viewerId: FRIEND_ID });
  A = createDevice(db, OWNER_ID, 'owner');
  B = createDevice(db, OWNER_ID, 'owner');
}, 60_000);
afterEach(() => {
  vi.useRealTimers();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
});

const openOnB = () =>
  renderFullApp({
    auth: createFakeAuth(
      [{ id: OWNER_ID, email: 'o@example.com', password: 'pw-123456' }],
      OWNER_ID,
    ),
    profiles: createFakeProfiles({ [OWNER_ID]: { role: 'owner' } }),
    repositoryFor: () => B.repository,
    cache: B.cache,
  });

describe('device B’s screen follows what device A does', () => {
  it('add, rename and delete on A appear on B when B’s tab is next used', async () => {
    const renamed = at(seeded, 1);
    const deleted = at(seeded, 2);
    const untouched = first(seeded);
    vi.useFakeTimers({ toFake: ['Date'] });
    openOnB();
    await link(label(untouched));
    expect(missing('Added On The Laptop (2024)')).not.toBeInTheDocument();

    must(
      await A.repository.create({ ...EMPTY_MOVIE_INPUT, title: 'Added On The Laptop', year: 2024 }),
    );
    must(
      await A.repository.update(
        renamed.id,
        { ...movieToInput(renamed), title: 'Renamed On The Laptop' },
        renamed.updatedAt,
      ),
    );
    must(await A.repository.remove(deleted.id, deleted.updatedAt));

    focusManager.setFocused(false);
    vi.setSystemTime(Date.now() + 31_000); // past the 30 s freshness window
    focusManager.setFocused(true);

    expect(await link('Added On The Laptop (2024)')).toBeInTheDocument();
    await waitFor(() => {
      expect(missing(label(deleted))).not.toBeInTheDocument();
      expect(missing(label(renamed))).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole('link', {
        name: cardName(`Renamed On The Laptop (${String(renamed.year)})`),
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: cardName(label(untouched)) })).toBeInTheDocument();
  });

  it('B, offline, shows what it last saw; on reconnecting it catches up with everything A did', async () => {
    const deleted = at(seeded, 2);
    const first1 = openOnB();
    await link(label(first(seeded)));
    await B.saved(seeded.length);
    first1.unmount();

    must(
      await A.repository.create({
        ...EMPTY_MOVIE_INPUT,
        title: 'Added While B Was Away',
        year: 2025,
      }),
    );
    must(await A.repository.remove(deleted.id, deleted.updatedAt));

    B.net.down = true;
    onlineManager.setOnline(false);
    openOnB();
    expect(await link(label(deleted))).toBeInTheDocument(); // stale on purpose
    expect(await screen.findByText(/can’t reach the server/i)).toBeInTheDocument();
    expect(missing('Added While B Was Away (2025)')).not.toBeInTheDocument();

    B.net.down = false;
    act(() => {
      onlineManager.setOnline(true);
    });
    expect(await link('Added While B Was Away (2025)')).toBeInTheDocument();
    await waitFor(() => {
      expect(missing(label(deleted))).not.toBeInTheDocument();
      expect(screen.queryByText(/can’t reach the server/i)).not.toBeInTheDocument();
    });
  });
});
