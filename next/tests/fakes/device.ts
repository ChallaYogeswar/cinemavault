import type { PGlite } from '@electric-sql/pglite';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createDexieLibraryCache } from '@/data/local/dexieLibraryCache';
import { loadLibrary } from '@/data/local/loadLibrary';
import type { MovieRepository } from '@/data/repositories/movieRepository';
import { createSupabaseMovieRepository } from '@/data/supabase/supabaseMovieRepository';
import type { Movie } from '@/domain/movie';
import type { Role } from '@/domain/permissions';
import { err, type Result } from '@/domain/result';
import { createPgliteClient } from './pgliteSupabase';

/**
 * One simulated device: its OWN connection to the shared database, its OWN IndexedDB, and a
 * switch for its network. Two of these against one PGlite database are two phones sharing a cloud.
 */
export function createDevice(db: PGlite, userId: string, role: Role) {
  const factory = new IDBFactory();
  const cache = createDexieLibraryCache({ indexedDB: factory, IDBKeyRange });
  const pg = createPgliteClient(db, { getUser: () => userId });
  const net = { down: false };
  const base = createSupabaseMovieRepository({ client: pg.client, userId, getRole: () => role });

  const gate = <T>(run: () => Promise<Result<T>>): Promise<Result<T>> =>
    net.down
      ? Promise.resolve(err('network', 'Couldn’t reach the server. Check your connection.'))
      : run();
  const repository: MovieRepository = {
    list: () => gate(() => base.list()),
    get: (id) => gate(() => base.get(id)),
    create: (input) => gate(() => base.create(input)),
    update: (id, input, at) => gate(() => base.update(id, input, at)),
    remove: (id, at) => gate(() => base.remove(id, at)),
  };

  return {
    userId,
    cache,
    factory,
    repository,
    net,
    /** What the app does on this device when the library is opened. */
    open: () => loadLibrary({ repository, cache, userId, isCurrent: () => true }),
    /** The saved copy, once the fire-and-forget save has landed. */
    saved: async (expectedCount?: number): Promise<readonly Movie[] | null> => {
      for (let i = 0; i < 100; i += 1) {
        const copy = await cache.read(userId);
        if (copy && (expectedCount === undefined || copy.movies.length === expectedCount)) {
          return copy.movies;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return (await cache.read(userId))?.movies ?? null;
    },
  };
}

export type Device = ReturnType<typeof createDevice>;
