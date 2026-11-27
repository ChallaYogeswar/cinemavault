import { createContext, useContext } from 'react';
import type { Role } from '@/domain/permissions';
import type { Result } from '@/domain/result';
import type { AuthUser, Credentials, SignUpOutcome } from '@/services/auth/authService';

/**
 * The whole life of "who is signed in", as one explicit state machine. The app renders from this
 * and nothing else, so there is no half-signed-in state to reason about:
 *  - loading: a saved session is being restored (nothing private is shown yet);
 *  - signed_out: nobody; only the sign-in, sign-up and recovery screens are reachable;
 *  - recovery: arrived through a password-reset link, must choose a new password first;
 *  - signed_in: an account is active (its role is resolved separately, and fails closed).
 */
export type AuthState =
  | { readonly status: 'loading' }
  | { readonly status: 'signed_out' }
  | { readonly status: 'recovery'; readonly user: AuthUser }
  | { readonly status: 'signed_in'; readonly user: AuthUser };

export interface AuthActions {
  signUp(credentials: Credentials): Promise<Result<SignUpOutcome>>;
  signIn(credentials: Credentials): Promise<Result<void>>;
  /** Always leaves this device signed out, even if the server could not be told. */
  signOut(): Promise<Result<void>>;
  /** Like `signOut`, and also ends every other device's session. */
  signOutEverywhere(): Promise<Result<void>>;
  requestPasswordReset(email: string): Promise<Result<void>>;
  updatePassword(password: string): Promise<Result<void>>;
}

/** Preview-only controls, present only when running on sample data. Never in a real backend. */
export interface MockControls {
  readonly role: Role;
  readonly setRole: (role: Role) => void;
  readonly switchAccount: (userId: string) => void;
}

export interface Auth {
  readonly state: AuthState;
  readonly actions: AuthActions;
  readonly mock: MockControls | null;
}

export const AuthContext = createContext<Auth | null>(null);

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('useAuth must be used inside an auth provider');
  return auth;
}
