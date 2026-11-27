import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { onlineManager } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDexieDeviceStore } from '@/data/local/dexieLibraryCache';
import { cacheDatabaseName } from '@/data/local/scope';
import { buildMovie } from '@/data/mock/fixtures';
import {
  createMockMovieRepository,
  type MockMovieRepository,
} from '@/data/mock/mockMovieRepository';
import type { MovieRepository } from '@/data/repositories/movieRepository';
import type { Movie } from '@/domain/movie';
import { err, type Result } from '@/domain/result';
import { cardName } from '../cardName';
import { createFakeAuth } from '../fakes/fakeAuthService';
import { createFakeProfiles, networkFailure } from '../fakes/fakeProfiles';
import { first } from '../helpers';
import { OWNER_ID, FRIEND_ID, renderFullApp } from '../renderFullApp';

/**
 * OFFLINE EDITING, through the whole application. The "server" is one persistent in-memory
 * repository that survives app restarts (as a real database would); the device is a real Dexie
 * store on a fake IndexedDB that also survives them (as a phone's storage would).
 */
const accounts = () => [
  { id: OWNER_ID, email: 'owner@example.com', password: 'pw-owner-1' },
  { id: FRIEND_ID, email: 'friend@example.com', password: 'pw-friend-2' },
];
const roles = { [OWNER_ID]: { role: 'owner' }, [FRIEND_ID]: { role: 'viewer' } };
const movie = (n: number, title: string): Movie =>
  buildMovie(500 + n, [title, 'movie', 2000 + n, 'Drama', 100, 3, '2026-01-01', null], OWNER_ID);

let factory: IDBFactory;
let server: MockMovieRepository;
const net = { down: false };
const goOffline = () => {
  net.down = true;
  onlineManager.setOnline(false);
};
const goOnline = () => {
  net.down = false;
  onlineManager.setOnline(true);
  window.dispatchEvent(new Event('online')); // what the browser does
};

const makeDevice = () => createDexieDeviceStore({ indexedDB: factory, IDBKeyRange });
/** Reads keep working; writes can fail outright ('down') or be applied with the reply lost ('lose'). */
const faults: { writes: 'ok' | 'down' | 'lose' } = { writes: 'ok' };
const gated = (repo: MovieRepository): MovieRepository => {
  const gate = <T,>(run: () => Promise<Result<T>>): Promise<Result<T>> =>
    net.down ? Promise.resolve(err('network', 'Couldn’t reach the server.')) : run();
  const write = async <T,>(run: () => Promise<Result<T>>): Promise<Result<T>> => {
    if (net.down || faults.writes === 'down') return err('network', 'Couldn’t reach the server.');
    const result = await run();
    // The server did the work, but the answer never arrives.
    return faults.writes === 'lose' ? err('network', 'Couldn’t reach the server.') : result;
  };
  return {
    list: () => gate(() => repo.list()),
    get: (id) => gate(() => repo.get(id)),
    create: (input, options) => write(() => repo.create(input, options)),
    createMany: (inputs) => write(() => repo.createMany(inputs)),
    update: (id, input, at) => write(() => repo.update(id, input, at)),
    remove: (id, at) => write(() => repo.remove(id, at)),
  };
};

const boot = (
  userId: string | null,
  kept: {
    auth?: ReturnType<typeof createFakeAuth>;
    profiles?: ReturnType<typeof createFakeProfiles>;
    device?: ReturnType<typeof makeDevice>;
  } = {},
  path = '/library',
) => {
  const auth = kept.auth ?? createFakeAuth(accounts(), userId);
  const profiles = kept.profiles ?? createFakeProfiles(roles);
  const device = kept.device ?? makeDevice();
  const app = renderFullApp({
    auth,
    profiles,
    path,
    cache: device.library,
    device: { history: null, metadata: null, outbox: device.outbox, roles: device.roles },
    repositoryFor: () => gated(server),
  });
  return { ...app, auth, profiles, device };
};

const card = (name: string) => screen.findByRole('link', { name: cardName(name) });
const waitingBanner = () => screen.queryByText(/saved on this device and waiting to sync/i);
const addLink = () => screen.queryByRole('link', { name: /add movie/i });
const serverTitles = async () =>
  (await server.list()).ok
    ? server
        .snapshot()
        .filter((m) => m.deletedAt === null)
        .map((m) => m.title)
        .sort()
    : [];

/** A session that signed in online, so the device holds a saved library and the confirmed role. */
const onlineFirst = async (userId = OWNER_ID) => {
  const first1 = boot(userId);
  await card('Alpha Saved (2001)');
  await waitFor(async () => {
    expect(await first1.device.library.read(userId)).not.toBeNull();
    expect(await first1.device.roles.get(userId)).not.toBeNull();
  });
  first1.unmount();
  return { auth: first1.auth, profiles: first1.profiles, device: first1.device };
};

/** Reopen the app with no connection, as a phone does on a train. */
const reopenOffline = (kept: Awaited<ReturnType<typeof onlineFirst>>, path = '/library') => {
  goOffline();
  kept.profiles.failNext(networkFailure);
  return boot(OWNER_ID, kept, path);
};

const addOffline = async (user: ReturnType<typeof boot>['user'], title: string, year: string) => {
  await user.click(await screen.findByRole('link', { name: /add movie/i }));
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText('Title'), title);
  await user.type(within(dialog).getByLabelText('Year'), year);
  await user.click(within(dialog).getByRole('button', { name: /add to library/i }));
};

beforeEach(() => {
  factory = new IDBFactory();
  server = createMockMovieRepository({
    seed: [movie(1, 'Alpha Saved'), movie(2, 'Beta Saved')],
    ownerId: OWNER_ID,
  });
  net.down = false;
  faults.writes = 'ok';
  onlineManager.setOnline(true);
});
afterEach(() => {
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  onlineManager.setOnline(true);
});

describe('adding a title offline', () => {
  it('is accepted, shown at once as not yet synced, and sent exactly once when the connection returns', async () => {
    const kept = await onlineFirst();
    const { user } = reopenOffline(kept);
    await card('Alpha Saved (2001)');
    expect(await screen.findByText(/can’t reach the server/i)).toHaveTextContent(
      /you can still add/i,
    );

    await addOffline(user, 'Written On A Train', '2024');
    expect(await screen.findByText(/saved on this device and will sync/i)).toBeInTheDocument();
    expect(await card('Written On A Train (2024)')).toBeInTheDocument();
    expect(await screen.findByText('Not synced')).toBeInTheDocument();
    expect(
      await screen.findByText(/1 change is saved on this device and waiting to sync/i),
    ).toBeInTheDocument();
    expect(await serverTitles()).toEqual(['Alpha Saved', 'Beta Saved']); // nothing reached the server

    act(() => {
      goOnline();
    });
    await waitFor(async () => {
      expect(await serverTitles()).toContain('Written On A Train');
    });
    await waitFor(() => {
      expect(waitingBanner()).not.toBeInTheDocument();
      expect(screen.queryByText('Not synced')).not.toBeInTheDocument();
    });
    expect(await card('Written On A Train (2024)')).toBeInTheDocument();
    expect((await serverTitles()).filter((t) => t === 'Written On A Train')).toHaveLength(1);
    expect(await kept.device.outbox.list(OWNER_ID)).toEqual([]);
  });

  it('survives closing the app: reopened offline, the title and the waiting notice are still there', async () => {
    const kept = await onlineFirst();
    const session = reopenOffline(kept);
    await card('Alpha Saved (2001)');
    await addOffline(session.user, 'Survives Restart', '2022');
    await card('Survives Restart (2022)');
    session.unmount();

    reopenOffline(kept);
    expect(await card('Survives Restart (2022)')).toBeInTheDocument();
    expect(await screen.findByText(/1 change is saved on this device/i)).toBeInTheDocument();
  });

  it('a duplicate of something already in the library is refused right away, not queued', async () => {
    const kept = await onlineFirst();
    const { user } = reopenOffline(kept);
    await card('Alpha Saved (2001)');
    await addOffline(user, 'alpha saved', '2001');
    expect(await screen.findByText(/already in your library/i)).toBeInTheDocument();
    expect(await kept.device.outbox.list(OWNER_ID)).toEqual([]);
  });

  it('"Sync now" sends the waiting changes', async () => {
    const kept = await onlineFirst();
    const { user } = reopenOffline(kept);
    await card('Alpha Saved (2001)');
    await addOffline(user, 'Button Sync', '2020');
    await screen.findByText(/change is saved on this device and waiting to sync/i);
    net.down = false;
    onlineManager.setOnline(true);
    await user.click(screen.getByRole('button', { name: /sync now/i }));
    await waitFor(async () => {
      expect(await serverTitles()).toContain('Button Sync');
    });
  });
});

describe('editing and deleting offline', () => {
  it('an edit is shown at once and sent on reconnect, against the version the person saw', async () => {
    const kept = await onlineFirst();
    const target = first(server.snapshot());
    const { user } = reopenOffline(kept, `/library/${target.id}/edit`);
    const genre = await screen.findByLabelText('Genre', { selector: '#genre' });
    await user.clear(genre);
    await user.type(genre, 'Edited On A Train');
    await user.click(await screen.findByRole('button', { name: /save changes/i }));
    expect(await screen.findByText(/saved on this device and will sync/i)).toBeInTheDocument();
    expect(server.snapshot().find((m) => m.id === target.id)?.genre).toBe('Drama');

    act(() => {
      goOnline();
    });
    await waitFor(() => {
      expect(server.snapshot().find((m) => m.id === target.id)?.genre).toBe('Edited On A Train');
    });
    await waitFor(() => {
      expect(waitingBanner()).not.toBeInTheDocument();
    });
  });

  it('a title deleted offline disappears at once and is deleted on the server when back online', async () => {
    const kept = await onlineFirst();
    const target = first(server.snapshot());
    const { user } = reopenOffline(kept);
    await user.click(await card('Alpha Saved (2001)'));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    await user.click(within(dialog).getByRole('button', { name: /delete title/i }));
    expect(await screen.findByText(/will be deleted when you’re back online/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByRole('link', { name: cardName('Alpha Saved (2001)') }),
      ).not.toBeInTheDocument();
    });
    expect(server.snapshot().find((m) => m.id === target.id)?.deletedAt).toBeNull();

    act(() => {
      goOnline();
    });
    await waitFor(() => {
      expect(server.snapshot().find((m) => m.id === target.id)?.deletedAt).not.toBeNull();
    });
  });
});

describe('when the title changed somewhere else meanwhile', () => {
  const makeConflict = async () => {
    const kept = await onlineFirst();
    const target = first(server.snapshot());
    const session = reopenOffline(kept, `/library/${target.id}/edit`);
    const genre = await screen.findByLabelText('Genre', { selector: '#genre' });
    await session.user.clear(genre);
    await session.user.type(genre, 'Mine');
    await session.user.click(await screen.findByRole('button', { name: /save changes/i }));
    await screen.findByText(/saved on this device and will sync/i);
    server.simulateRemoteEdit(target.id, { genre: 'Theirs' });
    act(() => {
      goOnline();
    });
    await screen.findByText(/1 change needs your decision/i);
    return { ...session, target };
  };

  it('nothing is overwritten: the other version stays, and the person is asked', async () => {
    const { target } = await makeConflict();
    expect(server.snapshot().find((m) => m.id === target.id)?.genre).toBe('Theirs');
    expect(waitingBanner()).not.toBeInTheDocument();
    expect(await screen.findByText('Needs review')).toBeInTheDocument();
  });

  it('"Use the other version" forgets the change and clears the notice', async () => {
    const { user, target, device } = await makeConflict();
    await user.click(screen.getByRole('button', { name: /^review$/i }));
    const dialog = await screen.findByRole('dialog', { name: /sync issues/i });
    expect(within(dialog).getByText(/changed somewhere else/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /use the other version/i }));
    await waitFor(() => {
      expect(screen.queryByText(/needs your decision/i)).not.toBeInTheDocument();
    });
    expect(await device.outbox.list(OWNER_ID)).toEqual([]);
    expect(server.snapshot().find((m) => m.id === target.id)?.genre).toBe('Theirs');
  });

  it('"Keep my version" replaces the other change on purpose, and only then', async () => {
    const { user, target } = await makeConflict();
    await user.click(screen.getByRole('button', { name: /^review$/i }));
    const dialog = await screen.findByRole('dialog', { name: /sync issues/i });
    await user.click(within(dialog).getByRole('button', { name: /keep my version/i }));
    await waitFor(() => {
      expect(server.snapshot().find((m) => m.id === target.id)?.genre).toBe('Mine');
    });
    await waitFor(() => {
      expect(screen.queryByText(/needs your decision/i)).not.toBeInTheDocument();
    });
  });
});

describe('leaving the account with changes that were never sent', () => {
  const withWaitingChange = async () => {
    const kept = await onlineFirst();
    const session = reopenOffline(kept, '/settings');
    await screen.findByRole('heading', { name: /account/i });
    // queue directly, as a change made earlier would be
    await kept.device.outbox.enqueue(
      OWNER_ID,
      {
        kind: 'create',
        movieId: '00000000-0000-4000-8000-000000009999',
        input: {
          ...first(server.snapshot()),
          title: 'Unsent',
          year: 1999,
          genre: null,
          runtimeMinutes: null,
          watched: false,
          watchedOn: null,
          userRating: null,
          verdict: null,
          technicalNotes: null,
          shotLink: null,
          mediaType: 'movie',
        },
      },
      new Date(),
    );
    await act(async () => {
      await session.queryClient.invalidateQueries({ queryKey: ['u', OWNER_ID, 'outbox'] });
    });
    return { ...session, kept };
  };

  it('warns first, and "Stay signed in" changes nothing', async () => {
    const { user, kept } = await withWaitingChange();
    await user.click(await screen.findByRole('button', { name: /^sign out$/i }));
    const warning = await screen.findByRole('alertdialog');
    expect(within(warning).getByText(/1 change has not reached the server/i)).toBeInTheDocument();
    await user.click(within(warning).getByRole('button', { name: /stay signed in/i }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await kept.device.outbox.list(OWNER_ID)).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^sign out$/i })).toBeInTheDocument();
  });

  it('"Sign out and discard them" signs out and leaves nothing of the account on the device', async () => {
    const { user } = await withWaitingChange();
    await user.click(await screen.findByRole('button', { name: /^sign out$/i }));
    const warning = await screen.findByRole('alertdialog');
    await user.click(within(warning).getByRole('button', { name: /sign out and discard/i }));
    await waitFor(async () => {
      expect((await factory.databases()).map((d) => d.name)).not.toContain(
        cacheDatabaseName(OWNER_ID),
      );
    });
  });

  it('with nothing waiting, signing out needs no warning', async () => {
    const kept = await onlineFirst();
    const { user } = boot(OWNER_ID, kept, '/settings');
    await user.click(await screen.findByRole('button', { name: /^sign out$/i }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

describe('who may keep working offline (fail closed)', () => {
  it('an owner the device confirmed keeps the add button offline', async () => {
    const kept = await onlineFirst();
    reopenOffline(kept);
    await card('Alpha Saved (2001)');
    expect(await screen.findByRole('link', { name: /add movie/i })).toBeInTheDocument();
  });

  it('a device that never confirmed a role gets none: offline it is view-only', async () => {
    const kept = await onlineFirst();
    await kept.device.library.retainOnly(null); // wipes everything, then keep only a saved copy
    await kept.device.library.write(OWNER_ID, [movie(1, 'Alpha Saved')]);
    reopenOffline(kept);
    await card('Alpha Saved (2001)');
    expect(addLink()).not.toBeInTheDocument();
  });

  it('a viewer stays a viewer offline: nothing is offered, nothing can be queued', async () => {
    const kept = await onlineFirst(FRIEND_ID);
    goOffline();
    kept.profiles.failNext(networkFailure);
    boot(FRIEND_ID, kept);
    await card('Alpha Saved (2001)');
    expect(addLink()).not.toBeInTheDocument();
  });

  it('only "could not reach the server" may use the remembered role: a refusal stays view-only', async () => {
    const kept = await onlineFirst();
    kept.profiles.failNext({ code: 'forbidden', message: 'no' });
    boot(OWNER_ID, kept);
    await card('Alpha Saved (2001)');
    await waitFor(() => {
      expect(addLink()).not.toBeInTheDocument();
    });
  });

  it('back online the server’s answer replaces the remembered role', async () => {
    const kept = await onlineFirst();
    reopenOffline(kept);
    await card('Alpha Saved (2001)');
    kept.profiles.rows.set(OWNER_ID, { role: 'viewer' }); // demoted while away
    act(() => {
      goOnline();
    });
    await waitFor(() => {
      expect(addLink()).not.toBeInTheDocument();
    });
  });
});

describe('a write that fails while the app believes it is online', () => {
  const addTitle = async (user: ReturnType<typeof boot>['user'], title: string) => {
    await user.click(await screen.findByRole('link', { name: /add movie/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Title'), title);
    await user.type(within(dialog).getByLabelText('Year'), '2024');
    await user.click(within(dialog).getByRole('button', { name: /add to library/i }));
  };

  it('is kept and sent later, and never written into the loaded library', async () => {
    const kept = await onlineFirst();
    const session = boot(OWNER_ID, kept);
    await card('Alpha Saved (2001)');
    faults.writes = 'down';
    await addTitle(session.user, 'Dropped Mid Write');
    expect(await screen.findByText(/saved on this device and will sync/i)).toBeInTheDocument();
    expect(await card('Dropped Mid Write (2024)')).toBeInTheDocument(); // shown from the waiting list
    const loaded = session.queryClient.getQueryData<readonly Movie[]>(['u', OWNER_ID, 'movies']);
    expect(loaded?.some((m) => m.title === 'Dropped Mid Write')).toBe(false); // the loaded list stays the server's

    faults.writes = 'ok';
    await session.user.click(screen.getByRole('button', { name: /sync now/i }));
    await waitFor(async () => {
      expect(await serverTitles()).toContain('Dropped Mid Write');
    });
  });

  it('a create the server accepted but never answered is NOT added a second time', async () => {
    const kept = await onlineFirst();
    const session = boot(OWNER_ID, kept);
    await card('Alpha Saved (2001)');
    faults.writes = 'lose';
    await addTitle(session.user, 'Answer Lost');
    await screen.findByText(/saved on this device and will sync/i);
    expect(await serverTitles()).toContain('Answer Lost'); // it did land

    faults.writes = 'ok';
    await session.user.click(await screen.findByRole('button', { name: /sync now/i }));
    await waitFor(async () => {
      expect(await kept.device.outbox.list(OWNER_ID)).toEqual([]);
    });
    expect((await serverTitles()).filter((t) => t === 'Answer Lost')).toHaveLength(1);
    expect(screen.queryByText(/needs your decision/i)).not.toBeInTheDocument();
  });

  it('a second edit of a title with a waiting change joins it instead of racing it to the server', async () => {
    const kept = await onlineFirst();
    const target = first(server.snapshot());
    const session = boot(OWNER_ID, kept, `/library/${target.id}/edit`);
    const editGenre = async (value: string) => {
      const genre = await screen.findByLabelText('Genre', { selector: '#genre' });
      await session.user.clear(genre);
      await session.user.type(genre, value);
      await session.user.click(await screen.findByRole('button', { name: /save changes/i }));
    };
    faults.writes = 'down';
    await editGenre('First');
    await screen.findByText(/saved on this device and will sync/i);
    expect(await kept.device.outbox.list(OWNER_ID)).toHaveLength(1);

    faults.writes = 'ok'; // the server answers again, but nothing is sent on its own yet
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await act(async () => {
      await session.router.navigate(`/library/${target.id}/edit`);
    });
    await editGenre('Second');
    await screen.findByText(/saved on this device and will sync/i);
    expect(server.snapshot().find((m) => m.id === target.id)?.genre).toBe('Drama'); // still only waiting
    expect(await kept.device.outbox.list(OWNER_ID)).toHaveLength(1); // ONE entry, not two
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    await session.user.click(await screen.findByRole('button', { name: /sync now/i }));
    await waitFor(() => {
      expect(server.snapshot().find((m) => m.id === target.id)?.genre).toBe('Second');
    });
    await waitFor(async () => {
      expect(await kept.device.outbox.list(OWNER_ID)).toEqual([]);
    });
    expect(screen.queryByText(/needs your decision/i)).not.toBeInTheDocument();
  });
});
