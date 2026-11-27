import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { onlineManager } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDexieLibraryCache } from '@/data/local/dexieLibraryCache';
import { cacheDatabaseName } from '@/data/local/scope';
import { buildMovie } from '@/data/mock/fixtures';
import type { Movie } from '@/domain/movie';
import { createFakeAuth } from '../fakes/fakeAuthService';
import { createFakeProfiles, networkFailure } from '../fakes/fakeProfiles';
import { FRIEND_ID, OWNER_ID, renderFullApp } from '../renderFullApp';
import { cardName } from '../cardName';

/**
 * Online-first reads with a saved copy for when the server cannot be reached. The browser's
 * "offline" flag is flipped too (onlineManager), because that is what a real browser does and it
 * changes how queries behave.
 */
const accounts = () => [
  { id: OWNER_ID, email: 'owner@example.com', password: 'pw-owner-1' },
  { id: FRIEND_ID, email: 'friend@example.com', password: 'pw-friend-2' },
];
const roles = { [OWNER_ID]: { role: 'owner' }, [FRIEND_ID]: { role: 'viewer' } };

const movie = (n: number, title: string): Movie =>
  buildMovie(500 + n, [title, 'movie', 2000 + n, 'Drama', 100, 3, '2026-01-01', null], OWNER_ID);

let factory: IDBFactory;
let library: Movie[];
const net = { down: false };
const goOffline = () => {
  net.down = true;
  onlineManager.setOnline(false);
};
const goOnline = () => {
  net.down = false;
  onlineManager.setOnline(true);
};

const makeCache = (now?: () => Date) =>
  createDexieLibraryCache({
    indexedDB: factory,
    IDBKeyRange,
    ...(now ? { now } : {}),
  });

const boot = (
  signedInAs: string | null,
  options: {
    cache?: ReturnType<typeof makeCache>;
    auth?: ReturnType<typeof createFakeAuth>;
    profiles?: ReturnType<typeof createFakeProfiles>;
    path?: string;
  } = {},
) => {
  const auth = options.auth ?? createFakeAuth(accounts(), signedInAs);
  const profiles = options.profiles ?? createFakeProfiles(roles);
  const cache = options.cache ?? makeCache();
  const app = renderFullApp({
    auth,
    profiles,
    cache,
    libraryFor: () => library,
    networkDown: () => net.down,
    ...(options.path ? { path: options.path } : {}),
  });
  return { auth, profiles, cache, ...app };
};

const databases = async () => (await factory.databases()).map((d) => d.name);
const savedFor = async (userId: string) => makeCache().read(userId);
const banner = () => screen.queryByText(/can’t reach the server/i);
const addLink = () => screen.queryByRole('link', { name: /add movie/i });
const card = (name: string) => screen.findByRole('link', { name: cardName(name) });

beforeEach(() => {
  factory = new IDBFactory();
  library = [movie(1, 'Alpha Saved'), movie(2, 'Beta Saved')];
  goOnline();
});
afterEach(() => {
  goOnline();
});

describe('online: the library is fetched and saved on the device', () => {
  it('shows the server library with no banner, and keeps a copy for later', async () => {
    boot(OWNER_ID);
    await card('Alpha Saved (2001)');
    expect(banner()).not.toBeInTheDocument();
    await waitFor(async () => {
      expect((await savedFor(OWNER_ID))?.movies.map((m) => m.title).sort()).toEqual([
        'Alpha Saved',
        'Beta Saved',
      ]);
    });
  });
});

describe('offline: the last saved library, clearly labelled', () => {
  const sessionThatSavedALibrary = async () => {
    const auth = createFakeAuth(accounts(), OWNER_ID);
    const profiles = createFakeProfiles(roles);
    const cache = makeCache();
    const first = boot(OWNER_ID, { auth, profiles, cache });
    await card('Alpha Saved (2001)');
    await waitFor(async () => {
      expect(await savedFor(OWNER_ID)).not.toBeNull();
    });
    first.unmount();
    return { auth, profiles, cache };
  };

  it('a reload with no connection shows the saved titles, says so, and offers no edits', async () => {
    const kept = await sessionThatSavedALibrary();
    goOffline();
    kept.profiles.failNext(networkFailure); // the profile cannot be read offline either

    boot(OWNER_ID, kept);
    expect(await card('Alpha Saved (2001)')).toBeInTheDocument();
    expect(await screen.findByText(/can’t reach the server/i)).toHaveTextContent(
      /showing your library as saved just now/i,
    );
    expect(addLink()).not.toBeInTheDocument();
    // ONE banner explains the situation; the permission alert does not pile on.
    expect(screen.queryByText(/couldn’t verify your permissions/i)).not.toBeInTheDocument();
  });

  it('says how old the saved copy is', async () => {
    const auth = createFakeAuth(accounts(), OWNER_ID);
    const profiles = createFakeProfiles(roles);
    const threeHoursAgo = () => new Date(Date.now() - 3 * 60 * 60_000);
    const first = boot(OWNER_ID, { auth, profiles, cache: makeCache(threeHoursAgo) });
    await card('Alpha Saved (2001)');
    await waitFor(async () => {
      expect((await makeCache().read(OWNER_ID))?.movies).toHaveLength(2);
    });
    first.unmount();

    goOffline();
    boot(OWNER_ID, { auth, profiles });
    expect(await screen.findByText(/as saved 3 hours ago/i)).toBeInTheDocument();
  });

  it('a title can be opened and read, but not edited, rated or deleted', async () => {
    const kept = await sessionThatSavedALibrary();
    goOffline();
    const { user } = boot(OWNER_ID, kept);
    await user.click(await card('Alpha Saved (2001)'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Alpha Saved')).toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: /edit/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('a save attempted through a direct link keeps the form and explains, instead of queueing', async () => {
    const kept = await sessionThatSavedALibrary();
    goOffline();
    const { user } = boot(OWNER_ID, { ...kept, path: '/library/new' });
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Title'), 'Typed Offline');
    await user.type(within(dialog).getByLabelText('Year'), '2024');
    await user.click(within(dialog).getByRole('button', { name: /add to library/i }));

    expect(
      await within(dialog).findByText(/couldn’t reach|check your connection/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Typed Offline'); // nothing lost
    goOnline();
    // Nothing was queued: back online, the title was never sent.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(library.some((m) => m.title === 'Typed Offline')).toBe(false);
  });

  it('coming back online replaces the saved copy with the server’s library and removes the banner', async () => {
    const kept = await sessionThatSavedALibrary();
    // The library changes on the server while this device is away; offline it cannot know.
    library = [movie(1, 'Alpha Saved'), movie(3, 'Gamma Added Elsewhere')];
    goOffline();
    boot(OWNER_ID, kept);
    await card('Alpha Saved (2001)');
    expect(await screen.findByText(/can’t reach the server/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: cardName('Beta Saved (2002)') })).toBeInTheDocument(); // the old copy

    act(() => {
      goOnline();
    });

    expect(await card('Gamma Added Elsewhere (2003)')).toBeInTheDocument();
    await waitFor(() => {
      expect(banner()).not.toBeInTheDocument();
    });
    expect(
      screen.queryByRole('link', { name: cardName('Beta Saved (2002)') }),
    ).not.toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /add movie/i })).toBeInTheDocument();
    await waitFor(async () => {
      const copy = await savedFor(OWNER_ID);
      expect(copy?.movies.map((m) => m.title).sort()).toEqual([
        'Alpha Saved',
        'Gamma Added Elsewhere',
      ]);
    });
  });

  it('"Try again" on the banner re-contacts the server', async () => {
    const kept = await sessionThatSavedALibrary();
    goOffline();
    const { user } = boot(OWNER_ID, kept);
    await screen.findByText(/can’t reach the server/i);
    net.down = false; // the connection came back without the browser noticing
    const notice = (await screen.findByText(/can’t reach the server/i)).parentElement;
    if (!notice) throw new Error('banner not found');
    await user.click(within(notice).getByRole('button', { name: /try again/i }));
    await waitFor(() => {
      expect(banner()).not.toBeInTheDocument();
    });
  });

  it('with no saved copy, offline shows the ordinary error and no banner', async () => {
    goOffline();
    boot(OWNER_ID);
    expect(await screen.findByText(/couldn’t reach your library/i)).toBeInTheDocument();
    expect(banner()).not.toBeInTheDocument();
  });

  it('a server refusal is shown as a refusal, never hidden behind the saved copy', async () => {
    const kept = await sessionThatSavedALibrary();
    const auth = kept.auth;
    renderFullApp({
      auth,
      profiles: kept.profiles,
      cache: kept.cache,
      libraryFor: () => library,
      listError: () => ({ code: 'forbidden', message: 'permission denied' }),
    });
    expect(await screen.findByText(/don’t have access to this library/i)).toBeInTheDocument();
    expect(screen.queryByText('Alpha Saved')).not.toBeInTheDocument();
    expect(banner()).not.toBeInTheDocument();
  });
});

describe('the saved copy and accounts', () => {
  it('signing out deletes the saved copy; the next visitor, offline, finds nothing of it', async () => {
    const auth = createFakeAuth(accounts(), OWNER_ID);
    const profiles = createFakeProfiles(roles);
    const first = boot(OWNER_ID, { auth, profiles });
    await card('Alpha Saved (2001)');
    await waitFor(async () => {
      expect(await databases()).toContain(cacheDatabaseName(OWNER_ID));
    });
    await first.user.click(screen.getByRole('link', { name: 'Settings' }));
    await first.user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    await waitFor(async () => {
      expect(await databases()).toEqual([]);
    });
    first.unmount();

    goOffline();
    boot(null, { auth, profiles });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText('Alpha Saved')).not.toBeInTheDocument();
  });

  it('a start-up with no session at all removes a copy left behind by a session that ended', async () => {
    await makeCache().write(OWNER_ID, library); // e.g. the server revoked the session while the app was closed
    expect(await databases()).toContain(cacheDatabaseName(OWNER_ID));
    boot(null);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    await waitFor(async () => {
      expect(await databases()).toEqual([]);
    });
  });

  it('a start-up that is still waiting for auth to answer does not touch the saved copy', async () => {
    await makeCache().write(OWNER_ID, library);
    const auth = createFakeAuth(accounts(), OWNER_ID);
    auth.restoreDelayMs = 150;
    boot(OWNER_ID, { auth });
    expect(screen.getByRole('status')).toHaveTextContent(/loading/i);
    expect(await databases()).toContain(cacheDatabaseName(OWNER_ID));
    await card('Alpha Saved (2001)');
  });

  it('another account signing in on this device never sees the first account’s saved copy', async () => {
    const auth = createFakeAuth(accounts(), OWNER_ID);
    const profiles = createFakeProfiles(roles);
    const first = boot(OWNER_ID, { auth, profiles });
    await card('Alpha Saved (2001)');
    await waitFor(async () => {
      expect(await savedFor(OWNER_ID)).not.toBeNull();
    });
    first.unmount();

    // The browser keeps the owner's data, then a DIFFERENT account is signed in, with no connection.
    goOffline();
    const second = createFakeAuth(accounts(), FRIEND_ID);
    boot(FRIEND_ID, { auth: second, profiles });
    expect(await screen.findByText(/couldn’t reach your library/i)).toBeInTheDocument();
    expect(screen.queryByText('Alpha Saved')).not.toBeInTheDocument();
    expect(banner()).not.toBeInTheDocument();
    await waitFor(async () => {
      expect(await databases()).not.toContain(cacheDatabaseName(OWNER_ID)); // and it was removed
    });
  });

  it('an account change in another tab removes the old account’s copy and keeps the new one’s', async () => {
    const auth = createFakeAuth(accounts(), OWNER_ID);
    boot(OWNER_ID, { auth });
    await card('Alpha Saved (2001)');
    await waitFor(async () => {
      expect(await databases()).toContain(cacheDatabaseName(OWNER_ID));
    });
    act(() => {
      auth.session = { id: FRIEND_ID, email: 'friend@example.com' };
      auth.emit({ kind: 'session', user: auth.session });
    });
    await waitFor(async () => {
      const names = await databases();
      expect(names).not.toContain(cacheDatabaseName(OWNER_ID));
      expect(names).toContain(cacheDatabaseName(FRIEND_ID));
    });
  });
});

describe('a damaged saved copy', () => {
  it('is never shown: offline falls back to the ordinary error, and the copy is deleted', async () => {
    const auth = createFakeAuth(accounts(), OWNER_ID);
    const profiles = createFakeProfiles(roles);
    const first = boot(OWNER_ID, { auth, profiles });
    await card('Alpha Saved (2001)');
    await waitFor(async () => {
      expect(await savedFor(OWNER_ID)).not.toBeNull();
    });
    first.unmount();

    const raw = new Dexie(cacheDatabaseName(OWNER_ID), { indexedDB: factory, IDBKeyRange });
    raw.version(1).stores({ movies: 'id', meta: 'key' });
    const rows = await raw.table('movies').toArray();
    await raw.table('movies').put({ ...rows[0], mediaType: 'podcast' });
    raw.close();

    goOffline();
    boot(OWNER_ID, { auth, profiles });
    expect(await screen.findByText(/couldn’t reach your library/i)).toBeInTheDocument();
    expect(screen.queryByText('Alpha Saved')).not.toBeInTheDocument();
    await waitFor(async () => {
      expect(await databases()).not.toContain(cacheDatabaseName(OWNER_ID));
    });
  });
});
