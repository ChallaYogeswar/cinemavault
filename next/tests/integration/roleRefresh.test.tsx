import { focusManager } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeAuth } from '../fakes/fakeAuthService';
import { createFakeProfiles, networkFailure } from '../fakes/fakeProfiles';
import { OWNER_ID, renderFullApp } from '../renderFullApp';

/**
 * Role refresh strategy: the role is read at sign-in/reload, again when the tab regains focus once
 * the answer is a minute old, when the server refuses a write as forbidden, and on demand from
 * Settings. Whatever the reason, a failed re-read means viewer. The database stays the real
 * control throughout; these tests pin how quickly the UI follows it.
 */
const addLink = () => screen.queryByRole('link', { name: /add movie/i });

const setup = (path = '/library') => {
  const auth = createFakeAuth(
    [{ id: OWNER_ID, email: 'o@example.com', password: 'pw-123456' }],
    OWNER_ID,
  );
  const profiles = createFakeProfiles({ [OWNER_ID]: { role: 'owner' } });
  let refusing = false;
  const app = renderFullApp({ auth, profiles, path, refuseWrites: () => refusing });
  return {
    auth,
    profiles,
    ...app,
    refuseWrites: (value: boolean) => {
      refusing = value;
    },
  };
};

afterEach(() => {
  vi.useRealTimers();
  focusManager.setFocused(undefined);
});

describe('role refresh during a live session', () => {
  it('a demotion made in the database shows up when the tab regains focus after a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { profiles } = setup();
    await screen.findByRole('link', { name: /add movie/i });
    profiles.rows.set(OWNER_ID, { role: 'viewer' });

    focusManager.setFocused(false);
    vi.setSystemTime(Date.now() + 61_000);
    focusManager.setFocused(true);

    await waitFor(() => {
      expect(addLink()).not.toBeInTheDocument();
    });
    expect(profiles.loads).toEqual([OWNER_ID, OWNER_ID]);
  });

  it('does not hit the profile table on every focus: a fresh answer is reused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { profiles } = setup();
    await screen.findByRole('link', { name: /add movie/i });
    profiles.rows.set(OWNER_ID, { role: 'viewer' });

    focusManager.setFocused(false);
    vi.setSystemTime(Date.now() + 20_000);
    focusManager.setFocused(true);
    await act(async () => {
      await Promise.resolve();
    });

    expect(profiles.loads).toEqual([OWNER_ID]);
    expect(addLink()).toBeInTheDocument(); // still within the minute: no refetch yet
  });

  it('a failed re-read on refocus drops to viewer, says so, and recovers on retry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { profiles } = setup();
    await screen.findByRole('link', { name: /add movie/i });
    profiles.failNext(networkFailure);

    focusManager.setFocused(false);
    vi.setSystemTime(Date.now() + 61_000);
    focusManager.setFocused(true);

    // A failed re-read must not keep the previous owner answer alive.
    await waitFor(() => {
      expect(addLink()).not.toBeInTheDocument();
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn’t verify your permissions/i);
  });

  it('Settings has a button that re-reads the role on demand', async () => {
    const { user, profiles } = setup('/settings');
    await screen.findByText(/owner — can change the library/i);
    profiles.rows.set(OWNER_ID, { role: 'viewer' });

    await user.click(screen.getByRole('button', { name: 'Refresh permissions' }));

    expect(await screen.findByText(/viewer — view only/i)).toBeInTheDocument();
    expect(profiles.loads).toEqual([OWNER_ID, OWNER_ID]);
  });

  it('a write the server refuses as forbidden makes the app re-read the role and become a viewer', async () => {
    const { user, profiles, refuseWrites } = setup('/library/new');
    const dialog = await screen.findByRole('dialog');
    profiles.rows.set(OWNER_ID, { role: 'viewer' }); // demoted while this tab sat open
    refuseWrites(true);

    await user.type(within(dialog).getByLabelText('Title'), 'Late Night Idea');
    await user.type(within(dialog).getByLabelText('Year'), '2024');
    await user.click(within(dialog).getByRole('button', { name: /add to library/i }));

    expect(await screen.findByText('View-only account')).toBeInTheDocument();
    expect(profiles.loads).toEqual([OWNER_ID, OWNER_ID]);
  });

  it('a refusal that arrives after sign-out does not re-read anything for the signed-out account', async () => {
    const auth = createFakeAuth(
      [{ id: OWNER_ID, email: 'o@example.com', password: 'pw-123456' }],
      OWNER_ID,
    );
    const profiles = createFakeProfiles({ [OWNER_ID]: { role: 'owner' } });
    let release: (refused: boolean) => void = () => undefined;
    const held = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const { user, store } = renderFullApp({
      auth,
      profiles,
      path: '/library/new',
      refuseWrites: () => held,
    });
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Title'), 'Ghost');
    await user.type(within(dialog).getByLabelText('Year'), '2024');
    await user.click(within(dialog).getByRole('button', { name: /add to library/i }));

    act(() => {
      auth.session = null;
      auth.emit({ kind: 'session', user: null });
    });
    await screen.findByRole('heading', { name: 'Sign in' });
    await act(async () => {
      release(true);
      await held;
    });

    expect(store.get()).toBeNull();
    expect(profiles.loads).toEqual([OWNER_ID]); // no refetch on behalf of a signed-out account
  });
});
