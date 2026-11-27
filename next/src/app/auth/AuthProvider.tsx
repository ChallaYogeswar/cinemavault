import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ActiveUserStore } from '@/app/activeUser';
import type { LibraryCache } from '@/data/local/libraryCache';
import type { Result } from '@/domain/result';
import type { AuthChange, AuthService, AuthUser } from '@/services/auth/authService';
import { AuthContext, type Auth, type AuthActions, type AuthState } from './auth';

interface Props {
  readonly service: AuthService;
  /** Updated synchronously on every change of account (see activeUser.ts). */
  readonly store: ActiveUserStore;
  /**
   * The copy of the library saved on this device. Auth is the one place that knows "nobody is
   * signed in" is a fact rather than "not restored yet", so it clears the copy then (the store
   * guard clears it on every later change of account).
   */
  readonly saved?: LibraryCache | null;
  readonly children: ReactNode;
}

/** Drives the auth state machine from the auth service. Production wiring; see MockAuthProvider. */
export function AuthProvider({ service, store, saved = null, children }: Props) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  /** While set, session events for this user are ignored: they must set a new password first. */
  const recovering = useRef<string | null>(null);

  const apply = useCallback(
    (change: AuthChange) => {
      if (change.kind === 'recovery') {
        recovering.current = change.user.id;
        store.set(null); // nothing private is reachable until the password is changed
        setState({ status: 'recovery', user: change.user });
        return;
      }
      if (change.user === null) {
        recovering.current = null;
        store.set(null);
        void saved?.retainOnly(null);
        setState({ status: 'signed_out' });
        return;
      }
      if (recovering.current === change.user.id) return;
      recovering.current = null;
      store.set(change.user.id); // synchronous: purges the previous account's data right now
      setState({ status: 'signed_in', user: change.user });
    },
    [store, saved],
  );

  useEffect(() => service.subscribe(apply), [service, apply]);

  /** This device is signed out whatever the server said; the result only reports what it said. */
  const endHere = useCallback(
    async (request: Promise<Result<void>>) => {
      const result = await request;
      recovering.current = null;
      store.set(null);
      void saved?.retainOnly(null);
      setState({ status: 'signed_out' });
      return result;
    },
    [store, saved],
  );

  const finishRecovery = useCallback(
    (user: AuthUser) => {
      recovering.current = null;
      store.set(user.id);
      setState({ status: 'signed_in', user });
    },
    [store],
  );

  const actions = useMemo<AuthActions>(
    () => ({
      signUp: (credentials) => service.signUp(credentials),
      signIn: (credentials) => service.signIn(credentials),
      signOut: () => endHere(service.signOut()),
      signOutEverywhere: () => endHere(service.signOutEverywhere()),
      requestPasswordReset: (email) => service.requestPasswordReset(email),
      async updatePassword(password) {
        const result = await service.updatePassword(password);
        if (result.ok && state.status === 'recovery') finishRecovery(state.user);
        return result;
      },
    }),
    [service, state, finishRecovery, endHere],
  );

  const value = useMemo<Auth>(() => ({ state, actions, mock: null }), [state, actions]);
  return <AuthContext value={value}>{children}</AuthContext>;
}
