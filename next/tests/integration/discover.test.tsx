import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { onlineManager } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDexieDeviceStore, type DeviceStore } from '@/data/local/dexieLibraryCache';
import { buildMovie } from '@/data/mock/fixtures';
import type { Movie } from '@/domain/movie';
import {
  createMetadataService,
  type Lookup,
  type MetadataService,
} from '@/services/tmdb/metadataService';
import type { TmdbClient } from '@/services/tmdb/tmdbClient';
import { createFakeAuth } from '../fakes/fakeAuthService';
import { createFakeProfiles, networkFailure } from '../fakes/fakeProfiles';
import { FRIEND_ID, OWNER_ID, renderFullApp } from '../renderFullApp';
import { cardName } from '../cardName';

const accounts = () => [
  { id: OWNER_ID, email: 'owner@example.com', password: 'pw-owner-1' },
  { id: FRIEND_ID, email: 'friend@example.com', password: 'pw-friend-2' },
];
const roles = { [OWNER_ID]: { role: 'owner' }, [FRIEND_ID]: { role: 'viewer' } };

type Row = Parameters<typeof buildMovie>[1];
const title = (
  n: number,
  name: string,
  genre: string | null,
  watched = false,
  type: 'movie' | 'tv' = 'movie',
): Movie =>
  buildMovie(
    700 + n,
    [
      name,
      type,
      2000 + n,
      genre,
      100,
      watched ? 3 : null,
      watched ? '2026-01-01' : 'unwatched',
      null,
    ] as Row,
    OWNER_ID,
  );

let factory: IDBFactory;
let device: DeviceStore;
let library: Movie[];
const net = { down: false };

const fakeMetadata = (
  lookups: Record<string, Lookup> = {},
  trailers: Record<string, string | null> = {},
): MetadataService & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    lookup: (_user, target) => {
      asked.push(target.title);
      return Promise.resolve(lookups[target.title] ?? { kind: 'none' });
    },
    trailerKey: (_user, target) => Promise.resolve(trailers[target.title] ?? null),
    clear: () => Promise.resolve(),
  };
};

const found = (posterPath: string | null, overview = '', matchedTitle = 'Drama One'): Lookup => ({
  kind: 'found',
  metadata: {
    tmdbId: 1,
    mediaType: 'movie',
    posterPath,
    backdropPath: null,
    voteAverage: 8.2,
    overview,
    matchedTitle,
    matchedYear: 2001,
  },
});

const boot = (
  path: string,
  options: { metadata?: MetadataService | null; withDevice?: boolean; signedInAs?: string } = {},
) => {
  const auth = createFakeAuth(accounts(), options.signedInAs ?? OWNER_ID);
  const profiles = createFakeProfiles(roles);
  return renderFullApp({
    auth,
    profiles,
    path,
    libraryFor: () => library,
    networkDown: () => net.down,
    device: {
      history: options.withDevice === false ? null : device.history,
      snoozes: options.withDevice === false ? null : device.snoozes,
      metadata: options.metadata ?? null,
    },
  });
};

const closestOrThrow = (el: HTMLElement, selector: string): HTMLElement => {
  const found = el.closest<HTMLElement>(selector);
  if (!found) throw new Error(`no ${selector} around the element`);
  return found;
};
const rowOf = (heading: HTMLElement) => closestOrThrow(heading, 'li');

const suggested = () => within(screen.getByRole('article', { name: /suggested title/i }));
const shownTitle = async () =>
  (await screen.findByRole('article', { name: /suggested title/i })).querySelector('h2')
    ?.textContent ?? '';

beforeEach(() => {
  factory = new IDBFactory();
  device = createDexieDeviceStore({ indexedDB: factory, IDBKeyRange });
  net.down = false;
  onlineManager.setOnline(true);
  library = [
    title(1, 'Drama One', 'Drama'),
    title(2, 'Drama Two', 'Drama'),
    title(3, 'Drama Three', 'Drama'),
    title(4, 'Comedy One', 'Comedy'),
    title(5, 'Comedy Two', 'Comedy'),
    title(6, 'Seen Drama', 'Drama', true),
    title(7, 'Seen Comedy', 'Comedy', true),
  ];
});
afterEach(() => {
  vi.restoreAllMocks();
  onlineManager.setOnline(true);
});

describe('the suggestion', () => {
  it('is an unwatched title, never a watched one, and "Pick another" always changes it', async () => {
    const { user } = boot('/discover');
    let previous = await shownTitle();
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      seen.add(previous);
      await user.click(screen.getByRole('button', { name: 'Pick another' }));
      await waitFor(async () => {
        expect(await shownTitle()).not.toBe(previous);
      });
      previous = await shownTitle();
    }
    seen.add(previous);
    expect([...seen].every((t) => !t.startsWith('Seen'))).toBe(true);
    expect(seen.size).toBeGreaterThan(2);
  });

  it('explains why, and opens the title’s details', async () => {
    const { user, router } = boot('/discover');
    await shownTitle();
    expect(suggested().getByText(/backlog|randomly selected/i)).toBeInTheDocument();
    await user.click(suggested().getByRole('link', { name: /open details/i }));
    await waitFor(() => {
      expect(router.state.location.pathname).toMatch(/^\/library\//);
    });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('can be limited to one genre, and says which one is chosen', async () => {
    const { user } = boot('/discover');
    await shownTitle();
    await user.click(await screen.findByRole('button', { name: /^Comedy/ }));
    expect(screen.getByRole('button', { name: /^Comedy/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Anything' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    for (let i = 0; i < 6; i++) {
      expect(await shownTitle()).toMatch(/^Comedy/);
      await user.click(screen.getByRole('button', { name: 'Pick another' }));
    }
  });

  it('starts on the genre named in the address (from the Genres page)', async () => {
    boot('/discover?genre=Comedy');
    expect(await shownTitle()).toMatch(/^Comedy/);
    expect(screen.getByRole('button', { name: /^Comedy/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('only lists genres that still have something unwatched', async () => {
    library = [title(1, 'Only Drama', 'Drama'), title(2, 'Seen Western', 'Western', true)];
    boot('/discover');
    await shownTitle();
    expect(screen.getByRole('button', { name: /^Drama/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Western/ })).not.toBeInTheDocument();
  });

  it('falls back to the balanced pick when the requested genre has nothing', async () => {
    boot('/discover?genre=Western');
    expect(await shownTitle()).not.toBe('');
  });
});

describe('a suggestion that goes stale', () => {
  it('is replaced by a notice when the title is deleted while it is on screen', async () => {
    library = [title(1, 'First', 'Drama'), title(2, 'Second', 'Drama')];
    const { repos, queryClient, user } = boot('/discover');
    const shown = await shownTitle();
    const repo = repos.get(OWNER_ID);
    const movie = library.find((m) => m.title === shown);
    if (!repo || !movie) throw new Error('fixture');
    expect((await repo.remove(movie.id, movie.updatedAt)).ok).toBe(true);
    await queryClient.invalidateQueries();
    expect(await screen.findByText('That title just changed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pick another' }));
    expect(await shownTitle()).not.toBe(shown);
  });
});

describe('empty and error states', () => {
  it('says so when the library is empty', async () => {
    library = [];
    boot('/discover');
    expect(await screen.findByText('Nothing to discover yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pick another' })).not.toBeInTheDocument();
  });

  it('says so when everything is watched', async () => {
    library = [title(1, 'A', 'Drama', true), title(2, 'B', 'Drama', true)];
    boot('/discover');
    expect(await screen.findByText('You’ve watched everything')).toBeInTheDocument();
  });

  it('ignores deleted titles', async () => {
    library = [
      { ...title(1, 'Deleted One', 'Drama'), deletedAt: '2026-02-01T00:00:00.000Z' },
      title(2, 'Alive', 'Drama'),
    ];
    boot('/discover');
    expect(await shownTitle()).toBe('Alive');
  });

  it('offers to try again when the library cannot be loaded and nothing is saved', async () => {
    net.down = true;
    boot('/discover');
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn’t load/i);
  });
});

describe('what was suggested lately', () => {
  it('is remembered on the device, per account, and shown next time', async () => {
    const first = boot('/discover');
    const t1 = await shownTitle();
    await first.user.click(screen.getByRole('button', { name: 'Pick another' }));
    await waitFor(async () => {
      expect((await device.history.recent(OWNER_ID, 40)).length).toBe(2);
    });
    expect(await device.history.recent(FRIEND_ID, 40)).toEqual([]);
    first.unmount();

    boot('/discover');
    const lately = await screen.findByRole('heading', { name: /suggested lately/i });
    const names = within(closestOrThrow(lately, 'section'))
      .getAllByRole('link')
      .map((a) => a.textContent);
    expect(names).toContain(t1);
  });

  it('does not show another account’s history', async () => {
    const first = boot('/discover');
    await shownTitle();
    await waitFor(async () => {
      expect((await device.history.recent(OWNER_ID, 40)).length).toBe(1);
    });
    first.unmount();
    boot('/discover', { signedInAs: FRIEND_ID });
    await shownTitle();
    expect(screen.queryByRole('heading', { name: /suggested lately/i })).toBeInTheDocument();
    // the friend's list holds only what the friend was shown in this visit
    expect(await device.history.recent(FRIEND_ID, 40)).toHaveLength(1);
  });

  it('works without any device storage', async () => {
    boot('/discover', { withDevice: false });
    expect(await shownTitle()).not.toBe('');
  });

  it('does not record anything from the home screen', async () => {
    boot('/');
    await screen.findByText(/waiting to be watched/i);
    expect(await device.history.recent(OWNER_ID, 40)).toEqual([]);
  });
});

describe('posters and TMDB details', () => {
  it('draws the TMDB poster over the placeholder on library cards, small size', async () => {
    const metadata = fakeMetadata({ 'Drama One': found('/drama1.jpg') });
    boot('/library', { metadata });
    const card = await screen.findByRole('link', { name: cardName('Drama One (2001)') });
    await waitFor(() => {
      expect(card.querySelector('img')).toHaveAttribute(
        'src',
        'https://image.tmdb.org/t/p/w342/drama1.jpg',
      );
    });
    expect(card.querySelector('img')).toHaveAttribute('referrerpolicy', 'no-referrer');
    // a title TMDB does not know keeps its placeholder
    const other = await screen.findByRole('link', { name: cardName('Drama Two (2002)') });
    expect(other.querySelector('img')).toBeNull();
  });

  it('falls back to the placeholder when the image cannot load', async () => {
    const metadata = fakeMetadata({ 'Drama One': found('/broken.jpg') });
    boot('/library', { metadata });
    const card = await screen.findByRole('link', { name: cardName('Drama One (2001)') });
    const img = await waitFor(() => {
      const el = card.querySelector('img');
      if (!el) throw new Error('poster not drawn yet');
      return el;
    });
    fireEvent.error(img);
    await waitFor(() => {
      expect(card.querySelector('img')).toBeNull();
    });
    expect(card).toHaveTextContent('DO');
  });

  it('shows nothing extra and does not fail when the poster service is unavailable', async () => {
    const metadata: MetadataService = {
      lookup: () => Promise.resolve({ kind: 'unavailable', failure: 'not_configured' }),
      trailerKey: () => Promise.resolve(null),
      clear: () => Promise.resolve(),
    };
    boot('/library', { metadata });
    const card = await screen.findByRole('link', { name: cardName('Drama One (2001)') });
    expect(card.querySelector('img')).toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('has no posters and makes no lookups without a metadata service (sample data)', async () => {
    boot('/library');
    const card = await screen.findByRole('link', { name: cardName('Drama One (2001)') });
    expect(card.querySelector('img')).toBeNull();
  });

  it('shows overview, rating and the exact trailer in the detail view', async () => {
    const metadata = fakeMetadata(
      { 'Drama One': found('/d.jpg', 'A drama about drama.') },
      { 'Drama One': 'abcDEF12345' },
    );
    boot('/library', { metadata });
    const { user } = { user: (await import('@testing-library/user-event')).default.setup() };
    await user.click(await screen.findByRole('link', { name: cardName('Drama One (2001)') }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('A drama about drama.')).toBeInTheDocument();
    expect(within(dialog).getByText(/TMDB 8\.2/)).toBeInTheDocument();
    expect(within(dialog).getByRole('img', { name: 'Poster for Drama One' })).toHaveAttribute(
      'src',
      'https://image.tmdb.org/t/p/w500/d.jpg',
    );
    const link = await within(dialog).findByRole('link', { name: /watch the trailer/i });
    expect(link).toHaveAttribute('href', 'https://www.youtube.com/watch?v=abcDEF12345');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('falls back to a YouTube search when no trailer is known', async () => {
    boot('/library', { metadata: fakeMetadata({ 'Drama One': found('/d.jpg') }) });
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent
      .setup()
      .click(await screen.findByRole('link', { name: cardName('Drama One (2001)') }));
    const dialog = await screen.findByRole('dialog');
    const link = await within(dialog).findByRole('link', { name: /find the trailer on youtube/i });
    expect(link).toHaveAttribute(
      'href',
      'https://www.youtube.com/results?search_query=Drama%20One%20official%20trailer',
    );
  });

  it('uses the poster on the Discover card', async () => {
    library = [title(1, 'Only One', 'Drama')];
    boot('/discover', {
      metadata: fakeMetadata({ 'Only One': found('/only.jpg', 'The only one.') }),
    });
    await shownTitle();
    await waitFor(() => {
      expect(suggested().getByRole('img')).toHaveAttribute(
        'src',
        'https://image.tmdb.org/t/p/w500/only.jpg',
      );
    });
    expect(await suggested().findByText('The only one.')).toBeInTheDocument();
  });

  it('tries again later after a temporary failure instead of remembering "no poster"', async () => {
    let up = false;
    const metadata: MetadataService = {
      lookup: () =>
        Promise.resolve<Lookup>(
          up ? found('/later.jpg') : { kind: 'unavailable', failure: 'unavailable' },
        ),
      trailerKey: () => Promise.resolve(null),
      clear: () => Promise.resolve(),
    };
    const { user } = boot('/library', { metadata });
    const card = await screen.findByRole('link', { name: cardName('Drama One (2001)') });
    await waitFor(() => {
      expect(card).toBeInTheDocument();
    });
    expect(card.querySelector('img')).toBeNull();
    up = true;
    await user.click(screen.getByRole('link', { name: 'Genres' }));
    await screen.findByRole('heading', { name: 'Every world has a story.' });
    await user.click(screen.getByRole('link', { name: 'Library' }));
    const again = await screen.findByRole('link', { name: cardName('Drama One (2001)') });
    await waitFor(() => {
      expect(again.querySelector('img')).toHaveAttribute(
        'src',
        'https://image.tmdb.org/t/p/w342/later.jpg',
      );
    });
  });

  it('keeps every lookup in the in-memory cache under the signed-in account’s private key', async () => {
    const { queryClient } = boot('/library', {
      metadata: fakeMetadata({ 'Drama One': found('/x.jpg') }),
    });
    await waitFor(() => {
      expect(
        screen.getByRole('link', { name: cardName('Drama One (2001)') }).querySelector('img'),
      ).not.toBeNull();
    });
    const keys = queryClient
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey)
      .filter((k) => JSON.stringify(k).includes('metadata'));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key.slice(0, 2)).toEqual(['u', OWNER_ID]);
  });

  it('closing the detail view does not take the poster away from the card that is still waiting', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const signals: (AbortSignal | undefined)[] = [];
    const client: TmdbClient = {
      search: async (query, signal) => {
        signals.push(signal);
        await gate;
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return [
          {
            id: 5,
            media_type: 'movie',
            title: query,
            release_date: '2001-01-01',
            poster_path: '/gate.jpg',
            vote_average: 7,
            overview: 'x',
          },
        ];
      },
      videos: () => Promise.resolve([]),
    };
    const { user } = boot('/library', {
      metadata: createMetadataService({ client, store: device.metadata }),
    });
    // Opening the detail view starts a trailer lookup that shares the card's pending poster lookup.
    await user.click(await screen.findByRole('link', { name: cardName('Drama One (2001)') }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    release();
    await waitFor(() => {
      expect(
        screen.getByRole('link', { name: cardName('Drama One (2001)') }).querySelector('img'),
      ).toHaveAttribute('src', 'https://image.tmdb.org/t/p/w342/gate.jpg');
    });
    expect(signals.every((signal) => signal === undefined)).toBe(true);
  });

  it('says what TMDB matched when it is not the same title, and stays quiet when it is', async () => {
    boot('/library', {
      metadata: fakeMetadata({
        'Drama One': found('/d.jpg', 'o', 'Drama 1: The Remake'),
        'Drama Two': found('/d2.jpg', 'o', 'The Drama Two'),
      }),
    });
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: cardName('Drama One (2001)') }));
    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText(/Matched on TMDB as “Drama 1: The Remake” \(2001\)/),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await user.click(await screen.findByRole('link', { name: cardName('Drama Two (2002)') }));
    const second = await screen.findByRole('dialog');
    await within(second).findByText('o');
    expect(within(second).queryByText(/Matched on TMDB/)).not.toBeInTheDocument();
  });

  it('keeps one account’s lookups out of another account’s screen', async () => {
    const metadata = fakeMetadata({ 'Drama One': found('/mine.jpg') });
    const first = boot('/library', { metadata });
    await waitFor(() => {
      expect(
        screen.getByRole('link', { name: cardName('Drama One (2001)') }).querySelector('img'),
      ).not.toBeNull();
    });
    first.unmount();
    const friendMetadata = fakeMetadata({});
    boot('/library', { metadata: friendMetadata, signedInAs: FRIEND_ID });
    const card = await screen.findByRole('link', { name: cardName('Drama One (2001)') });
    await waitFor(() => {
      expect(friendMetadata.asked).toContain('Drama One');
    });
    expect(card.querySelector('img')).toBeNull();
  });
});

describe('Genres and Home', () => {
  it('lists every genre with its counts and links to Browse and Discover', async () => {
    boot('/genres');
    const drama = rowOf(await screen.findByRole('heading', { name: 'Drama' }));
    expect(drama).toHaveTextContent('4 titles · 3 to watch');
    expect(within(drama).getByRole('link', { name: 'Browse' })).toHaveAttribute(
      'href',
      '/library?genre=Drama',
    );
    expect(within(drama).getByRole('link', { name: /pick one to watch/i })).toHaveAttribute(
      'href',
      '/discover?genre=Drama',
    );
    const comedy = rowOf(screen.getByRole('heading', { name: 'Comedy' }));
    expect(comedy).toHaveTextContent('3 titles · 2 to watch');
  });

  it('groups titles without a genre, which cannot be browsed by genre but can be drawn from', async () => {
    library = [title(1, 'No Genre', null), title(2, 'Seen', 'Drama', true)];
    boot('/genres');
    const row = rowOf(await screen.findByRole('heading', { name: 'Uncategorized' }));
    expect(within(row).queryByRole('link', { name: 'Browse' })).not.toBeInTheDocument();
    expect(within(row).getByRole('link', { name: /pick one to watch/i })).toBeInTheDocument();
    const drama = rowOf(screen.getByRole('heading', { name: 'Drama' }));
    expect(within(drama).queryByRole('link', { name: /pick one/i })).not.toBeInTheDocument();
  });

  it('does not count deleted titles', async () => {
    library = [
      { ...title(1, 'Gone', 'Noir'), deletedAt: '2026-02-01T00:00:00.000Z' },
      title(2, 'Here', 'Drama'),
    ];
    boot('/genres');
    await screen.findByRole('heading', { name: 'Drama' });
    expect(screen.queryByRole('heading', { name: 'Noir' })).not.toBeInTheDocument();
  });

  it('home shows the backlog and offers Discover only when there is something to watch', async () => {
    boot('/');
    expect(
      await screen.findByText('7 titles in your vault, 5 waiting to be watched.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /what should i watch tonight/i })).toHaveAttribute(
      'href',
      '/discover',
    );
  });

  it('home hides the Discover shortcut when everything is watched', async () => {
    library = [title(1, 'A', 'Drama', true)];
    boot('/');
    expect(await screen.findByText('1 title in your vault.')).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /what should i watch tonight/i }),
    ).not.toBeInTheDocument();
  });
});

describe('offline', () => {
  it('Discover keeps working from the saved copy, with history and no lookups', async () => {
    const auth = createFakeAuth(accounts(), OWNER_ID);
    const profiles = createFakeProfiles(roles);
    const { createDexieLibraryCache } = await import('@/data/local/dexieLibraryCache');
    const cache = createDexieLibraryCache({ indexedDB: factory, IDBKeyRange });
    const run = (path: string) =>
      renderFullApp({
        auth,
        profiles,
        path,
        cache,
        libraryFor: () => library,
        networkDown: () => net.down,
        device: { history: device.history, metadata: null },
      });

    const first = run('/library');
    await screen.findByRole('link', { name: cardName('Drama One (2001)') });
    await waitFor(async () => {
      expect(await cache.read(OWNER_ID)).not.toBeNull();
    });
    first.unmount();

    net.down = true;
    onlineManager.setOnline(false);
    profiles.failNext(networkFailure);
    run('/discover');
    expect(await shownTitle()).not.toBe('');
    expect(await screen.findByText(/can’t reach the server/i)).toBeInTheDocument();
    expect(screen.queryByText('Seen Drama')).not.toBeInTheDocument();
  });
});

describe('films and series', () => {
  beforeEach(() => {
    library = [
      title(1, 'Film One', 'Drama'),
      title(2, 'Film Two', 'Drama'),
      title(3, 'Show One', 'Drama', false, 'tv'),
      title(4, 'Show Two', 'Thriller', false, 'tv'),
    ];
  });

  const chip = (name: RegExp) => screen.getByRole('button', { name });

  it('shows how many of each can be picked and starts with both', async () => {
    boot('/discover');
    await shownTitle();
    expect(chip(/^Everything/)).toHaveTextContent('4');
    expect(chip(/^Films/)).toHaveTextContent('2');
    expect(chip(/^Series/)).toHaveTextContent('2');
    expect(chip(/^Everything/)).toHaveAttribute('aria-pressed', 'true');
  });

  it('draws only series after choosing Series, however often it picks again', async () => {
    const { user } = boot('/discover');
    await shownTitle();
    await user.click(chip(/^Series/));
    expect(chip(/^Series/)).toHaveAttribute('aria-pressed', 'true');
    for (let i = 0; i < 12; i++) {
      await waitFor(async () => {
        expect(await shownTitle()).toMatch(/^Show/);
      });
      await user.click(screen.getByRole('button', { name: 'Pick another' }));
    }
  });

  it('draws only films after choosing Films', async () => {
    const { user } = boot('/discover');
    await shownTitle();
    await user.click(chip(/^Films/));
    for (let i = 0; i < 12; i++) {
      await waitFor(async () => {
        expect(await shownTitle()).toMatch(/^Film/);
      });
      await user.click(screen.getByRole('button', { name: 'Pick another' }));
    }
  });

  it('starts on the type named in the address', async () => {
    boot('/discover?type=tv');
    expect(await shownTitle()).toMatch(/^Show/);
    expect(chip(/^Series/)).toHaveAttribute('aria-pressed', 'true');
  });

  it('ignores an unknown type in the address', async () => {
    boot('/discover?type=podcast');
    await shownTitle();
    expect(chip(/^Everything/)).toHaveAttribute('aria-pressed', 'true');
  });

  it('only lists the genres that exist in the chosen type, and drops a genre that vanished', async () => {
    const { user } = boot('/discover?genre=Thriller');
    expect(await shownTitle()).toBe('Show Two');
    await user.click(chip(/^Films/));
    expect(screen.queryByRole('button', { name: /^Thriller/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Anything/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await shownTitle()).toMatch(/^Film/);
  });

  it('explains an empty type instead of showing nothing, and offers the way out', async () => {
    library = [title(1, 'Film One', 'Drama'), title(2, 'Seen Show', 'Drama', true, 'tv')];
    const { user } = boot('/discover');
    await shownTitle();
    expect(chip(/^Series/)).toHaveTextContent('0');
    await user.click(chip(/^Series/));
    expect(await screen.findByText('No unwatched series to suggest')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show everything' }));
    expect(await shownTitle()).toBe('Film One');
  });
});

describe('"Not now"', () => {
  const idOf = (name: string) => library.find((m) => m.title === name)?.id ?? '';

  it('hides the title, picks another, and remembers it on this device', async () => {
    library = [title(1, 'Only A', 'Drama'), title(2, 'Only B', 'Drama')];
    const first = boot('/discover');
    const hidden = await shownTitle();
    await first.user.click(screen.getByRole('button', { name: 'Not now' }));
    const other = hidden === 'Only A' ? 'Only B' : 'Only A';
    await waitFor(async () => {
      expect(await shownTitle()).toBe(other);
    });
    expect(screen.getByRole('status')).toHaveTextContent('1 title is hidden for 7 days');
    await waitFor(async () => {
      expect(await device.snoozes.active(OWNER_ID, new Date())).toEqual([idOf(hidden)]);
    });
    first.unmount();

    boot('/discover');
    for (let i = 0; i < 3; i++) {
      expect(await shownTitle()).toBe(other);
    }
  });

  it('never suggests a hidden title again while it is hidden', async () => {
    const { user } = boot('/discover');
    const hidden = await shownTitle();
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    for (let i = 0; i < 20; i++) {
      await waitFor(async () => {
        expect(await shownTitle()).not.toBe(hidden);
      });
      await user.click(screen.getByRole('button', { name: 'Pick another' }));
    }
  });

  it('says so when everything is hidden, and brings it all back on request', async () => {
    library = [title(1, 'Only A', 'Drama')];
    const { user } = boot('/discover');
    await shownTitle();
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(await screen.findByText('Everything that fits is hidden for now')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show hidden titles' }));
    expect(await shownTitle()).toBe('Only A');
    expect(await device.snoozes.active(OWNER_ID, new Date())).toEqual([]);
  });

  it('lets a person undo it from the notice', async () => {
    const { user } = boot('/discover');
    const hidden = await shownTitle();
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    await user.click(await screen.findByRole('button', { name: /Show it again/ }));
    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
    expect(await device.snoozes.active(OWNER_ID, new Date())).toEqual([]);
    expect(hidden).not.toBe('');
  });

  it('lets a title come back once its time is up', async () => {
    library = [title(1, 'Only A', 'Drama')];
    await device.snoozes.snooze(
      OWNER_ID,
      idOf('Only A'),
      new Date(Date.now() - 1000),
      new Date(Date.now() - 2000),
    );
    boot('/discover');
    expect(await shownTitle()).toBe('Only A');
  });

  it('hides a title that is still within its time on the next visit', async () => {
    library = [title(1, 'Only A', 'Drama'), title(2, 'Only B', 'Drama')];
    await device.snoozes.snooze(
      OWNER_ID,
      idOf('Only A'),
      new Date(Date.now() + 60_000),
      new Date(),
    );
    boot('/discover');
    expect(await shownTitle()).toBe('Only B');
  });

  it('does not carry over to another account', async () => {
    library = [title(1, 'Only A', 'Drama')];
    await device.snoozes.snooze(
      OWNER_ID,
      idOf('Only A'),
      new Date(Date.now() + 60_000),
      new Date(),
    );
    boot('/discover', { signedInAs: FRIEND_ID });
    expect(await shownTitle()).toBe('Only A');
  });

  it('still works for this visit when the device keeps nothing', async () => {
    library = [title(1, 'Only A', 'Drama'), title(2, 'Only B', 'Drama')];
    const { user } = boot('/discover', { withDevice: false });
    const hidden = await shownTitle();
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(async () => {
      expect(await shownTitle()).not.toBe(hidden);
    });
    await user.click(screen.getByRole('button', { name: 'Pick another' }));
    await waitFor(async () => {
      expect(await shownTitle()).not.toBe(hidden);
    });
  });
});

describe('old history and explanations', () => {
  it('does not show, or let steer, what was suggested more than a month ago', async () => {
    const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
    await device.history.record(OWNER_ID, {
      movieId: library[0]?.id ?? '',
      genres: ['Drama'],
      result: 'recommended',
      at: old,
    });
    boot('/discover');
    await shownTitle();
    // the only entry shown lately is the one made on this visit, never the 45-day-old one
    const lately = await screen.findByRole('heading', { name: /suggested lately/i });
    const names = within(closestOrThrow(lately, 'section')).getAllByRole('link');
    expect(names).toHaveLength(1);
  });

  it('ignores a history entry dated in the future', async () => {
    await device.history.record(OWNER_ID, {
      movieId: library[0]?.id ?? '',
      genres: ['Drama'],
      result: 'recommended',
      at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });
    boot('/discover');
    await shownTitle();
    const lately = await screen.findByRole('heading', { name: /suggested lately/i });
    expect(within(closestOrThrow(lately, 'section')).getAllByRole('link')).toHaveLength(1);
  });

  it('explains the pick with facts taken from the library', async () => {
    boot('/discover');
    await shownTitle();
    const list = screen.getByRole('list', { name: 'Why this one' });
    const text = list.textContent;
    expect(text).toMatch(/On your list|Added recently/);
    expect(text).toMatch(/You(’ve| haven’t) watched/);
    expect(text).toMatch(/About 1 h 40 min\./);
  });
});
