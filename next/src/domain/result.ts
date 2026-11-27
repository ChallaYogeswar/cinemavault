/**
 * Explicit success/failure results. Every mutation in the data layer returns a Result so callers
 * must handle the failure state instead of assuming success (blueprint rule 5).
 */
export type AppErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'network'
  /**
   * The signed-in account changed (switch or sign-out) while the request was pending or before it
   * started. The outcome belongs to the PREVIOUS account, so it is never applied to the cache or
   * shown to the new one. Callers must stop silently: no toast, no navigation, no state update.
   */
  | 'session_changed'
  | 'unknown';

/**
 * Two different things share the code "conflict" and the UI must treat them differently:
 *  - duplicate_identity: another live title already has this (title, type, year)
 *  - stale_version: the record changed since it was loaded (optimistic concurrency, risk R3)
 */
export type ConflictReason = 'duplicate_identity' | 'stale_version';

export interface AppError {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly reason?: ConflictReason;
  /** Underlying error, kept for logging; never shown to users verbatim. */
  readonly cause?: unknown;
}

export type Result<T, E extends AppError = AppError> =
  /**
   * `queued` is set only when the change could not reach the server and was kept on this device to
   * be sent later (offline editing). `value` is then what the person will see meanwhile, not what
   * the server has confirmed.
   */
  | { readonly ok: true; readonly value: T; readonly queued?: true }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = (code: AppErrorCode, message: string, cause?: unknown): Result<never> => ({
  ok: false,
  error: cause === undefined ? { code, message } : { code, message, cause },
});

export const conflict = (reason: ConflictReason, message: string): Result<never> => ({
  ok: false,
  error: { code: 'conflict', reason, message },
});

export const SESSION_CHANGED: AppError = {
  code: 'session_changed',
  message: 'The signed-in account changed, so this request was discarded.',
};

export const sessionChanged = (): Result<never> => ({ ok: false, error: SESSION_CHANGED });

/** True when `result` is the outcome of a request that belonged to a previous account. */
export const isSessionChanged = (result: Result<unknown>): boolean =>
  !result.ok && result.error.code === 'session_changed';
