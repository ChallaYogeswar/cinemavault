import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ActiveUserStore } from '@/app/activeUser';
import { MOCK_OWNER_ID } from '@/data/mock/fixtures';
import type { Role } from '@/domain/permissions';
import { ok } from '@/domain/result';
import { AuthContext, type Auth, type AuthActions, type AuthState } from './auth';

interface Props {
  readonly store: ActiveUserStore;
  readonly initialRole: Role;
  readonly children: ReactNode;
}

const PREVIEW_EMAIL = 'preview@cinemavault.local';

/**
 * Auth for SAMPLE-DATA mode only (previews, screenshots, regression tests). Any credentials sign in
 * as the sample owner; nothing is checked and nothing leaves the browser. It exists so every screen,
 * including sign-in and sign-out, can be reviewed without a backend. It is never selected for a
 * real backend and is refused outright for a production build (see resolveBackend).
 */
export function MockAuthProvider({ store, initialRole, children }: Props) {
  const userId = useSyncExternalStore(store.subscribe, store.get);
  const [role, setRole] = useState<Role>(initialRole);

  const value = useMemo<Auth>(() => {
    const state: AuthState =
      userId === null
        ? { status: 'signed_out' }
        : { status: 'signed_in', user: { id: userId, email: PREVIEW_EMAIL } };
    const signInAsSampleOwner = () => {
      store.set(MOCK_OWNER_ID);
      return Promise.resolve(ok(undefined));
    };
    const actions: AuthActions = {
      signIn: signInAsSampleOwner,
      signUp: () => {
        store.set(MOCK_OWNER_ID);
        return Promise.resolve(ok({ confirmationRequired: false }));
      },
      signOut: () => {
        store.set(null);
        return Promise.resolve(ok(undefined));
      },
      signOutEverywhere: () => {
        store.set(null);
        return Promise.resolve(ok(undefined));
      },
      requestPasswordReset: () => Promise.resolve(ok(undefined)),
      updatePassword: () => Promise.resolve(ok(undefined)),
    };
    return { state, actions, mock: { role, setRole, switchAccount: store.set } };
  }, [userId, role, store]);

  return <AuthContext value={value}>{children}</AuthContext>;
}
