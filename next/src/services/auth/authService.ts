import type { Result } from '@/domain/result';

export interface AuthUser {
  readonly id: string;
  readonly email: string | null;
}

/**
 * What the auth backend reports. `kind: 'session'` covers sign-in, sign-out, the initial restore
 * of a saved session, token refresh and profile updates; `user` is null when nobody is signed in.
 * `kind: 'recovery'` means the person arrived through a password-reset link and must choose a new
 * password before using the app.
 */
export type AuthChange =
  | { readonly kind: 'session'; readonly user: AuthUser | null }
  | { readonly kind: 'recovery'; readonly user: AuthUser };

export interface Credentials {
  readonly email: string;
  readonly password: string;
}

export interface SignUpOutcome {
  /** True when the account exists but must be confirmed by email before it can sign in. */
  readonly confirmationRequired: boolean;
}

/**
 * Everything the app needs from authentication, and nothing Supabase-specific. A change of account
 * is delivered ONLY through `subscribe` (including the first report of a restored session), so
 * there is a single path by which "who is signed in" can change.
 */
export interface AuthService {
  subscribe(listener: (change: AuthChange) => void): () => void;
  signUp(credentials: Credentials): Promise<Result<SignUpOutcome>>;
  signIn(credentials: Credentials): Promise<Result<void>>;
  signOut(): Promise<Result<void>>;
  /**
   * Ends this device's session AND revokes every other session of the account. The caller still
   * clears this device whatever the outcome; an error only means the other devices could not be
   * told.
   */
  signOutEverywhere(): Promise<Result<void>>;
  /** Always resolves ok for a well-formed address, so it cannot be used to discover accounts. */
  requestPasswordReset(email: string): Promise<Result<void>>;
  /** Sets the password of the signed-in (or recovering) user. */
  updatePassword(password: string): Promise<Result<void>>;
}
