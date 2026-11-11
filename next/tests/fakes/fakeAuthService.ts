import { err, ok, type AppError } from '@/domain/result';
import type { AuthChange, AuthService, AuthUser, Credentials } from '@/services/auth/authService';

export interface FakeAccount {
  readonly id: string;
  readonly email: string;
  password: string;
}

export interface FakeAuth {
  readonly service: AuthService;
  /** Survives the app being torn down and rebuilt, like the browser's stored session. */
  session: AuthUser | null;
  readonly accounts: FakeAccount[];
  readonly calls: { readonly name: string; readonly args: unknown }[];
  /** Something outside this tab (another tab, the server) changes who is signed in. */
  emit(change: AuthChange): void;
  /** The person opens a password-reset link from their email. */
  openRecoveryLink(email: string): void;
  failNext(
    name:
      | 'signIn'
      | 'signUp'
      | 'signOut'
      | 'signOutEverywhere'
      | 'requestPasswordReset'
      | 'updatePassword',
    error: AppError,
  ): void;
  /** How long the saved session takes to be reported (to observe the loading state). */
  restoreDelayMs: number;
  confirmationRequired: boolean;
}

const userOf = (account: FakeAccount): AuthUser => ({ id: account.id, email: account.email });

export function createFakeAuth(
  accounts: FakeAccount[],
  signedInAs: string | null = null,
): FakeAuth {
  const initial = accounts.find((a) => a.id === signedInAs);
  const listeners = new Set<(change: AuthChange) => void>();
  const failures = new Map<string, AppError>();
  const fake: FakeAuth = {
    session: initial ? userOf(initial) : null,
    accounts,
    calls: [],
    restoreDelayMs: 0,
    confirmationRequired: true,
    emit: (change) => {
      for (const listener of [...listeners]) listener(change);
    },
    openRecoveryLink: (email) => {
      const account = accounts.find((a) => a.email === email);
      if (!account) throw new Error(`no account ${email}`);
      fake.session = userOf(account);
      fake.emit({ kind: 'recovery', user: userOf(account) });
    },
    failNext: (name, error) => {
      failures.set(name, error);
    },
    service: {
      subscribe(listener) {
        listeners.add(listener);
        const timer = setTimeout(() => {
          listener({ kind: 'session', user: fake.session });
        }, fake.restoreDelayMs);
        return () => {
          clearTimeout(timer);
          listeners.delete(listener);
        };
      },
      signUp(credentials) {
        fake.calls.push({ name: 'signUp', args: credentials });
        const failure = failures.get('signUp');
        if (failure) {
          failures.delete('signUp');
          return Promise.resolve({ ok: false, error: failure });
        }
        if (!accounts.some((a) => a.email === credentials.email)) {
          accounts.push({ id: crypto.randomUUID(), ...credentials });
        }
        if (fake.confirmationRequired) return Promise.resolve(ok({ confirmationRequired: true }));
        const account = accounts.find((a) => a.email === credentials.email);
        if (account) {
          fake.session = userOf(account);
          fake.emit({ kind: 'session', user: fake.session });
        }
        return Promise.resolve(ok({ confirmationRequired: false }));
      },
      signIn(credentials: Credentials) {
        fake.calls.push({ name: 'signIn', args: credentials });
        const failure = failures.get('signIn');
        if (failure) {
          failures.delete('signIn');
          return Promise.resolve({ ok: false, error: failure });
        }
        const account = accounts.find(
          (a) => a.email === credentials.email && a.password === credentials.password,
        );
        if (!account) {
          return Promise.resolve(err('unauthenticated', 'That email and password don’t match.'));
        }
        fake.session = userOf(account);
        fake.emit({ kind: 'session', user: fake.session });
        return Promise.resolve(ok(undefined));
      },
      signOut() {
        fake.calls.push({ name: 'signOut', args: null });
        fake.session = null; // local sign-out always happens
        const failure = failures.get('signOut');
        if (failure) {
          failures.delete('signOut');
          return Promise.resolve({ ok: false, error: failure });
        }
        fake.emit({ kind: 'session', user: null });
        return Promise.resolve(ok(undefined));
      },
      signOutEverywhere() {
        fake.calls.push({ name: 'signOutEverywhere', args: null });
        fake.session = null; // this device is always signed out
        const failure = failures.get('signOutEverywhere');
        if (failure) {
          failures.delete('signOutEverywhere');
          return Promise.resolve({ ok: false, error: failure });
        }
        fake.emit({ kind: 'session', user: null });
        return Promise.resolve(ok(undefined));
      },
      requestPasswordReset(email) {
        fake.calls.push({ name: 'requestPasswordReset', args: email });
        const failure = failures.get('requestPasswordReset');
        if (failure) {
          failures.delete('requestPasswordReset');
          return Promise.resolve({ ok: false, error: failure });
        }
        return Promise.resolve(ok(undefined)); // identical for known and unknown addresses
      },
      updatePassword(password) {
        fake.calls.push({ name: 'updatePassword', args: password });
        const failure = failures.get('updatePassword');
        if (failure) {
          failures.delete('updatePassword');
          return Promise.resolve({ ok: false, error: failure });
        }
        const current = fake.session;
        const account = accounts.find((a) => a.id === current?.id);
        if (!account) return Promise.resolve(err('unauthenticated', 'Your session has ended.'));
        account.password = password;
        fake.emit({ kind: 'session', user: userOf(account) }); // USER_UPDATED
        return Promise.resolve(ok(undefined));
      },
    },
  };
  return fake;
}
