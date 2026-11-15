import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { moviesKey } from '@/app/privateKey';
import { MOCK_OWNER_ID, buildMovie, createSeedMovies, generateMovies } from '@/data/mock/fixtures';
import { PAGE_SIZE } from '@/features/library/LibraryPage';
import { findOrThrow, first, must } from '../helpers';
import { renderApp } from '../renderApp';
import { cardName } from '../cardName';

afterEach(() => {
  vi.restoreAllMocks();
});

const SEED_COUNT = createSeedMovies().length;
const cards = () =>
  screen
    .queryAllByRole('link', { name: /\(\d{4}\)$|^[^(]+$/ })
    .filter(
      (el) =>
        el.getAttribute('href')?.startsWith('/library/') &&
        !/\/(new|edit)/.test(el.getAttribute('href') ?? ''),
    );
const card = (name: RegExp | string) =>
  screen.findByRole('link', { name: typeof name === 'string' ? cardName(name) : name });
const dialog = () => screen.findByRole('dialog');

describe('library: loading, error and empty states', () => {
  it('shows a loading state, then the titles', async () => {
    renderApp();
    expect(screen.getByText(/loading your library/i)).toBeInTheDocument();
    expect(await card('Parasite (2019)')).toBeInTheDocument();
    expect(screen.queryByText(/loading your library/i)).not.toBeInTheDocument();
    expect(screen.getByText(`${String(SEED_COUNT)} titles`)).toBeInTheDocument();
  });

  it('shows an error and keeps showing it while the problem persists', async () => {
    const { user } = renderApp({
      repository: { alwaysFail: { code: 'network', message: 'down' } },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn’t reach your library/i);
    expect(screen.queryByRole('link', { name: /parasite/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /add movie/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn’t reach your library/i);
  });

  it('recovers when the retry succeeds', async () => {
    const { user } = renderApp({ failFirstCall: { code: 'network', message: 'blip' } });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await card('Parasite (2019)')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not retry a forbidden response, and says access is the problem', async () => {
    renderApp({ repository: { alwaysFail: { code: 'forbidden', message: 'no' } } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/don’t have access/i);
  });

  it('owner sees an empty vault with a way to add the first title', async () => {
    renderApp({ repository: { seed: [] } });
    expect(
      await screen.findByRole('heading', { name: /your vault is empty/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /add your first title/i })).toBeInTheDocument();
  });

  it('viewer sees an empty vault without any add action', async () => {
    renderApp({ role: 'viewer', repository: { seed: [] } });
    expect(
      await screen.findByRole('heading', { name: /your vault is empty/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /add/i })).not.toBeInTheDocument();
    expect(screen.getByText(/nothing to browse yet/i)).toBeInTheDocument();
  });
});

describe('library: search, filters and URL state', () => {
  it('search narrows the grid, is reflected in the URL, and can be cleared', async () => {
    const { user, router } = renderApp();
    await card('Parasite (2019)');
    await user.type(screen.getByRole('searchbox', { name: /search library/i }), 'dark');
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: /parasite/i })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /the dark knight/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: cardName('Dark (2017)') })).toBeInTheDocument();
    expect(router.state.location.search).toBe('?q=dark');
    expect(screen.getByText(/2 of \d+ titles/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(await card('Parasite (2019)')).toBeInTheDocument();
    expect(router.state.location.search).toBe('');
  });

  it('shows a helpful empty result with a clear action', async () => {
    const { user } = renderApp();
    await card('Parasite (2019)');
    await user.type(screen.getByRole('searchbox'), 'zzzzqqqq');
    expect(await screen.findByRole('heading', { name: /no titles match/i })).toBeInTheDocument();
    await user.click(first(screen.getAllByRole('button', { name: /^clear filters$/i })));
    expect(await card('Parasite (2019)')).toBeInTheDocument();
  });

  it('filters by type and status together', async () => {
    const { user, router } = renderApp();
    await card('Parasite (2019)');
    await user.selectOptions(screen.getByLabelText('Type'), 'tv');
    await user.selectOptions(screen.getByLabelText('Status'), 'unwatched');
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: /parasite/i })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /severance/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /breaking bad/i })).not.toBeInTheDocument();
    expect(router.state.location.search).toContain('type=tv');
    expect(router.state.location.search).toContain('status=unwatched');
  });

  it('restores filters from the URL on load and ignores junk values', async () => {
    renderApp({ path: '/library?type=tv&sort=<script>&rating=99' });
    expect(await card(/severance/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /parasite/i })).not.toBeInTheDocument();
  });

  it('pages the grid instead of rendering everything at once', async () => {
    const { user } = renderApp({ repository: { seed: generateMovies(PAGE_SIZE * 2 + 10) } });
    await screen.findByRole('button', { name: /show more/i });
    expect(cards()).toHaveLength(PAGE_SIZE);
    await user.click(screen.getByRole('button', { name: /show more/i }));
    expect(cards()).toHaveLength(PAGE_SIZE * 2);
    await user.click(screen.getByRole('button', { name: /show more/i }));
    expect(cards()).toHaveLength(PAGE_SIZE * 2 + 10);
    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument();
  });

  it('keeps filters when a title is opened and closed', async () => {
    const { user, router } = renderApp({ path: '/library?type=tv' });
    await user.click(await card(/severance/i));
    expect(router.state.location.pathname).toMatch(/^\/library\/.+/);
    expect(router.state.location.search).toBe('?type=tv');
    await user.click(within(await dialog()).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(router.state.location.pathname).toBe('/library');
    expect(router.state.location.search).toBe('?type=tv');
  });
});

describe('detail dialog', () => {
  it('shows the facts of a title', async () => {
    const { user } = renderApp();
    await user.click(await card('#Manhole (2023)'));
    const d = await dialog();
    expect(within(d).getByRole('heading', { name: '#Manhole' })).toBeInTheDocument();
    expect(within(d).getByText(/watched on 20 oct 2026/i)).toBeInTheDocument();
    expect(within(d).getByText('1 h 40 min')).toBeInTheDocument();
    expect(within(d).getByText(/uneven finish/i)).toBeInTheDocument();
  });

  it('a deep link opens the dialog once the library has loaded', async () => {
    const id = findOrThrow(createSeedMovies(), (m) => m.title === 'Parasite').id;
    renderApp({ path: `/library/${id}` });
    expect(await screen.findByRole('dialog', { name: 'Parasite' })).toBeInTheDocument();
  });

  it('an unknown id says the title is not in the library', async () => {
    renderApp({ path: '/library/00000000-0000-4000-8000-00000000ffff' });
    expect(await screen.findByText(/isn’t in your library/i)).toBeInTheDocument();
  });

  it('closes with Escape', async () => {
    const { user } = renderApp();
    await user.click(await card('Parasite (2019)'));
    await dialog();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('moves focus in, traps Tab, and returns focus to the card on close', async () => {
    const { user } = renderApp();
    const opener = await card('Parasite (2019)');
    await user.click(opener);
    const d = await dialog();
    await waitFor(() => {
      expect(d.contains(document.activeElement)).toBe(true);
    });
    for (let i = 0; i < 25; i++) {
      await user.tab();
      expect(d.contains(document.activeElement)).toBe(true);
    }
    await user.tab({ shift: true });
    expect(d.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });

  it('only renders a clickable link for http(s) screenshot URLs', async () => {
    const base = createSeedMovies();
    const poisoned = {
      ...buildMovie(0, ['Poisoned', 'movie', 2020, null, null, null, 'unwatched', null]),
      shotLink: 'javascript:alert(1)',
    };
    const good = {
      ...buildMovie(1, ['Healthy', 'movie', 2021, null, null, null, 'unwatched', null]),
      shotLink: 'https://example.com/shot.png',
    };
    expect(base.length).toBeGreaterThan(0);
    const { user } = renderApp({ repository: { seed: [poisoned, good] } });

    await user.click(await card('Poisoned (2020)'));
    let d = await dialog();
    expect(within(d).getByText('javascript:alert(1)')).toBeInTheDocument();
    expect(within(d).queryByRole('link', { name: /javascript/i })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    await user.click(await card('Healthy (2021)'));
    d = await dialog();
    const link = within(d).getByRole('link', { name: /example\.com/ });
    expect(link).toHaveAttribute('href', 'https://example.com/shot.png');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
  });
});

describe('rating (set, change, clear)', () => {
  it('sets a rating, changes it, and clears it by pressing the active star', async () => {
    const { user, repository } = renderApp();
    await user.click(await card('Fargo (2014)')); // unrated in the seed
    const d = await dialog();
    expect(within(d).getByText('Not rated')).toBeInTheDocument();
    expect(within(d).queryByRole('button', { name: /clear rating/i })).not.toBeInTheDocument();

    await user.click(within(d).getByRole('button', { name: 'Rate 3 out of 5' }));
    expect(await within(d).findByText(/3 \/ 5 · Decent/)).toBeInTheDocument();
    const fargo = () => findOrThrow(repository.snapshot(), (m) => m.title === 'Fargo');
    expect(fargo().userRating).toBe(3);

    await user.click(within(d).getByRole('button', { name: 'Rate 5 out of 5' }));
    expect(await within(d).findByText(/5 \/ 5 · Masterpiece/)).toBeInTheDocument();
    expect(fargo().userRating).toBe(5);

    // The original complaint: once rated there was no way to take it back.
    await user.click(within(d).getByRole('button', { name: 'Rate 5 out of 5' }));
    expect(await within(d).findByText('Not rated')).toBeInTheDocument();
    expect(fargo().userRating).toBeNull();
  });

  it('has an explicit Clear rating button', async () => {
    const { user } = renderApp();
    await user.click(await card('Parasite (2019)')); // rated 5
    const d = await dialog();
    await user.click(within(d).getByRole('button', { name: /clear rating/i }));
    expect(await within(d).findByText('Not rated')).toBeInTheDocument();
    expect(within(d).queryByRole('button', { name: /clear rating/i })).not.toBeInTheDocument();
  });

  it('shows a half-point rating faithfully and replaces it with a whole star', async () => {
    const { user } = renderApp();
    await user.click(await card('Whiplash (2014)')); // 4.5
    const d = await dialog();
    expect(within(d).getByText(/4\.5 \/ 5/)).toBeInTheDocument();
    await user.click(within(d).getByRole('button', { name: 'Rate 4 out of 5' }));
    expect(await within(d).findByText(/^4 \/ 5/)).toBeInTheDocument();
  });

  it('tells the user when a quick rating could not be saved', async () => {
    const { user, repository } = renderApp();
    await user.click(await card('Fargo (2014)'));
    const d = await dialog();
    const id = findOrThrow(repository.snapshot(), (m) => m.title === 'Fargo').id;
    repository.simulateRemoteEdit(id, { verdict: 'changed on another device' });
    await user.click(within(d).getByRole('button', { name: 'Rate 4 out of 5' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed somewhere else/i);
  });
});

describe('add a title', () => {
  const openAdd = async (user: ReturnType<typeof renderApp>['user']) => {
    await card('Parasite (2019)');
    await user.click(screen.getByRole('link', { name: /add movie/i }));
    return dialog();
  };

  it('validates before saving and focuses the first problem', async () => {
    const { user } = renderApp();
    const d = await openAdd(user);
    await user.click(within(d).getByRole('button', { name: /add to library/i }));
    expect(await within(d).findByText('Title is required')).toBeInTheDocument();
    await waitFor(() => {
      expect(within(d).getByLabelText('Title')).toHaveFocus();
    });
  });

  it('rejects impossible values with plain-language messages', async () => {
    const { user } = renderApp();
    const d = await openAdd(user);
    await user.type(within(d).getByLabelText('Title'), 'Valid Title');
    await user.type(within(d).getByLabelText('Year'), '1500');
    await user.click(within(d).getByRole('button', { name: /add to library/i }));
    expect(await within(d).findByText(/year must be 1888 or later/i)).toBeInTheDocument();
    await user.type(within(d).getByLabelText('Screenshot link'), 'javascript:alert(1)');
    await user.click(within(d).getByRole('button', { name: /add to library/i }));
    expect(await within(d).findByText(/full link starting with http/i)).toBeInTheDocument();
  });

  it('adds a title, shows a confirmation, and the card appears', async () => {
    const { user, repository } = renderApp();
    const d = await openAdd(user);
    await user.type(within(d).getByLabelText('Title'), '  Past   Lives ');
    await user.type(within(d).getByLabelText('Year'), '2023');
    await user.type(within(d).getByLabelText('Genre'), 'Romance, Drama');
    await user.click(within(d).getByRole('button', { name: 'Rate 4 out of 5' }));
    await user.click(within(d).getByRole('button', { name: /add to library/i }));

    expect(await card('Past Lives (2023)')).toBeInTheDocument();
    expect(screen.getByText(/added “past lives”/i)).toBeInTheDocument();
    const saved = findOrThrow(repository.snapshot(), (m) => m.title === 'Past Lives');
    expect(saved.userRating).toBe(4);
    expect(saved.genre).toBe('Romance, Drama');
    expect(saved.year).toBe(2023);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('shows a duplicate on the title field and keeps what was typed', async () => {
    const { user } = renderApp();
    const d = await openAdd(user);
    await user.type(within(d).getByLabelText('Title'), 'parasite');
    await user.type(within(d).getByLabelText('Year'), '2019');
    await user.click(within(d).getByRole('button', { name: /add to library/i }));
    expect(
      await within(d).findByText(/“Parasite” is already in your library/i),
    ).toBeInTheDocument();
    expect(within(d).getByLabelText('Title')).toHaveValue('parasite');
    expect(within(d).getByLabelText('Title')).toHaveAttribute('aria-invalid', 'true');
  });

  it('keeps the watched date consistent with the watched box', async () => {
    const { user, repository } = renderApp();
    const d = await openAdd(user);
    const box = () => within(d).getByRole('checkbox', { name: /i’ve watched this/i });
    expect(within(d).queryByLabelText('Watched on')).not.toBeInTheDocument();

    await user.click(box());
    await user.type(within(d).getByLabelText('Watched on'), '2026-10-20');
    await user.click(box()); // un-watching must discard the date
    expect(within(d).queryByLabelText('Watched on')).not.toBeInTheDocument();
    await user.type(within(d).getByLabelText('Title'), 'Not Watched Yet');
    await user.click(within(d).getByRole('button', { name: /add to library/i }));

    await card('Not Watched Yet');
    const saved = findOrThrow(repository.snapshot(), (m) => m.title === 'Not Watched Yet');
    expect(saved.watched).toBe(false);
    expect(saved.watchedOn).toBeNull();
  });

  it('saves a watched date when the title is watched', async () => {
    const { user, repository } = renderApp();
    const d = await openAdd(user);
    await user.type(within(d).getByLabelText('Title'), 'Seen It');
    await user.click(within(d).getByRole('checkbox', { name: /i’ve watched this/i }));
    await user.type(within(d).getByLabelText('Watched on'), '2026-10-20');
    await user.click(within(d).getByRole('button', { name: /add to library/i }));
    await card('Seen It');
    const saved = findOrThrow(repository.snapshot(), (m) => m.title === 'Seen It');
    expect(saved.watched).toBe(true);
    expect(saved.watchedOn).toBe('2026-10-20');
  });

  it('reports a failed save without losing the form', async () => {
    const { user, repository } = renderApp();
    const d = await openAdd(user);
    await user.type(within(d).getByLabelText('Title'), 'Offline Film');
    repository.failNext({ code: 'network', message: 'Network down.' });
    await user.click(within(d).getByRole('button', { name: /add to library/i }));
    expect(await within(d).findByText('Network down.')).toBeInTheDocument();
    expect(within(d).getByLabelText('Title')).toHaveValue('Offline Film');
    // and a retry works
    await user.click(within(d).getByRole('button', { name: /add to library/i }));
    expect(await card('Offline Film')).toBeInTheDocument();
  });
});

describe('create before the first list has loaded (cache integrity)', () => {
  it('never shows a library consisting only of the new title', async () => {
    const { user, releaseFirstList, repository, queryClient } = renderApp({
      path: '/library/new',
      holdFirstList: true,
    });
    // Record EVERY state the cached library ever holds. A bad intermediate state that a later
    // refetch happens to repair is still a bug (the user can see it, and so can other screens).
    const observedSizes: number[] = [];
    queryClient.getQueryCache().subscribe(() => {
      const data = queryClient.getQueryData<readonly unknown[]>(moviesKey(MOCK_OWNER_ID));
      if (data) observedSizes.push(data.length);
    });
    const d = await dialog();
    await user.type(within(d).getByLabelText('Title'), 'Past Lives');
    await user.type(within(d).getByLabelText('Year'), '2023');
    await user.click(within(d).getByRole('button', { name: /add to library/i }));
    await screen.findByText(/added “past lives”/i);

    // Whatever the screen shows now, it must not be a one-title library.
    expect(screen.queryByText('1 title')).not.toBeInTheDocument();

    releaseFirstList(); // the stale snapshot (taken BEFORE the create) now arrives
    await waitFor(() => {
      expect(screen.getByText(`${String(SEED_COUNT + 1)} titles`)).toBeInTheDocument();
    });
    expect(await card('Past Lives (2023)')).toBeInTheDocument();
    expect(await card('Parasite (2019)')).toBeInTheDocument();
    expect(repository.snapshot().filter((m) => m.title === 'Past Lives')).toHaveLength(1);
    // The cache only ever held complete libraries: never just the one new title.
    expect(observedSizes.length).toBeGreaterThan(0);
    expect(observedSizes.every((size) => size >= SEED_COUNT)).toBe(true);
  });
});

describe('unsaved-changes guard (every way out of a dirty form)', () => {
  const HISTORY = ['/library', '/library/new', '/settings'];

  /** Opens the add form as the middle entry of a history, so Back and Forward both exist. */
  const openDirtyAdd = async () => {
    const app = renderApp({ entries: HISTORY, index: 1 });
    const d = await dialog();
    await app.user.type(within(d).getByLabelText('Title'), 'Half typed');
    return { ...app, d };
  };
  const backdropOf = (d: HTMLElement): HTMLElement => {
    if (!d.parentElement) throw new Error('dialog has no backdrop');
    return d.parentElement;
  };

  interface Exit {
    readonly name: string;
    readonly run: (ctx: Awaited<ReturnType<typeof openDirtyAdd>>) => Promise<void>;
    readonly lands: RegExp;
  }
  const EXITS: readonly Exit[] = [
    { name: 'Escape', lands: /^\/library$/, run: async ({ user }) => user.keyboard('{Escape}') },
    {
      name: 'the close (×) button',
      lands: /^\/library$/,
      run: async ({ user, d }) => user.click(within(d).getByRole('button', { name: 'Close' })),
    },
    {
      name: 'a backdrop click',
      lands: /^\/library$/,
      run: ({ d }) => {
        fireEvent.mouseDown(backdropOf(d));
        return Promise.resolve();
      },
    },
    {
      name: 'the Cancel button',
      lands: /^\/library$/,
      run: async ({ user, d }) => user.click(within(d).getByRole('button', { name: /cancel/i })),
    },
    {
      name: 'browser Back',
      lands: /^\/library$/,
      run: async ({ router }) => {
        await act(async () => {
          await router.navigate(-1);
        });
      },
    },
    {
      name: 'browser Forward',
      lands: /^\/settings$/,
      run: async ({ router }) => {
        await act(async () => {
          await router.navigate(1);
        });
      },
    },
    {
      name: 'a link elsewhere in the app',
      lands: /^\/stats$/,
      run: async ({ user }) => user.click(screen.getByRole('link', { name: 'Stats' })),
    },
  ];

  it.each(EXITS)('$name asks first, and staying keeps what was typed', async (exit) => {
    const ctx = await openDirtyAdd();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await exit.run(ctx);
    await waitFor(() => {
      expect(confirm).toHaveBeenCalledTimes(1);
    });
    expect(confirm).toHaveBeenCalledWith('Discard your changes?');
    expect(ctx.router.state.location.pathname).toBe('/library/new');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(ctx.d).getByLabelText('Title')).toHaveValue('Half typed');
  });

  it.each(EXITS)('$name leaves once the user confirms', async (exit) => {
    const ctx = await openDirtyAdd();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await exit.run(ctx);
    await waitFor(() => {
      expect(ctx.router.state.location.pathname).toMatch(exit.lands);
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it.each(EXITS)('$name never prompts when nothing was typed', async (exit) => {
    const app = renderApp({ entries: HISTORY, index: 1 });
    const d = await dialog();
    const confirm = vi.spyOn(window, 'confirm');
    await exit.run({ ...app, d });
    await waitFor(() => {
      expect(app.router.state.location.pathname).toMatch(exit.lands);
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('does not prompt after a successful save', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const { user, d, router } = await openDirtyAdd();
    await user.click(within(d).getByRole('button', { name: /add to library/i }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/library');
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('guards the edit form too', async () => {
    const id = findOrThrow(createSeedMovies(), (m) => m.title === 'Parasite').id;
    const { user, router } = renderApp({
      entries: ['/library', `/library/${id}`, `/library/${id}/edit`],
      index: 2,
    });
    const d = await screen.findByRole('dialog', { name: /edit/i });
    await user.type(within(d).getByLabelText('Your verdict'), ' extra');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () => {
      await router.navigate(-1);
    });
    await waitFor(() => {
      expect(confirm).toHaveBeenCalledTimes(1);
    });
    expect(router.state.location.pathname).toBe(`/library/${id}/edit`);
  });

  it('asks the browser to confirm closing or reloading the tab only while dirty', async () => {
    const clean = renderApp({ entries: HISTORY, index: 1 });
    await dialog();
    const cleanEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);
    expect(clean.router).toBeTruthy();

    await clean.user.type(within(await dialog()).getByLabelText('Title'), 'x');
    const dirtyEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);
  });
});

describe('edit a title', () => {
  const openEdit = async (user: ReturnType<typeof renderApp>['user'], name: string) => {
    await user.click(await card(name));
    await user.click(within(await dialog()).getByRole('link', { name: /edit details/i }));
    return screen.findByRole('dialog', { name: /edit/i });
  };

  it('renames a title — the original “#Manhole” → “Manhole” request', async () => {
    const { user, repository } = renderApp();
    const d = await openEdit(user, '#Manhole (2023)');
    const title = within(d).getByLabelText('Title');
    expect(title).toHaveValue('#Manhole');
    await user.clear(title);
    await user.type(title, 'Manhole');
    await user.click(within(d).getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/saved changes to “manhole”/i)).toBeInTheDocument();
    const stored = findOrThrow(
      repository.snapshot(),
      (m) => m.year === 2023 && m.title === 'Manhole',
    );
    expect(stored.normalizedTitle).toBe('manhole');
    // back on the detail dialog with the new name
    expect(await screen.findByRole('dialog', { name: 'Manhole' })).toBeInTheDocument();
  });

  it('prefills every field from the stored title', async () => {
    const { user } = renderApp();
    const d = await openEdit(user, 'Whiplash (2014)');
    expect(within(d).getByLabelText('Year')).toHaveValue(2014);
    expect(within(d).getByLabelText('Runtime (min)')).toHaveValue(106);
    expect(within(d).getByLabelText('Genre')).toHaveValue('Drama, Music');
    expect(within(d).getByRole('checkbox', { name: /watched/i })).toBeChecked();
    expect(within(d).getByLabelText('Watched on')).toHaveValue('2026-05-01');
    expect(within(d).getByText(/4\.5 \/ 5/)).toBeInTheDocument();
  });

  it('refuses to rename onto another title and says why', async () => {
    const { user } = renderApp();
    const d = await openEdit(user, 'Oldboy (2003)');
    const title = within(d).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Memories of Murder');
    await user.click(within(d).getByRole('button', { name: /save changes/i }));
    // same year (2003) and type, so it collides
    expect(await within(d).findByText(/already in your library/i)).toBeInTheDocument();
  });

  it('offers explicit choices when the title changed elsewhere — and never overwrites silently', async () => {
    const { user, repository } = renderApp();
    const d = await openEdit(user, 'Roma (2018)');
    const id = findOrThrow(repository.snapshot(), (m) => m.title === 'Roma').id;
    repository.simulateRemoteEdit(id, { verdict: 'Written on my phone' });

    const verdict = within(d).getByLabelText('Your verdict');
    await user.type(verdict, 'Written on my laptop');
    await user.click(within(d).getByRole('button', { name: /save changes/i }));

    const banner = await within(d).findByText(/changed somewhere else since you opened it/i);
    expect(banner).toBeInTheDocument();
    expect(findOrThrow(repository.snapshot(), (m) => m.id === id).verdict).toBe(
      'Written on my phone',
    );

    await user.click(within(d).getByRole('button', { name: /keep mine, overwrite/i }));
    expect(await screen.findByText(/saved changes to “roma”/i)).toBeInTheDocument();
    expect(findOrThrow(repository.snapshot(), (m) => m.id === id).verdict).toBe(
      'Written on my laptop',
    );
  });

  it('still rejects a stale save after a background refresh delivered the newer copy', async () => {
    // The form must keep the version it OPENED with. If it used the live cache instead, a refetch
    // would silently re-base it and the save below would overwrite the other device's change.
    const { user, repository, queryClient } = renderApp();
    const d = await openEdit(user, 'Roma (2018)');
    const id = findOrThrow(repository.snapshot(), (m) => m.title === 'Roma').id;
    repository.simulateRemoteEdit(id, { verdict: 'Written on my phone' });
    await queryClient.invalidateQueries({ queryKey: moviesKey(MOCK_OWNER_ID) });
    await waitFor(() => {
      const cached = queryClient.getQueryData<readonly { id: string; verdict: string | null }[]>(
        moviesKey(MOCK_OWNER_ID),
      );
      expect(cached?.find((m) => m.id === id)?.verdict).toBe('Written on my phone');
    });

    await user.type(within(d).getByLabelText('Your verdict'), 'Written on my laptop');
    await user.click(within(d).getByRole('button', { name: /save changes/i }));
    expect(
      await within(d).findByText(/changed somewhere else since you opened it/i),
    ).toBeInTheDocument();
    expect(findOrThrow(repository.snapshot(), (m) => m.id === id).verdict).toBe(
      'Written on my phone',
    );
  });

  it('“Discard mine, load latest” resets the form to the other device’s version', async () => {
    const { user, repository } = renderApp();
    const d = await openEdit(user, 'Roma (2018)');
    const id = findOrThrow(repository.snapshot(), (m) => m.title === 'Roma').id;
    repository.simulateRemoteEdit(id, { verdict: 'Remote verdict' });

    await user.type(within(d).getByLabelText('Your verdict'), 'My verdict');
    await user.click(within(d).getByRole('button', { name: /save changes/i }));
    await user.click(await within(d).findByRole('button', { name: /discard mine, load latest/i }));

    await waitFor(() => {
      expect(within(d).getByLabelText('Your verdict')).toHaveValue('Remote verdict');
    });
    expect(within(d).queryByText(/changed somewhere else/i)).not.toBeInTheDocument();
    // and now saving works against the new baseline
    await user.click(within(d).getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText(/saved changes to “roma”/i)).toBeInTheDocument();
  });

  it('says so when the title was deleted elsewhere', async () => {
    const { user, repository } = renderApp();
    const d = await openEdit(user, 'Roma (2018)');
    const roma = findOrThrow(repository.snapshot(), (m) => m.title === 'Roma');
    must(await repository.remove(roma.id, roma.updatedAt));
    await user.type(within(d).getByLabelText('Your verdict'), 'x');
    await user.click(within(d).getByRole('button', { name: /save changes/i }));
    expect(await within(d).findByText(/was deleted somewhere else/i)).toBeInTheDocument();
  });
});

describe('overwriting after an edit conflict (never silent, never against an unseen version)', () => {
  /** Roma starts with no verdict. Another device writes one while this form is open. */
  const reachConflict = async () => {
    const app = renderApp();
    await app.user.click(await card('Roma (2018)'));
    await app.user.click(within(await dialog()).getByRole('link', { name: /edit details/i }));
    const d = await screen.findByRole('dialog', { name: /edit/i });
    const roma = findOrThrow(app.repository.snapshot(), (m) => m.title === 'Roma');
    app.repository.simulateRemoteEdit(roma.id, { verdict: 'Remote 1' });
    await app.user.type(within(d).getByLabelText('Your verdict'), 'Mine');
    await app.user.click(within(d).getByRole('button', { name: /save changes/i }));
    await within(d).findByText(/changed somewhere else since you opened it/i);
    const stored = () => findOrThrow(app.repository.snapshot(), (m) => m.id === roma.id);
    return { ...app, d, roma, stored };
  };
  const overwriteButton = (d: HTMLElement) =>
    within(d).getByRole('button', { name: /keep mine, overwrite/i });

  it('shows exactly what changed elsewhere and what the user edited', async () => {
    const { d } = await reachConflict();
    expect(within(d).getByRole('alert', { name: '' })).toBeTruthy();
    expect(d).toHaveTextContent(/Changed elsewhere:\s*Verdict\s*\.\s*Your edits:\s*Verdict\s*\./);
  });

  it('an ordinary save never replaces the remote change', async () => {
    const { stored } = await reachConflict();
    expect(stored().verdict).toBe('Remote 1');
  });

  it('overwrites only after an explicit click, against the version that was shown', async () => {
    const { user, d, stored } = await reachConflict();
    expect(stored().verdict).toBe('Remote 1'); // still untouched while the choice is pending
    await user.click(overwriteButton(d));
    expect(await screen.findByText(/saved changes to “roma”/i)).toBeInTheDocument();
    expect(stored().verdict).toBe('Mine');
  });

  it('refuses to overwrite if the title changed AGAIN, and shows the new differences', async () => {
    const { user, d, roma, repository, stored } = await reachConflict();
    repository.simulateRemoteEdit(roma.id, { verdict: 'Remote 2', userRating: 2 });

    await user.click(overwriteButton(d));
    expect(
      await within(d).findByText(/changed again while you were deciding/i),
    ).toBeInTheDocument();
    expect(d).toHaveTextContent(/Changed elsewhere:\s*Rating,\s*Verdict/);
    expect(stored().verdict).toBe('Remote 2'); // nothing was saved
    expect(stored().userRating).toBe(2);

    // Having now seen the latest differences, the user can decide again.
    await user.click(overwriteButton(d));
    expect(await screen.findByText(/saved changes to “roma”/i)).toBeInTheDocument();
    expect(stored().verdict).toBe('Mine');
  });

  it('refuses when the title was deleted in the meantime, and resurrects nothing', async () => {
    const { user, d, roma, repository } = await reachConflict();
    const current = findOrThrow(repository.snapshot(), (m) => m.id === roma.id);
    must(await repository.remove(current.id, current.updatedAt));

    await user.click(overwriteButton(d));
    expect(await within(d).findByText(/was deleted somewhere else/i)).toBeInTheDocument();
    const tomb = findOrThrow(repository.snapshot(), (m) => m.id === roma.id);
    expect(tomb.deletedAt).not.toBeNull();
    expect(tomb.verdict).toBe('Remote 1');
  });

  it('refuses a latest version that fails validation', async () => {
    const { user, d, roma, repository, stored } = await reachConflict();
    // simulateRemoteEdit bypasses validation on purpose: this is a corrupt stored record.
    repository.simulateRemoteEdit(roma.id, { userRating: 4.55 });
    await user.click(overwriteButton(d));
    expect(await within(d).findByText(/couldn’t verify the latest version/i)).toBeInTheDocument();
    expect(stored().userRating).toBe(4.55);
    expect(stored().verdict).toBe('Remote 1');
  });

  it('a failed lookup is reported as a failure, not as "deleted"', async () => {
    const { user, d, repository, stored } = await reachConflict();
    repository.failNext({ code: 'network', message: 'Network down.' });
    await user.click(overwriteButton(d));
    expect(await within(d).findByText('Network down.')).toBeInTheDocument();
    expect(within(d).queryByText(/was deleted somewhere else/i)).not.toBeInTheDocument();
    expect(stored().verdict).toBe('Remote 1');
    // and the user can simply try again
    await user.click(overwriteButton(d));
    expect(await screen.findByText(/saved changes to “roma”/i)).toBeInTheDocument();
  });
});

describe('delete a title', () => {
  it('asks for confirmation, can be cancelled, then deletes', async () => {
    const { user, repository } = renderApp();
    await user.click(await card('Roma (2018)'));
    const d = await dialog();

    await user.click(within(d).getByRole('button', { name: /^delete$/i }));
    expect(screen.getByRole('alertdialog', { name: /confirm delete/i })).toHaveTextContent(/roma/i);
    await user.click(within(d).getByRole('button', { name: /keep it/i }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(repository.snapshot().some((m) => m.title === 'Roma' && m.deletedAt === null)).toBe(
      true,
    );

    await user.click(within(d).getByRole('button', { name: /^delete$/i }));
    await user.click(within(d).getByRole('button', { name: /delete title/i }));
    expect(await screen.findByText(/deleted “roma”/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: /^roma/i })).not.toBeInTheDocument();
    });
    // soft delete: the tombstone exists so the deletion can sync
    expect(findOrThrow(repository.snapshot(), (m) => m.title === 'Roma').deletedAt).not.toBeNull();
  });
});

describe('viewer (read-only)', () => {
  it('browses and searches but sees no write actions anywhere', async () => {
    const { user } = renderApp({ role: 'viewer' });
    expect(await card('Parasite (2019)')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/signed in as a viewer/i);
    expect(screen.queryByRole('link', { name: /add movie/i })).not.toBeInTheDocument();

    await user.click(await card('Parasite (2019)'));
    const d = await dialog();
    expect(within(d).queryByRole('link', { name: /edit/i })).not.toBeInTheDocument();
    expect(within(d).queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    expect(within(d).queryByRole('button', { name: /rate \d/i })).not.toBeInTheDocument();
    expect(within(d).queryByRole('button', { name: /clear rating/i })).not.toBeInTheDocument();
    expect(within(d).getByRole('img', { name: /rated 5 out of 5/i })).toBeInTheDocument();
  });

  it('deep links to the add and edit screens explain instead of showing a form', async () => {
    const add = renderApp({ role: 'viewer', path: '/library/new' });
    expect(await dialog()).toHaveTextContent(/only the owner can add/i);
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
    expect(add.repository.snapshot()).toHaveLength(SEED_COUNT);
  });

  it('edit deep link is blocked too', async () => {
    const id = findOrThrow(createSeedMovies(), (m) => m.title === 'Parasite').id;
    renderApp({ role: 'viewer', path: `/library/${id}/edit` });
    expect(await dialog()).toHaveTextContent(/only the owner can edit/i);
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
  });

  it('the repository refuses a viewer write even if the UI were bypassed', async () => {
    const { repository } = renderApp({ role: 'viewer' });
    await card('Parasite (2019)');
    const target = findOrThrow(repository.snapshot(), (m) => m.title === 'Parasite');
    const result = await repository.remove(target.id, target.updatedAt);
    expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });
});
