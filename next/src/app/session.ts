import { createContext, useContext } from 'react';
import type { Role } from '@/domain/permissions';

/**
 * A signed-in session. It only exists while someone is signed in (see SessionProvider), and the
 * role is always the FAIL-CLOSED result of `resolveRole`: anything unverified is a viewer.
 */
export interface Session {
  readonly role: Role;
  /** Stable function that always returns the current role; used by repositories. */
  readonly getRole: () => Role;
  /** False when the profile could not be read, so the role is the safe default, not a fact. */
  readonly roleVerified: boolean;
  /**
   * True when the server could not be reached and the role is what this device last confirmed
   * (so an owner can keep working offline). `roleVerified` is false then too; the server checks
   * every change again when it is sent.
   */
  readonly roleFromDevice: boolean;
  /** Tries to verify the role again after a failure. */
  readonly retryRole: () => void;
  /** The signed-in account. Private cached data is keyed by it (see privateKey.ts). */
  readonly userId: string;
  readonly email: string | null;
  /**
   * Whether the sign-in session THIS value belongs to is still the active one. Synchronous and
   * live: false from the instant the account changes or signs out (also for A → B → A). A request
   * captures it when it starts and must not apply anything once it returns false.
   */
  readonly isCurrent: () => boolean;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside <SessionProvider>');
  return session;
}
