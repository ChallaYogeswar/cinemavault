import { z } from 'zod';

const uuid = z.uuid();

/**
 * Private cached data must be scoped to the authenticated user (risk R7). Every IndexedDB database
 * name is derived from the user id, so a different account in the same browser can never open the
 * previous account's cache. Throws on anything that is not a UUID, which fails closed.
 */
export function cacheDatabaseName(userId: string): string {
  return `cinemavault-next:${uuid.parse(userId)}`;
}

export const CACHE_DATABASE_PREFIX = 'cinemavault-next:';
