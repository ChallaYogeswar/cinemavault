import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFakeAuth, type FakeAccount } from '../fakes/fakeAuthService';
import { createFakeProfiles, networkFailure } from '../fakes/fakeProfiles';
import { FRIEND_ID, OWNER_ID, renderFullApp } from '../renderFullApp';
import { cardName } from '../cardName';

const OWNER: FakeAccount = { id: OWNER_ID, email: 'owner@example.com', password: 'correct-horse' };
const FRIEND: FakeAccount = {
  id: FRIEND_ID,
  email: 'friend@example.com',
  password: 'battery-staple',
};
const roles = { [OWNER_ID]: { role: 'owner' }, [FRIEND_ID]: { role: 'viewer' } };

const setup = (signedInAs: string | null = null, path = '/library') => {
  const auth = createFakeAuth([{ ...OWNER }, { ...FRIEND }], signedInAs);
  const profiles = createFakeProfiles(roles);
  const app = renderFullApp({ auth, profiles, path });
  return { auth, profiles, ...app };
};

const privateOwners = (client: ReturnType<typeof setup>['queryClient']) =>
  client
    .getQueryCache()
    .getAll()
    .filter((query) => query.queryKey[0] === 'u')
    .map((query) => query.queryKey[1]);

const addLink = () => screen.queryByRole('link', { name: /add movie/i });
const fill = async (
  user: ReturnType<typeof setup>['user'],
  fields: Readonly<Record<string, string>>,
) => {
  for (const [label, value] of Object.entries(fields)) {
    await user.type(screen.getByLabelText(label, { exact: true }), value);
  }
};

describe('session restore and the route guard', () => {
  it('shows loading while the saved session is restored, never the library or sign-in', async () => {
    const auth = createFakeAuth([{ ...OWNER }], OWNER_ID);
    auth.restoreDelayMs = 150;
    renderFullApp({ auth, profiles: createFakeProfiles(roles) });
    expect(screen.getByRole('status')).toHaveTextContent(/loading/i);
    expect(screen.queryByRole('heading', { name: /sign in/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Shared Alpha')).not.toBeInTheDocument();
    expect(
      await screen.findByRole('link', { name: cardName('Shared Alpha (2001)') }),
    ).toBeInTheDocument();
  });

  it('a signed-out visitor is sent to sign in and sees nothing private', async () => {
    const { router, queryClient } = setup(null, '/library');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(screen.queryByText('Shared Alpha')).not.toBeInTheDocument();
    expect(privateOwners(queryClient)).toEqual([]);
  });

  it('a saved session survives a reload: straight to the library, no sign-in screen', async () => {
    const first = setup(OWNER_ID);
    await screen.findByRole('link', { name: cardName('Shared Alpha (2001)') });
    first.unmount();
    // "Reload": a brand-new app against the same stored session.
    renderFullApp({ auth: first.auth, profiles: first.profiles });
    expect(
      await screen.findByRole('link', { name: cardName('Shared Alpha (2001)') }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('after signing in, returns to the page that was asked for, but never to a dialog URL', async () => {
    const a = setup(null, '/settings');
    await screen.findByRole('heading', { name: 'Sign in' });
    await fill(a.user, { Email: OWNER.email, Password: OWNER.password });
    await a.user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByRole('heading', { name: /keep the vault yours/i }),
    ).toBeInTheDocument();
    expect(a.router.state.location.pathname).toBe('/settings');
  });

  it('a deep link to a dialog lands on the library after sign-in, not on the dialog', async () => {
    const a = setup(null, '/library/some-id/edit');
    await screen.findByRole('heading', { name: 'Sign in' });
    await fill(a.user, { Email: OWNER.email, Password: OWNER.password });
    await a.user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('link', { name: cardName('Shared Alpha (2001)') });
    expect(a.router.state.location.pathname).toBe('/library');
  });
});

describe('sign in', () => {
  it('validates before calling the service', async () => {
    const { user, auth } = setup();
    await screen.findByRole('heading', { name: 'Sign in' });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter your email address')).toBeInTheDocument();
    expect(screen.getByText('Enter your password')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.type(screen.getByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    expect(auth.calls).toHaveLength(0);
  });

  it('a wrong password gives one generic message and signs nobody in', async () => {
    const { user, queryClient } = setup();
    await screen.findByRole('heading', { name: 'Sign in' });
    await fill(user, { Email: OWNER.email, Password: 'nope' });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That email and password don’t match.',
    );
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(privateOwners(queryClient)).toEqual([]);
  });

  it('an unknown email gets exactly the same message as a wrong password', async () => {
    const { user } = setup();
    await screen.findByRole('heading', { name: 'Sign in' });
    await fill(user, { Email: 'nobody@example.com', Password: 'whatever1' });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That email and password don’t match.',
    );
  });

  it('the owner signs in and gets the controls to change the library', async () => {
    const { user, store } = setup();
    await screen.findByRole('heading', { name: 'Sign in' });
    await fill(user, { Email: OWNER.email, Password: OWNER.password });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByRole('link', { name: cardName('Shared Alpha (2001)') }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /add movie/i })).toBeInTheDocument();
    expect(store.get()).toBe(OWNER_ID);
  });

  it('a friend signs in and can read the library but is offered no way to change it', async () => {
    const { user } = setup();
    await screen.findByRole('heading', { name: 'Sign in' });
    await fill(user, { Email: FRIEND.email, Password: FRIEND.password });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByRole('link', { name: cardName('Shared Alpha (2001)') }),
    ).toBeInTheDocument();
    expect(addLink()).not.toBeInTheDocument();
  });
});

describe('sign up', () => {
  it('validates the password and the confirmation', async () => {
    const { user, auth } = setup(null, '/sign-up');
    await screen.findByRole('heading', { name: 'Create your account' });
    await fill(user, {
      Email: 'new@example.com',
      Password: 'short',
      'Confirm password': 'different',
    });
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Use at least 8 characters')).toBeInTheDocument();
    expect(screen.getByText('The passwords don’t match')).toBeInTheDocument();
    expect(auth.calls).toHaveLength(0);
  });

  it('asks the person to check their email, and does not sign them in', async () => {
    const { user, auth, queryClient, store } = setup(null, '/sign-up');
    await screen.findByRole('heading', { name: 'Create your account' });
    await fill(user, {
      Email: 'new@example.com',
      Password: 'a-long-password',
      'Confirm password': 'a-long-password',
    });
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(auth.calls.map((c) => c.name)).toEqual(['signUp']);
    expect(store.get()).toBeNull();
    expect(privateOwners(queryClient)).toEqual([]);
  });

  it('an address that already has an account sees the very same screen', async () => {
    const { user } = setup(null, '/sign-up');
    await screen.findByRole('heading', { name: 'Create your account' });
    await fill(user, {
      Email: OWNER.email,
      Password: 'a-long-password',
      'Confirm password': 'a-long-password',
    });
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
  });

  it('a new account with no confirmation step is signed in as a VIEWER, not an owner', async () => {
    const auth = createFakeAuth([{ ...OWNER }]);
    auth.confirmationRequired = false;
    const profiles = createFakeProfiles(roles);
    const { user } = renderFullApp({ auth, profiles, path: '/sign-up' });
    await screen.findByRole('heading', { name: 'Create your account' });
    await fill(user, {
      Email: 'brand-new@example.com',
      Password: 'a-long-password',
      'Confirm password': 'a-long-password',
    });
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(
      await screen.findByRole('link', { name: cardName('Shared Alpha (2001)') }),
    ).toBeInTheDocument();
    expect(addLink()).not.toBeInTheDocument(); // no profile row yet: fails closed
  });
});

describe('sign out', () => {
  it('clears everything private and the Back button cannot reveal it again', async () => {
    const { user, router, queryClient, store } = setup(OWNER_ID);
    await screen.findByRole('link', { name: cardName('Shared Alpha (2001)') });
    await user.click(screen.getByRole('link', { name: 'Settings' }));
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(store.get()).toBeNull();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);

    await act(async () => {
      await router.navigate(-1);
    });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText('Shared Alpha')).not.toBeInTheDocument();
  });

  it('still signs this device out if the server cannot be reached, and says so', async () => {
    const { user, auth, store } = setup(OWNER_ID, '/settings');
    await screen.findByRole('button', { name: 'Sign out' });
    auth.failNext('signOut', networkFailure);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(store.get()).toBeNull();
  });

  it('signing out in another tab signs this one out too', async () => {
    const { auth, store, queryClient } = setup(OWNER_ID);
    await screen.findByRole('link', { name: cardName('Shared Alpha (2001)') });
    act(() => {
      auth.session = null;
      auth.emit({ kind: 'session', user: null });
    });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(store.get()).toBeNull();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('another account signing in from another tab replaces this one with no overlap of data', async () => {
    const { auth, store, queryClient } = setup(OWNER_ID);
    await screen.findByRole('link', { name: cardName('Shared Alpha (2001)') });
    expect(addLink()).toBeInTheDocument();
    act(() => {
      auth.session = { id: FRIEND_ID, email: FRIEND.email };
      auth.emit({ kind: 'session', user: auth.session });
    });
    expect(store.get()).toBe(FRIEND_ID);
    expect(privateOwners(queryClient)).not.toContain(OWNER_ID);
    await screen.findByRole('link', { name: cardName('Shared Alpha (2001)') });
    await waitFor(() => {
      expect(addLink()).not.toBeInTheDocument(); // the friend never inherits the owner's controls
    });
    expect(new Set(privateOwners(queryClient))).toEqual(new Set([FRIEND_ID]));
  });
});

describe('account recovery', () => {
  it('asks for an email and answers identically for known and unknown addresses', async () => {
    const { user, auth } = setup(null, '/forgot-password');
    await screen.findByRole('heading', { name: 'Reset your password' });
    await user.type(screen.getByLabelText('Email'), 'nobody@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/if an account exists/i);
    expect(auth.calls).toEqual([{ name: 'requestPasswordReset', args: 'nobody@example.com' }]);
  });

  it('a reset link opens the new-password form, not the library', async () => {
    const { auth, store, queryClient } = setup(null, '/sign-in');
    await screen.findByRole('heading', { name: 'Sign in' });
    act(() => {
      auth.openRecoveryLink(OWNER.email);
    });
    expect(
      await screen.findByRole('heading', { name: 'Choose a new password' }),
    ).toBeInTheDocument();
    expect(store.get()).toBeNull(); // nothing private is reachable yet
    expect(privateOwners(queryClient)).toEqual([]);
    expect(
      screen.queryByRole('link', { name: cardName('Shared Alpha (2001)') }),
    ).not.toBeInTheDocument();
  });

  it('while recovering, no page of the app can be reached', async () => {
    const { auth, router } = setup(null, '/library');
    await screen.findByRole('heading', { name: 'Sign in' });
    act(() => {
      auth.openRecoveryLink(OWNER.email);
    });
    await screen.findByRole('heading', { name: 'Choose a new password' });
    await act(async () => {
      await router.navigate('/library');
    });
    expect(
      await screen.findByRole('heading', { name: 'Choose a new password' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/reset-password');
  });

  it('validates the new password, saves it, and signs the person in', async () => {
    const { user, auth, store } = setup(null, '/sign-in');
    await screen.findByRole('heading', { name: 'Sign in' });
    act(() => {
      auth.openRecoveryLink(OWNER.email);
    });
    await screen.findByRole('heading', { name: 'Choose a new password' });

    await fill(user, { 'New password': 'short', 'Confirm new password': 'other' });
    await user.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await screen.findByText('Use at least 8 characters')).toBeInTheDocument();
    expect(auth.calls.some((c) => c.name === 'updatePassword')).toBe(false);

    await user.clear(screen.getByLabelText('New password'));
    await user.clear(screen.getByLabelText('Confirm new password'));
    await fill(user, {
      'New password': 'a-brand-new-one',
      'Confirm new password': 'a-brand-new-one',
    });
    await user.click(screen.getByRole('button', { name: 'Save password' }));

    expect(
      await screen.findByRole('link', { name: cardName('Shared Alpha (2001)') }),
    ).toBeInTheDocument();
    expect(store.get()).toBe(OWNER_ID);
    expect(auth.accounts.find((a) => a.id === OWNER_ID)?.password).toBe('a-brand-new-one');
  });

  it('a failed save keeps the person on the form with the reason', async () => {
    const { user, auth, store } = setup(null, '/sign-in');
    await screen.findByRole('heading', { name: 'Sign in' });
    act(() => {
      auth.openRecoveryLink(OWNER.email);
    });
    await screen.findByRole('heading', { name: 'Choose a new password' });
    auth.failNext('updatePassword', {
      code: 'validation',
      message: 'Choose a password you haven’t used before.',
    });
    await fill(user, {
      'New password': 'a-brand-new-one',
      'Confirm new password': 'a-brand-new-one',
    });
    await user.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/haven’t used before/);
    expect(store.get()).toBeNull();
  });

  it('visiting the reset page without a valid link explains and offers a new one', async () => {
    setup(null, '/reset-password');
    expect(
      await screen.findByRole('heading', { name: 'This link has expired' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /send me a new link/i })).toBeInTheDocument();
  });
});

describe('authorization: the role is resolved from the profile and fails closed', () => {
  it('shows a waiting state, with no owner controls, until the profile has answered', async () => {
    const auth = createFakeAuth([{ ...OWNER }], OWNER_ID);
    const profiles = createFakeProfiles(roles);
    const release = profiles.holdNext();
    renderFullApp({ auth, profiles });
    expect(await screen.findByText(/checking your permissions/i)).toBeInTheDocument();
    expect(addLink()).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: cardName('Shared Alpha (2001)') }),
    ).not.toBeInTheDocument();
    release();
    expect(await screen.findByRole('link', { name: /add movie/i })).toBeInTheDocument();
  });

  it('if the profile cannot be read the person is a viewer, is told so, and can retry', async () => {
    const auth = createFakeAuth([{ ...OWNER }], OWNER_ID);
    const profiles = createFakeProfiles(roles);
    profiles.failNext(networkFailure);
    const { user } = renderFullApp({ auth, profiles });
    expect(
      await screen.findByRole('link', { name: cardName('Shared Alpha (2001)') }),
    ).toBeInTheDocument();
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/couldn’t verify your permissions/i);
    expect(addLink()).not.toBeInTheDocument(); // the OLD app showed owner controls here

    await user.click(within(banner).getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('link', { name: /add movie/i })).toBeInTheDocument();
    expect(screen.queryByText(/couldn’t verify your permissions/i)).not.toBeInTheDocument();
  });

  it.each([
    ['no profile row', null],
    ['an unknown role', { role: 'admin' }],
    ['different casing', { role: 'Owner' }],
    ['the wrong shape', { roles: ['owner'] }],
    ['a bare string', 'owner'],
  ])('%s resolves to viewer', async (_name, row) => {
    const auth = createFakeAuth([{ ...OWNER }], OWNER_ID);
    renderFullApp({ auth, profiles: createFakeProfiles({ [OWNER_ID]: row }) });
    await screen.findByRole('link', { name: cardName('Shared Alpha (2001)') });
    expect(addLink()).not.toBeInTheDocument();
  });

  it('a viewer who opens the add URL directly is told the account is view-only', async () => {
    setup(FRIEND_ID, '/library/new');
    expect(await screen.findByText('View-only account')).toBeInTheDocument();
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
  });

  it('the profile is cached per account and never reused for another', async () => {
    const { auth, profiles, queryClient } = setup(OWNER_ID);
    await screen.findByRole('link', { name: /add movie/i });
    act(() => {
      auth.session = { id: FRIEND_ID, email: FRIEND.email };
      auth.emit({ kind: 'session', user: auth.session });
    });
    await waitFor(() => {
      expect(addLink()).not.toBeInTheDocument();
    });
    expect(profiles.loads).toEqual([OWNER_ID, FRIEND_ID]);
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .filter((q) => q.queryKey[1] === OWNER_ID),
    ).toHaveLength(0);
  });
});

describe('recovery edge cases', () => {
  it('a recovery link opened while another account is signed in removes that account first', async () => {
    const { auth, store, queryClient } = setup(OWNER_ID);
    await screen.findByRole('link', { name: cardName('Shared Alpha (2001)') });
    expect(store.get()).toBe(OWNER_ID);
    act(() => {
      auth.openRecoveryLink(FRIEND.email);
    });
    expect(
      await screen.findByRole('heading', { name: 'Choose a new password' }),
    ).toBeInTheDocument();
    expect(store.get()).toBeNull();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('a token refresh for the recovering user does not skip the new-password step', async () => {
    const { auth, store } = setup(null, '/sign-in');
    await screen.findByRole('heading', { name: 'Sign in' });
    act(() => {
      auth.openRecoveryLink(OWNER.email);
    });
    await screen.findByRole('heading', { name: 'Choose a new password' });
    act(() => {
      auth.emit({ kind: 'session', user: { id: OWNER_ID, email: OWNER.email } });
    });
    expect(screen.getByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument();
    expect(store.get()).toBeNull();
    expect(
      screen.queryByRole('link', { name: cardName('Shared Alpha (2001)') }),
    ).not.toBeInTheDocument();
  });
});
