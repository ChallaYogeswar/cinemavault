import type { Result } from '@/domain/result';
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
export interface MovieRepository {
  list(): Promise<Result<readonly Movie[]>>;
  get(id: string): Promise<Result<Movie>>;
  create(input: MovieInputValues): Promise<Result<Movie>>;
  update(id: string, input: MovieInputValues, expectedUpdatedAt: string): Promise<Result<Movie>>;
  remove(id: string, expectedUpdatedAt: string): Promise<Result<void>>;
}
