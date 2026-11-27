import { act, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { moviesKey } from '@/app/privateKey';
import { RepositoryContext, useMovieRepository } from '@/app/repository';
import { SessionContext, useSession } from '@/app/session';
import {
  useCreateMovie,
  useMoviesQuery,
  useRemoveMovie,
  useUpdateMovie,
} from '@/features/library/queries';
import { movieToInput } from '@/domain/movieInput';
import { findOrThrow } from '../helpers';
import { ALICE, BOB, renderAccounts } from '../AccountHarness';
import { cardName } from '../cardName';

type Harness = ReturnType<typeof renderAccounts>;

/** Lets every already-resolved promise and zero-delay timer run, so late results have landed. */
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

/** The accounts that have anything private in the cache (an account holds several queries). */
const privateOwners = (h: Harness): unknown[] => [
  ...new Set(
    h.queryClient
      .getQueryCache()
      .getAll()
      .filter((query) => query.queryKey[0] === 'u')
      .map((query) => query.queryKey[1]),
  ),
];

const link = (name: string | RegExp) =>
  screen.findByRole('link', { name: typeof name === 'string' ? cardName(name) : name });
const dialog = () => screen.findByRole('dialog');
/** A result that belongs to a previous account must not surface as ANY message to the new one. */
const noToasts = () => {
  const region = screen.getByTestId('toast-region');
  expect(within(region).queryAllByRole('status')).toHaveLength(0);
  expect(within(region).queryAllByRole('alert')).toHaveLength(0);
  expect(region).toBeEmptyDOMElement();
};

/** Alice starts adding a title; the create reaches her server but its response is held back. */
async function startPendingCreate(h: Harness) {
  const release = h.repoFor(ALICE).holdNext('create');
  await h.user.click(await screen.findByRole('link', { name: /add movie/i }));
  const d = await dialog();
  await h.user.type(within(d).getByLabelText('Title'), 'Alice Gamma');
  await h.user.type(within(d).getByLabelText('Year'), '2020');
  await h.user.click(within(d).getByRole('button', { name: /add to library/i }));
  await waitFor(() => {
    expect(
      h
        .repoFor(ALICE)
        .snapshot()
        .some((m) => m.title === 'Alice Gamma'),
    ).toBe(true);
  });
  return release;
}

/** After the switch, the new account opens one of ITS titles, so a stale `close()` would show. */
async function openBobsTitle(h: Harness) {
  await link('Bob Alpha (2011)');
  await h.user.click(screen.getByRole('link', { name: cardName('Bob Alpha (2011)') }));
  const d = await dialog();
  expect(within(d).getByText('Bob Alpha')).toBeInTheDocument();
  return d;
}

function expectBobUntouched(h: Harness) {
  expect(privateOwners(h)).toEqual([BOB]);
  expect(screen.queryByText(/Alice/)).not.toBeInTheDocument();
  expect(h.router.state.location.pathname).toMatch(/^\/library\/.+/);
  expect(screen.getByRole('dialog')).toHaveAccessibleName(/Bob Alpha/);
}

describe('account switching: cache and list', () => {
  it('removes the previous account’s cached library and keeps data separate', async () => {
    const h = renderAccounts();
    await link('Alice Alpha (2001)');
    expect(h.queryClient.getQueryData(moviesKey(ALICE))).toBeDefined();

    act(() => {
      h.signInAs(BOB);
    });
    // Gone from memory at once, not merely hidden and not after the next render.
    expect(h.queryClient.getQueryData(moviesKey(ALICE))).toBeUndefined();
    await link('Bob Alpha (2011)');
    expect(screen.queryByText(/Alice/)).not.toBeInTheDocument();
    expect(privateOwners(h)).toEqual([BOB]);
  });

  it('shows loading, never the previous account’s titles, while the new library loads', async () => {
    const h = renderAccounts({
      prepare: (repoFor) => {
        repoFor(BOB).holdNext('list');
      },
    });
    await link('Alice Alpha (2001)');
    act(() => {
      h.signInAs(BOB);
    });
    expect(await screen.findByText(/loading your library/i)).toBeInTheDocument();
    expect(screen.queryByText(/Alice/)).not.toBeInTheDocument();
    expect(h.queryClient.getQueryData(moviesKey(ALICE))).toBeUndefined();
  });

  it('ignores a list request of the previous account that is still pending', async () => {
    let releaseAlice: () => void = () => undefined;
    const h = renderAccounts({
      prepare: (repoFor) => {
        releaseAlice = repoFor(ALICE).holdNext('list');
      },
    });
    expect(await screen.findByText(/loading your library/i)).toBeInTheDocument();

    act(() => {
      h.signInAs(BOB); // Alice's list is still in flight
    });
    await link('Bob Alpha (2011)');

    releaseAlice(); // Alice's list finally arrives
    await flush();

    expect(privateOwners(h)).toEqual([BOB]);
    expect(h.queryClient.getQueryData(moviesKey(ALICE))).toBeUndefined();
    expect(screen.queryByText(/Alice/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: cardName('Bob Alpha (2011)') })).toBeInTheDocument();
  });

  it('removes a private entry for another account even if something writes it late', async () => {
    const h = renderAccounts({ start: BOB });
    await link('Bob Alpha (2011)');
    h.queryClient.setQueryData(moviesKey(ALICE), [{ title: 'Alice leak' }]);
    expect(h.queryClient.getQueryData(moviesKey(ALICE))).toBeUndefined();
    expect(privateOwners(h)).toEqual([BOB]);
  });
});

describe('account switching: pending writes', () => {
  it('a create that finishes after the switch does not touch the new account', async () => {
    const h = renderAccounts();
    await link('Alice Alpha (2001)');
    const release = await startPendingCreate(h);

    act(() => {
      h.signInAs(BOB);
    });
    await openBobsTitle(h);
    const where = h.router.state.location.pathname;

    release();
    await flush();

    expectBobUntouched(h);
    expect(h.router.state.location.pathname).toBe(where); // no stale close()/navigate
    noToasts();
    // The write was real and belongs to Alice: it is there when she comes back.
    act(() => {
      h.signInAs(ALICE);
    });
    await link('Alice Gamma (2020)');
  });

  it('an update (rating) that finishes after the switch does not touch the new account', async () => {
    const h = renderAccounts();
    await h.user.click(await link('Alice Beta (2002)'));
    const d = await dialog();
    const release = h.repoFor(ALICE).holdNext('update');
    await h.user.click(within(d).getByRole('button', { name: 'Rate 4 out of 5' }));
    await waitFor(() => {
      const saved = findOrThrow(h.repoFor(ALICE).snapshot(), (m) => m.title === 'Alice Beta');
      expect(saved.userRating).toBe(4);
    });

    act(() => {
      h.signInAs(BOB);
    });
    await openBobsTitle(h);
    release();
    await flush();

    expectBobUntouched(h);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    act(() => {
      h.signInAs(ALICE);
    });
    await waitFor(() => {
      const cached = h.queryClient.getQueryData<
        readonly { title: string; userRating: number | null }[]
      >(moviesKey(ALICE));
      expect(cached?.find((m) => m.title === 'Alice Beta')?.userRating).toBe(4);
    });
  });

  it('a delete that finishes after the switch does not touch the new account', async () => {
    const h = renderAccounts();
    await h.user.click(await link('Alice Beta (2002)'));
    const d = await dialog();
    await h.user.click(within(d).getByRole('button', { name: 'Delete' }));
    const release = h.repoFor(ALICE).holdNext('remove');
    await h.user.click(within(d).getByRole('button', { name: 'Delete title' }));
    await waitFor(() => {
      expect(
        findOrThrow(h.repoFor(ALICE).snapshot(), (m) => m.title === 'Alice Beta').deletedAt,
      ).not.toBeNull();
    });

    act(() => {
      h.signInAs(BOB);
    });
    await openBobsTitle(h);
    release();
    await flush();

    expectBobUntouched(h);
    noToasts();
    act(() => {
      h.signInAs(ALICE);
    });
    await link('Alice Alpha (2001)');
    expect(
      screen.queryByRole('link', { name: cardName('Alice Beta (2002)') }),
    ).not.toBeInTheDocument();
  });

  it('a write started in Alice’s first session is stale in her second one (A → B → A)', async () => {
    const h = renderAccounts();
    await link('Alice Alpha (2001)');
    const release = await startPendingCreate(h);

    act(() => {
      h.signInAs(BOB);
    });
    await link('Bob Alpha (2011)');
    act(() => {
      h.signInAs(ALICE);
    });
    await link('Alice Alpha (2001)');
    await h.user.click(screen.getByRole('link', { name: cardName('Alice Alpha (2001)') }));
    await dialog();
    const where = h.router.state.location.pathname;

    release();
    await flush();

    // Same user, but a different session: the old request must not close or toast anything here.
    expect(h.router.state.location.pathname).toBe(where);
    noToasts();
    expect(screen.getByRole('dialog')).toHaveAccessibleName(/Alice Alpha/);
  });
});

describe('signing out and in', () => {
  it('sign-out clears every private query and mutation and renders nothing signed-in', async () => {
    const h = renderAccounts();
    await link('Alice Alpha (2001)');

    act(() => {
      h.signOut();
    });
    expect(h.queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(h.queryClient.getMutationCache().getAll()).toHaveLength(0);
    expect(screen.queryByText(/Alice/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('signing in as someone else afterwards shows only their library', async () => {
    const h = renderAccounts();
    await link('Alice Alpha (2001)');
    act(() => {
      h.signOut();
    });
    act(() => {
      h.signInAs(BOB);
    });

    await link('Bob Alpha (2011)');
    expect(screen.queryByText(/Alice/)).not.toBeInTheDocument();
    expect(privateOwners(h)).toEqual([BOB]);
  });

  it('a write that finishes while signed out, or after another sign-in, is discarded', async () => {
    const h = renderAccounts();
    await link('Alice Alpha (2001)');
    const release = await startPendingCreate(h);

    act(() => {
      h.signOut();
    });
    release();
    await flush();
    expect(h.queryClient.getQueryCache().getAll()).toHaveLength(0);

    act(() => {
      h.signInAs(BOB);
    });
    await link('Bob Alpha (2011)');
    expect(privateOwners(h)).toEqual([BOB]);
    noToasts();
  });
});

describe('guards that do not depend on the UI', () => {
  function Probe({ into }: { readonly into: { current: Captured | null } }) {
    const create = useCreateMovie();
    const update = useUpdateMovie();
    const remove = useRemoveMovie();
    const library = useMoviesQuery();
    into.current = { create, update, remove, library };
    return null;
  }
  interface Captured {
    readonly create: ReturnType<typeof useCreateMovie>;
    readonly update: ReturnType<typeof useUpdateMovie>;
    readonly remove: ReturnType<typeof useRemoveMovie>;
    readonly library: ReturnType<typeof useMoviesQuery>;
  }
  const input = (title: string) => ({
    ...movieToInput({
      id: 'x',
      ownerId: ALICE,
      normalizedTitle: title.toLowerCase(),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
      title,
      mediaType: 'movie',
      year: 1999,
      genre: null,
      runtimeMinutes: null,
      userRating: null,
      watched: false,
      watchedOn: null,
      verdict: null,
      technicalNotes: null,
      shotLink: null,
    }),
  });

  /**
   * Models a component that has not re-rendered since the account changed: it keeps the session and
   * repository of the render it last saw (Alice's), exactly the state in which a click could land
   * in the gap between the auth change and the next commit.
   */
  function FrozenProbe({ into }: { readonly into: { current: Captured | null } }) {
    const [session] = useState(useSession());
    const [repository] = useState(useMovieRepository());
    return (
      <SessionContext value={session}>
        <RepositoryContext value={repository}>
          <Probe into={into} />
        </RepositoryContext>
      </SessionContext>
    );
  }

  it('a write from a render that predates the account change is refused and never sent', async () => {
    const captured: { current: Captured | null } = { current: null };
    const h = renderAccounts({ extra: <FrozenProbe into={captured} /> });
    await link('Alice Alpha (2001)');
    const handles = captured.current;
    if (!handles) throw new Error('probe did not render');
    const before = h.repoFor(ALICE).snapshot();
    const alpha = findOrThrow(before, (m) => m.title === 'Alice Alpha');

    act(() => {
      h.signInAs(BOB);
    });
    const results = await Promise.all([
      handles.create.mutateAsync(input('Sneaky')),
      handles.update.mutateAsync({
        id: alpha.id,
        input: input('Renamed'),
        expectedUpdatedAt: alpha.updatedAt,
      }),
      handles.remove.mutateAsync({ id: alpha.id, expectedUpdatedAt: alpha.updatedAt }),
    ]);
    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: { code: 'session_changed' } });
    }
    expect(h.repoFor(ALICE).snapshot()).toEqual(before); // never even sent
    expect(
      h
        .repoFor(BOB)
        .snapshot()
        .some((m) => m.title === 'Sneaky'),
    ).toBe(false);
  });

  it('a viewer cannot write by calling the mutations directly, and nothing changes', async () => {
    const captured: { current: Captured | null } = { current: null };
    const h = renderAccounts({ roles: { [ALICE]: 'viewer' }, extra: <Probe into={captured} /> });
    await link('Alice Alpha (2001)');
    const handles = captured.current;
    if (!handles) throw new Error('probe did not render');
    const before = h.repoFor(ALICE).snapshot();
    const alpha = findOrThrow(before, (m) => m.title === 'Alice Alpha');

    const results = await Promise.all([
      handles.create.mutateAsync(input('Sneaky')),
      handles.update.mutateAsync({
        id: alpha.id,
        input: input('Renamed'),
        expectedUpdatedAt: alpha.updatedAt,
      }),
      handles.remove.mutateAsync({ id: alpha.id, expectedUpdatedAt: alpha.updatedAt }),
    ]);
    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    }
    expect(h.repoFor(ALICE).snapshot()).toEqual(before);
  });
});
