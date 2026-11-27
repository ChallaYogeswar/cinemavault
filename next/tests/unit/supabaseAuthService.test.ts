import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthChange } from '@/services/auth/authService';
import { createSupabaseAuthService, mapAuthError } from '@/services/auth/supabaseAuthService';

type Callback = (event: AuthChangeEvent, session: Session | null) => void;

const session = (id = 'u1', email = 'a@example.com') =>
  ({ user: { id, email } }) as unknown as Session;

function stubClient(overrides: Record<string, unknown> = {}) {
  let callback: Callback = () => undefined;
  const unsubscribe = vi.fn();
  const auth = {
    onAuthStateChange: vi.fn((cb: Callback) => {
      callback = cb;
      return { data: { subscription: { unsubscribe } } };
    }),
    signUp: vi.fn(),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    updateUser: vi.fn(),
    ...overrides,
  };
  const service = createSupabaseAuthService({
    client: { auth } as unknown as SupabaseClient,
    siteUrl: () => 'https://app.test',
  });
  return {
    auth,
    service,
    unsubscribe,
    emit: (e: AuthChangeEvent, s: Session | null) => {
      callback(e, s);
    },
  };
}

describe('auth events', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards the restored session and sign-out as plain session changes', () => {
    const { service, emit } = stubClient();
    const seen: AuthChange[] = [];
    service.subscribe((c) => seen.push(c));
    emit('INITIAL_SESSION', session());
    emit('SIGNED_OUT', null);
    expect(seen).toEqual([
      { kind: 'session', user: { id: 'u1', email: 'a@example.com' } },
      { kind: 'session', user: null },
    ]);
  });

  it('holds a sign-in for one tick so a recovery link is never mistaken for a normal sign-in', () => {
    const { service, emit } = stubClient();
    const seen: AuthChange[] = [];
    service.subscribe((c) => seen.push(c));
    emit('SIGNED_IN', session());
    expect(seen).toEqual([]);
    emit('PASSWORD_RECOVERY', session());
    vi.runAllTimers();
    expect(seen.map((c) => c.kind)).toEqual(['recovery']);
  });

  it('delivers a plain sign-in after the tick', () => {
    const { service, emit } = stubClient();
    const seen: AuthChange[] = [];
    service.subscribe((c) => seen.push(c));
    emit('SIGNED_IN', session());
    vi.runAllTimers();
    expect(seen).toEqual([{ kind: 'session', user: { id: 'u1', email: 'a@example.com' } }]);
  });

  it('a sign-out arriving before the held sign-in cancels it', () => {
    const { service, emit } = stubClient();
    const seen: AuthChange[] = [];
    service.subscribe((c) => seen.push(c));
    emit('SIGNED_IN', session());
    emit('SIGNED_OUT', null);
    vi.runAllTimers();
    expect(seen).toEqual([{ kind: 'session', user: null }]);
  });

  it('unsubscribing drops a held sign-in and detaches from the client', () => {
    const { service, emit, unsubscribe } = stubClient();
    const seen: AuthChange[] = [];
    const stop = service.subscribe((c) => seen.push(c));
    emit('SIGNED_IN', session());
    stop();
    vi.runAllTimers();
    expect(seen).toEqual([]);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('the callback never awaits or calls the client (deadlock rule)', () => {
    const { service, emit, auth } = stubClient();
    service.subscribe(() => undefined);
    emit('SIGNED_IN', session());
    emit('TOKEN_REFRESHED', session());
    vi.runAllTimers();
    for (const fn of [auth.signUp, auth.signInWithPassword, auth.signOut, auth.updateUser]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('a user without an email is still a user', () => {
    const { service, emit } = stubClient();
    const seen: AuthChange[] = [];
    service.subscribe((c) => seen.push(c));
    emit('INITIAL_SESSION', { user: { id: 'u2' } } as unknown as Session);
    expect(seen).toEqual([{ kind: 'session', user: { id: 'u2', email: null } }]);
  });
});

describe('actions', () => {
  it('sign-up reports whether a confirmation is needed, and redirects back to the site', async () => {
    const a = stubClient();
    a.auth.signUp.mockResolvedValue({ data: { session: null }, error: null });
    const r = await a.service.signUp({ email: 'x@example.com', password: 'pw123456' });
    expect(r).toEqual({ ok: true, value: { confirmationRequired: true } });
    expect(a.auth.signUp).toHaveBeenCalledWith({
      email: 'x@example.com',
      password: 'pw123456',
      options: { emailRedirectTo: 'https://app.test' },
    });
    a.auth.signUp.mockResolvedValue({ data: { session: session() }, error: null });
    expect(await a.service.signUp({ email: 'x@example.com', password: 'pw123456' })).toEqual({
      ok: true,
      value: { confirmationRequired: false },
    });
  });

  it('sign-up for an existing account looks exactly like a new one', async () => {
    const a = stubClient();
    a.auth.signUp.mockResolvedValue({
      data: { session: null },
      error: { message: 'User already registered', code: 'user_already_exists', status: 422 },
    });
    expect(await a.service.signUp({ email: 'x@example.com', password: 'pw123456' })).toEqual({
      ok: true,
      value: { confirmationRequired: true },
    });
  });

  it('sign-in uses the password grant and maps bad credentials to one generic message', async () => {
    const a = stubClient();
    a.auth.signInWithPassword.mockResolvedValue({
      error: { message: 'Invalid login credentials', code: 'invalid_credentials', status: 400 },
    });
    const r = await a.service.signIn({ email: 'x@example.com', password: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe('That email and password don’t match.');
  });

  it('sign-out clears this device only', async () => {
    const a = stubClient();
    a.auth.signOut.mockResolvedValue({ error: null });
    await a.service.signOut();
    expect(a.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('sign-out everywhere revokes every session, and the plain one still does not', async () => {
    const a = stubClient();
    a.auth.signOut.mockResolvedValue({ error: null });
    await a.service.signOutEverywhere();
    expect(a.auth.signOut).toHaveBeenCalledWith({ scope: 'global' });
    expect(a.auth.signOut).not.toHaveBeenCalledWith({ scope: 'local' });
    a.auth.signOut.mockClear();
    await a.service.signOut();
    expect(a.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('sign-out everywhere reports an unreachable server instead of pretending it worked', async () => {
    const a = stubClient();
    a.auth.signOut.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await a.service.signOutEverywhere()).toMatchObject({
      ok: false,
      error: { code: 'network' },
    });
  });

  it('password reset sends the person back to the reset page', async () => {
    const a = stubClient();
    a.auth.resetPasswordForEmail.mockResolvedValue({ error: null });
    await a.service.requestPasswordReset('x@example.com');
    expect(a.auth.resetPasswordForEmail).toHaveBeenCalledWith('x@example.com', {
      redirectTo: 'https://app.test/reset-password',
    });
  });

  it('a thrown network failure becomes a network error, never an exception', async () => {
    const a = stubClient();
    a.auth.signInWithPassword.mockRejectedValue(new TypeError('Failed to fetch'));
    const r = await a.service.signIn({ email: 'x@example.com', password: 'pw123456' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('network');
  });
});

describe('mapAuthError', () => {
  it.each([
    [{ message: 'x', code: 'weak_password', status: 422 }, 'validation'],
    [{ message: 'x', code: 'same_password', status: 422 }, 'validation'],
    [{ message: 'x', code: 'email_not_confirmed', status: 400 }, 'unauthenticated'],
    [{ message: 'x', code: 'session_not_found', status: 400 }, 'unauthenticated'],
    [{ message: 'x', code: 'over_email_send_rate_limit', status: 429 }, 'unknown'],
    [{ message: 'x', status: 429 }, 'unknown'],
    [{ message: 'x', status: 503 }, 'network'],
    [{ message: 'Failed to fetch' }, 'network'],
    [{ message: 'surprising', status: 400 }, 'unknown'],
  ])('%j → %s', (error, code) => {
    expect(mapAuthError(error).code).toBe(code);
  });

  it('never leaks the server message for an unrecognised failure', () => {
    expect(mapAuthError({ message: 'pg: secret detail', status: 400 }).message).not.toMatch(/pg/);
  });
});

describe('restoring an account while offline', () => {
  const stored = { id: '00000000-0000-4000-8000-0000000000a1', email: 'a@example.com' };
  const build = (storedIdentity: () => typeof stored | null) => {
    let callback: Callback = () => undefined;
    const auth = {
      onAuthStateChange: vi.fn((cb: Callback) => {
        callback = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
    };
    const service = createSupabaseAuthService({
      client: { auth } as unknown as SupabaseClient,
      siteUrl: () => 'https://app.test',
      storedIdentity,
    });
    const seen: AuthChange[] = [];
    service.subscribe((c) => seen.push(c));
    return {
      seen,
      emit: (e: AuthChangeEvent, s: Session | null) => {
        callback(e, s);
      },
    };
  };

  it('start-up with no usable session but an intact stored one continues as that account', () => {
    const { seen, emit } = build(() => stored);
    emit('INITIAL_SESSION', null);
    expect(seen).toEqual([{ kind: 'session', user: stored }]);
  });

  it('start-up with nothing stored is signed out', () => {
    const { seen, emit } = build(() => null);
    emit('INITIAL_SESSION', null);
    expect(seen).toEqual([{ kind: 'session', user: null }]);
  });

  it('a real sign-out is never overridden by what is stored', () => {
    const { seen, emit } = build(() => stored);
    emit('SIGNED_OUT', null);
    expect(seen).toEqual([{ kind: 'session', user: null }]);
  });

  it('a session that supabase-js did restore wins over the stored one', () => {
    const { seen, emit } = build(() => stored);
    emit('INITIAL_SESSION', session('00000000-0000-4000-8000-0000000000b2', 'b@example.com'));
    expect(seen).toEqual([
      {
        kind: 'session',
        user: { id: '00000000-0000-4000-8000-0000000000b2', email: 'b@example.com' },
      },
    ]);
  });
});
