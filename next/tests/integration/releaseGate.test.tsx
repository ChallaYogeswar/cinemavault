import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createDexieDeviceStore, createDexieLibraryCache } from '@/data/local/dexieLibraryCache';
import { createMetadataService } from '@/services/tmdb/metadataService';
import { buildMovie } from '@/data/mock/fixtures';
import { createFakeAuth } from '../fakes/fakeAuthService';
import { createFakeProfiles } from '../fakes/fakeProfiles';
import { FRIEND_ID, OWNER_ID, renderFullApp } from '../renderFullApp';
import { cardName } from '../cardName';

/**
 * RELEASE GATE (M3 review, section 3): User A signs in, private data loads, A signs out, the
 * browser is refreshed, user B signs in, and nothing of A's is visible anywhere — not on screen,
 * not in the query cache, not in browser storage.
 *
 * Both accounts get a library of their own here (in production a viewer reads the owner's library;
 * separate libraries make any leak unambiguous). "Refreshed" is a brand-new React tree, query
 * client and active-user store against the same stored session, exactly as a reload is.
 */
const A_SECRET = 'Secret Title Of A';
const B_OWN = 'Library Of B';

const libraries: Record<string, ReturnType<typeof buildMovie>[]> = {
  [OWNER_ID]: [
    buildMovie(401, [A_SECRET, 'movie', 2011, 'Drama', 100, 4, '2026-01-01', null], OWNER_ID),
  ],
  [FRIEND_ID]: [
    buildMovie(402, [B_OWN, 'movie', 2012, 'Comedy', 90, null, 'unwatched', null], OWNER_ID),
  ],
};

const accounts = () => [
  { id: OWNER_ID, email: 'a@example.com', password: 'a-password-1' },
  { id: FRIEND_ID, email: 'b@example.com', password: 'b-password-2' },
];
const roles = { [OWNER_ID]: { role: 'owner' }, [FRIEND_ID]: { role: 'viewer' } };

const boot = (
  auth: ReturnType<typeof createFakeAuth>,
  path = '/library',
  cache: ReturnType<typeof createDexieLibraryCache> | null = null,
) =>
  renderFullApp({
    auth,
    cache,
    profiles: createFakeProfiles(roles),
    path,
    libraryFor: (userId) => libraries[userId] ?? [],
  });

const everythingHeld = (app: ReturnType<typeof boot>): string =>
  JSON.stringify([
    app.queryClient
      .getQueryCache()
      .getAll()
      .map((q) => [q.queryKey, q.state.data]),
    Object.entries(localStorage),
    Object.entries(sessionStorage),
    document.body.textContent,
  ]);

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('release gate: sign-out, reload, then a different account', () => {
  it('leaves nothing of user A for user B', async () => {
    const auth = createFakeAuth(accounts(), null);

    // A signs in; A's private data loads.
    const first = boot(auth, '/sign-in');
    await first.user.type(await screen.findByLabelText('Email'), 'a@example.com');
    await first.user.type(screen.getByLabelText('Password', { exact: true }), 'a-password-1');
    await first.user.click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(
      await screen.findByRole('link', { name: cardName(`${A_SECRET} (2011)`) }),
    ).toBeInTheDocument();
    expect(everythingHeld(first)).toContain(A_SECRET); // the gate can actually see a leak

    // A signs out (Settings).
    await first.user.click(screen.getByRole('link', { name: 'Settings' }));
    await first.user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(auth.session).toBeNull();
    expect(everythingHeld(first)).not.toContain(A_SECRET);

    // The browser is refreshed: a brand-new app against whatever the browser kept.
    first.unmount();
    const second = boot(auth, '/library');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(everythingHeld(second)).not.toContain(A_SECRET);

    // B signs in.
    await second.user.type(screen.getByLabelText('Email'), 'b@example.com');
    await second.user.type(screen.getByLabelText('Password', { exact: true }), 'b-password-2');
    await second.user.click(screen.getByRole('button', { name: /^sign in$/i }));
    // (Sign-in returns to the page that was last open, Settings, so go to the library.)
    await second.user.click(await screen.findByRole('link', { name: 'Library' }));
    expect(
      await screen.findByRole('link', { name: cardName(`${B_OWN} (2012)`) }),
    ).toBeInTheDocument();

    // Nothing of A's anywhere, and B is a viewer, not a leftover owner.
    expect(screen.queryByText(A_SECRET)).not.toBeInTheDocument();
    expect(everythingHeld(second)).not.toContain(A_SECRET);
    const keyed = second.queryClient
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey[1]);
    expect(keyed.length).toBeGreaterThan(0);
    expect(new Set(keyed)).toEqual(new Set([FRIEND_ID])); // no cache entry belongs to A
    expect(second.store.get()).toBe(FRIEND_ID);
    expect(screen.queryByRole('link', { name: /add movie/i })).not.toBeInTheDocument();
  });

  it('the scan really can see browser storage (so a clean result means something)', () => {
    const auth = createFakeAuth(accounts(), null);
    const app = boot(auth, '/sign-in');
    localStorage.setItem('leak-probe', A_SECRET);
    sessionStorage.setItem('leak-probe-2', 'second-' + A_SECRET);
    const held = everythingHeld(app);
    expect(held).toContain('leak-probe');
    expect(held).toContain('second-' + A_SECRET);
  });

  it('also holds when B signs in without a reload (same tab, same query client)', async () => {
    const auth = createFakeAuth(accounts(), OWNER_ID);
    const app = boot(auth);
    await screen.findByRole('link', { name: cardName(`${A_SECRET} (2011)`) });
    await app.user.click(screen.getByRole('link', { name: 'Settings' }));
    await app.user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    await app.user.type(screen.getByLabelText('Email'), 'b@example.com');
    await app.user.type(screen.getByLabelText('Password', { exact: true }), 'b-password-2');
    await app.user.click(screen.getByRole('button', { name: /^sign in$/i }));
    await app.user.click(await screen.findByRole('link', { name: 'Library' }));
    await screen.findByRole('link', { name: cardName(`${B_OWN} (2012)`) });
    expect(everythingHeld(app)).not.toContain(A_SECRET);
  });
});

/** Every database on the "device", with every row of every table, as one searchable string. */
async function everythingInIndexedDb(factory: IDBFactory): Promise<string> {
  const names = (await factory.databases()).flatMap((d) => (d.name ? [d.name] : []));
  const dump: Record<string, unknown> = {};
  for (const name of names) {
    const db = new Dexie(name, { indexedDB: factory, IDBKeyRange });
    await db.open();
    for (const table of db.tables) dump[`${name}/${table.name}`] = await table.toArray();
    db.close();
  }
  return JSON.stringify({ names, dump });
}

describe('release gate, IndexedDB edition (the saved library on the device)', () => {
  const setup = () => {
    const factory = new IDBFactory();
    return { factory, cache: createDexieLibraryCache({ indexedDB: factory, IDBKeyRange }) };
  };

  it('the scan really can see the saved library (so a clean result means something)', async () => {
    const { factory, cache } = setup();
    const app = boot(createFakeAuth(accounts(), OWNER_ID), '/library', cache);
    await screen.findByRole('link', { name: cardName(`${A_SECRET} (2011)`) });
    await waitFor(async () => {
      expect(await everythingInIndexedDb(factory)).toContain(A_SECRET);
    });
    expect(everythingHeld(app)).toContain(A_SECRET);
  });

  it('sign-out → reload → another account: nothing of A in IndexedDB, on screen or in storage', async () => {
    const { factory, cache } = setup();
    const auth = createFakeAuth(accounts(), OWNER_ID);
    const first = boot(auth, '/library', cache);
    await screen.findByRole('link', { name: cardName(`${A_SECRET} (2011)`) });
    await waitFor(async () => {
      expect(await everythingInIndexedDb(factory)).toContain(A_SECRET);
    });

    await first.user.click(screen.getByRole('link', { name: 'Settings' }));
    await first.user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    await waitFor(async () => {
      const held = await everythingInIndexedDb(factory);
      expect(held).not.toContain(A_SECRET);
      expect(held).not.toContain(OWNER_ID);
    });

    // Reload: a new app and a new cache object over the same browser database.
    first.unmount();
    const reloaded = createDexieLibraryCache({ indexedDB: factory, IDBKeyRange });
    const second = boot(auth, '/library', reloaded);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(await everythingInIndexedDb(factory)).not.toContain(A_SECRET);

    await second.user.type(screen.getByLabelText('Email'), 'b@example.com');
    await second.user.type(screen.getByLabelText('Password', { exact: true }), 'b-password-2');
    await second.user.click(screen.getByRole('button', { name: /^sign in$/i }));
    await second.user.click(await screen.findByRole('link', { name: 'Library' }));
    await screen.findByRole('link', { name: cardName(`${B_OWN} (2012)`) });
    await waitFor(async () => {
      expect(await everythingInIndexedDb(factory)).toContain(B_OWN);
    });

    const held = await everythingInIndexedDb(factory);
    // (B's rows legitimately carry the OWNER's id as owner_id: a viewer reads the owner's library.
    // What must not exist is A's database or A's title.)
    expect(held).not.toContain(A_SECRET);
    expect((JSON.parse(held) as { names: string[] }).names).toEqual([
      `cinemavault-next:${FRIEND_ID}`,
    ]);
    expect(everythingHeld(second)).not.toContain(A_SECRET);
  });
});

describe('release gate, M5: history and poster lookups kept on the device', () => {
  // Discover only suggests unwatched titles, so A needs one of those here.
  const unwatchedLibraries: typeof libraries = {
    [OWNER_ID]: [
      buildMovie(403, [A_SECRET, 'movie', 2011, 'Drama', 100, null, 'unwatched', null], OWNER_ID),
    ],
    [FRIEND_ID]: libraries[FRIEND_ID] ?? [],
  };

  const fakeClient = {
    search: (query: string) =>
      Promise.resolve([
        {
          id: 77,
          media_type: 'movie',
          title: query,
          poster_path: '/poster.jpg',
          backdrop_path: null,
          vote_average: 7,
          overview: 'o',
        },
      ]),
    videos: () => Promise.resolve([]),
  };

  const bootWithDevice = (
    factory: IDBFactory,
    auth: ReturnType<typeof createFakeAuth>,
    path: string,
  ) => {
    const device = createDexieDeviceStore({ indexedDB: factory, IDBKeyRange });
    const app = renderFullApp({
      auth,
      cache: device.library,
      profiles: createFakeProfiles(roles),
      path,
      libraryFor: (userId) => unwatchedLibraries[userId] ?? [],
      device: {
        history: device.history,
        metadata: createMetadataService({ client: fakeClient, store: device.metadata }),
      },
    });
    return { device, ...app };
  };

  const lookedUp = async (factory: IDBFactory) =>
    (await everythingInIndexedDb(factory)).toLowerCase();

  it('the scan sees the title in the lookup key and the history (so a clean result means something)', async () => {
    const factory = new IDBFactory();
    bootWithDevice(factory, createFakeAuth(accounts(), OWNER_ID), '/discover');
    await screen.findByRole('article', { name: /suggested title/i });
    await waitFor(async () => {
      const held = await lookedUp(factory);
      expect(held).toContain(A_SECRET.toLowerCase()); // the lookup key
      expect(held).toContain('/history"');
      expect(held).toContain('tmdb:v1:');
    });
  });

  it('sign-out removes A’s history and lookups; B starts with a database that holds none of them', async () => {
    const factory = new IDBFactory();
    const auth = createFakeAuth(accounts(), OWNER_ID);
    const first = bootWithDevice(factory, auth, '/discover');
    await screen.findByRole('article', { name: /suggested title/i });
    await waitFor(async () => {
      expect(await lookedUp(factory)).toContain(A_SECRET.toLowerCase());
    });
    await waitFor(async () => {
      expect((await first.device.history.recent(OWNER_ID, 10)).length).toBe(1);
    });

    await first.user.click(screen.getByRole('link', { name: 'Settings' }));
    await first.user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    await waitFor(async () => {
      const held = await lookedUp(factory);
      expect(held).not.toContain(A_SECRET.toLowerCase());
      expect(held).not.toContain(OWNER_ID);
    });
    expect(await first.device.history.recent(OWNER_ID, 10)).toEqual([]);

    first.unmount();
    const second = bootWithDevice(factory, auth, '/discover');
    await screen.findByRole('heading', { name: 'Sign in' });
    await second.user.type(screen.getByLabelText('Email'), 'b@example.com');
    await second.user.type(screen.getByLabelText('Password', { exact: true }), 'b-password-2');
    await second.user.click(screen.getByRole('button', { name: /^sign in$/i }));
    await screen.findByRole('article', { name: /suggested title/i });
    await waitFor(async () => {
      expect(await lookedUp(factory)).toContain(B_OWN.toLowerCase());
    });
    const held = await lookedUp(factory);
    expect(held).not.toContain(A_SECRET.toLowerCase());
    expect((JSON.parse(await everythingInIndexedDb(factory)) as { names: string[] }).names).toEqual(
      [`cinemavault-next:${FRIEND_ID}`],
    );
    expect(everythingHeld(second)).not.toContain(A_SECRET);
  });
});
