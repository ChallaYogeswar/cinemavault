import type { AppError } from '@/domain/result';

/** The part of a PostgREST / Postgres error this layer relies on. */
export interface DbError {
  readonly message: string;
  readonly code?: string | undefined;
  readonly details?: string | undefined;
}

const NETWORK = /failed to fetch|network|fetch failed|timed? ?out|load failed|econn|enotfound/i;

/** Postgres integrity errors that mean "the data you sent is not acceptable". */
const VALIDATION_CODES = new Set(['23502', '23514', '22P02', '22007', '22008', '22003', '22001']);

/**
 * Translates a database failure into the app's vocabulary. Nothing here ever returns the raw
 * database message to the user (it can leak table or constraint names); the original is kept in
 * `cause` for logging only.
 */
export function mapDbError(error: DbError, status?: number): AppError {
  const code = error.code ?? '';
  const cause = error;

  if (code === '23505') {
    return {
      code: 'conflict',
      reason: 'duplicate_identity',
      message: 'A title with the same name, type and year is already in the library.',
      cause,
    };
  }
  // 42501 = insufficient_privilege, which is how a violated row-level-security check surfaces.
  if (code === '42501' || status === 403) {
    return { code: 'forbidden', message: 'Your account isn’t allowed to make this change.', cause };
  }
  if (code === 'PGRST301' || code === 'PGRST303' || status === 401) {
    return {
      code: 'unauthenticated',
      message: 'Your session has ended. Please sign in again.',
      cause,
    };
  }
  if (code === 'PGRST116') return { code: 'not_found', message: 'Title not found.', cause };
  if (VALIDATION_CODES.has(code)) {
    return {
      code: 'validation',
      message: 'Some of the values can’t be saved. Check the fields.',
      cause,
    };
  }
  if (status === 0 || (status !== undefined && status >= 500) || NETWORK.test(error.message)) {
    return { code: 'network', message: 'Couldn’t reach the server. Check your connection.', cause };
  }
  return { code: 'unknown', message: 'Something went wrong. Please try again.', cause };
}

/** A fetch that rejects instead of returning an error object (offline, DNS, CORS). */
export const networkError = (cause: unknown): AppError => ({
  code: 'network',
  message: 'Couldn’t reach the server. Check your connection.',
  cause,
});
