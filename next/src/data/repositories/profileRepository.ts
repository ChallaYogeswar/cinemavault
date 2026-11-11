import type { Result } from '@/domain/result';

/**
 * Loads the signed-in user's profile row. The value is deliberately `unknown`: it is passed to
 * `resolveRole`, which fails closed to "viewer" for anything that is not a well-formed owner.
 * A missing profile resolves to `null`, which is NOT an error and is also treated as a viewer.
 */
export interface ProfileRepository {
  load(userId: string): Promise<Result<unknown>>;
  /** The name the person chose to show, or null when none is set. */
  loadDisplayName(userId: string): Promise<Result<string | null>>;
  /** Sets (or, with null, clears) the display name. Only ever touches the caller's own row. */
  updateDisplayName(userId: string, name: string | null): Promise<Result<string | null>>;
}
