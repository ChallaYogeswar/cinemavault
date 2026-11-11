import type { AuthError, Session, SupabaseClient } from '@supabase/supabase-js';
import { err, ok, type AppError, type Result } from '@/domain/result';
import type { AuthChange, AuthService, AuthUser } from './authService';

const toUser = (session: Session | null): AuthUser | null =>
  session ? { id: session.user.id, email: session.user.email ?? null } : null;

const NETWORK = /failed to fetch|network|fetch failed|load failed|timed? ?out/i;

/**
 * Maps an auth failure to a message that is safe to show. Sign-in failures are deliberately the
 * same for "no such account" and "wrong password", so the form cannot be used to find accounts.
 */
export function mapAuthError(
  error: AuthError | { message: string; code?: string; status?: number },
): AppError {
  const code = 'code' in error ? (error.code ?? '') : '';
  const status = 'status' in error ? error.status : undefined;
  const cause = error;
  switch (code) {
    case 'invalid_credentials':
      return { code: 'unauthenticated', message: 'That email and password don’t match.', cause };
    case 'email_not_confirmed':
      return {
        code: 'unauthenticated',
        message: 'Confirm your email first — check your inbox for the link.',
        cause,
      };
    case 'weak_password':
      return {
        code: 'validation',
        message: 'Choose a stronger password (at least 8 characters).',
        cause,
      };
    case 'same_password':
      return { code: 'validation', message: 'Choose a password you haven’t used before.', cause };
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return {
        code: 'unknown',
        message: 'Too many attempts. Wait a few minutes and try again.',
        cause,
      };
    case 'user_already_exists':
    case 'email_exists':
      // Do not confirm that an account exists: callers treat sign-up as "check your email".
      return { code: 'conflict', message: 'Check your email to continue.', cause };
    case 'session_not_found':
    case 'refresh_token_not_found':
      return {
        code: 'unauthenticated',
        message: 'Your session has ended. Please sign in again.',
        cause,
      };
    default:
      break;
  }
  if (status === 429) {
    return {
      code: 'unknown',
      message: 'Too many attempts. Wait a few minutes and try again.',
      cause,
    };
  }
  if (
    status === 0 ||
    (status === undefined && NETWORK.test(error.message)) ||
    (status !== undefined && status >= 500)
  ) {
    return { code: 'network', message: 'Couldn’t reach the server. Check your connection.', cause };
  }
  return { code: 'unknown', message: 'Something went wrong. Please try again.', cause };
}

const guard = async <T>(
  run: () => Promise<{ error: AuthError | null }>,
  value: T,
): Promise<Result<T>> => {
  try {
    const { error } = await run();
    return error ? { ok: false, error: mapAuthError(error) } : ok(value);
  } catch (cause) {
    return err('network', 'Couldn’t reach the server. Check your connection.', cause);
  }
};

export interface SupabaseAuthOptions {
  readonly client: SupabaseClient;
  /** Where email links bring the person back to; e.g. `() => window.location.origin`. */
  readonly siteUrl: () => string;
  /**
   * Who the device last had signed in, for the one case where supabase-js reports nobody although
   * its stored session is intact (expired token, no connection). See `readStoredIdentity`.
   */
  readonly storedIdentity?: () => AuthUser | null;
}

/**
 * Supabase email + password authentication.
 *
 * Two rules learned from the old app are baked in:
 *  - the auth-state callback NEVER awaits another Supabase call (that can deadlock the client);
 *    it only forwards the event, synchronously;
 *  - a recovery link makes Supabase announce a normal sign-in just before the recovery event. The
 *    sign-in is held back for one tick so the app never flashes the library to someone who is
 *    supposed to be choosing a new password first.
 */
export function createSupabaseAuthService({
  client,
  siteUrl,
  storedIdentity,
}: SupabaseAuthOptions): AuthService {
  return {
    subscribe(listener) {
      let held: ReturnType<typeof setTimeout> | null = null;
      const { data } = client.auth.onAuthStateChange((event, session) => {
        const user = toUser(session);
        if (event === 'PASSWORD_RECOVERY' && user) {
          if (held !== null) clearTimeout(held);
          held = null;
          listener({ kind: 'recovery', user } satisfies AuthChange);
          return;
        }
        if (event === 'INITIAL_SESSION' && !user) {
          // No usable session at start-up. If a stored one is still there, the server simply could
          // not be asked (offline): carry on as that account, read-only from the saved copy. A
          // session the server rejected has already been deleted, so it never gets here.
          const stored = storedIdentity?.() ?? null;
          if (stored) {
            listener({ kind: 'session', user: stored });
            return;
          }
        }
        if (event === 'SIGNED_IN' && user) {
          if (held !== null) clearTimeout(held);
          held = setTimeout(() => {
            held = null;
            listener({ kind: 'session', user });
          }, 0);
          return;
        }
        if (held !== null) {
          clearTimeout(held);
          held = null;
        }
        listener({ kind: 'session', user });
      });
      return () => {
        if (held !== null) clearTimeout(held);
        data.subscription.unsubscribe();
      };
    },

    async signUp({ email, password }) {
      try {
        const { data, error } = await client.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: siteUrl() },
        });
        if (error) {
          const mapped = mapAuthError(error);
          // An existing address looks exactly like a new one: "check your email".
          return mapped.code === 'conflict'
            ? ok({ confirmationRequired: true })
            : { ok: false, error: mapped };
        }
        return ok({ confirmationRequired: data.session === null });
      } catch (cause) {
        return err('network', 'Couldn’t reach the server. Check your connection.', cause);
      }
    },

    signIn: ({ email, password }) =>
      guard(() => client.auth.signInWithPassword({ email, password }), undefined),

    // `local` always clears this device even if the revoke request cannot be delivered.
    signOut: () => guard(() => client.auth.signOut({ scope: 'local' }), undefined),

    signOutEverywhere: () => guard(() => client.auth.signOut({ scope: 'global' }), undefined),

    requestPasswordReset: (email) =>
      guard(
        () =>
          client.auth.resetPasswordForEmail(email, { redirectTo: `${siteUrl()}/reset-password` }),
        undefined,
      ),

    updatePassword: (password) => guard(() => client.auth.updateUser({ password }), undefined),
  };
}
