import type { AppError, Result } from '@/domain/result';
import type { Movie } from '@/domain/movie';
import type { MovieInputValues } from '@/domain/validation';

/**
 * Contract for reading and changing the library. The Supabase-backed implementation arrives in
 * milestone M3; defining the contract now keeps UI code independent of storage and forces every
 * mutation to declare its failure states.
 *
 * Rules (blueprint section 4):
 *  - create/update must reject a duplicate identity with code "conflict" (see domain/identity.ts)
 *  - update must be version-checked against `expectedUpdatedAt` and fail with "conflict" instead of
 *    silently overwriting a newer change (risk R3)
 *  - remove soft-deletes (tombstone) so the delete propagates to other devices
 *  - viewers: every write returns "forbidden" without issuing a request
 */
/** What happened to each row of a bulk create. */
export interface CreateManyOutcome {
  readonly created: readonly Movie[];
  /** Rows that were NOT saved, by their position in the request, and why. */
  readonly skipped: readonly { readonly index: number; readonly error: AppError }[];
}

/** The most rows one `createMany` call accepts; callers send larger imports in several calls. */
export const CREATE_MANY_MAX = 500;

export interface CreateOptions {
  readonly id?: string;
}

export interface MovieRepository {
  list(): Promise<Result<readonly Movie[]>>;
  get(id: string): Promise<Result<Movie>>;
  /**
   * `options.id` lets the caller choose the new title's id. It exists for replaying a change that
   * was queued offline: the id was chosen when the change was made, so sending it twice (a reply
   * lost on the way back) can never add two copies. A create whose id already exists fails with
   * "conflict", and the caller can `get(id)` to learn that its own earlier attempt had succeeded.
   */
  create(input: MovieInputValues, options?: CreateOptions): Promise<Result<Movie>>;
  /**
   * Adds many titles at once (import). Each row follows the SAME rules as `create`; a row that
   * breaks one (invalid, duplicate of the library or of an earlier row of the call) is skipped and
   * reported, and the rest are saved. The whole call fails only for reasons that apply to every
   * row (view-only account, no connection, more than CREATE_MANY_MAX rows). It never updates or
   * deletes an existing title.
   */
  createMany(inputs: readonly MovieInputValues[]): Promise<Result<CreateManyOutcome>>;
  update(id: string, input: MovieInputValues, expectedUpdatedAt: string): Promise<Result<Movie>>;
  remove(id: string, expectedUpdatedAt: string): Promise<Result<void>>;
}
