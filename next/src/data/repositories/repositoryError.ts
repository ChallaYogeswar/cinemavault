import type { AppError } from '@/domain/result';

/** Thrown only inside query functions so TanStack Query can see the failure; carries the AppError. */
export class RepositoryError extends Error {
  readonly appError: AppError;
  constructor(appError: AppError) {
    super(appError.message);
    this.name = 'RepositoryError';
    this.appError = appError;
  }
}

/** Failures that retrying cannot fix. */
const NO_RETRY: readonly AppError['code'][] = [
  'forbidden',
  'unauthenticated',
  'not_found',
  'session_changed',
];

export const isRetryable = (error: unknown): boolean =>
  !(error instanceof RepositoryError && NO_RETRY.includes(error.appError.code));
