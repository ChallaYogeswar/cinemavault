import { createContext, useContext } from 'react';
import type { HistoryStore, SnoozeStore } from '@/data/local/deviceData';
import type { OutboxStore, RoleStore } from '@/data/local/outboxStore';
import type { LibraryCache } from '@/data/local/libraryCache';
import type { MovieRepository } from '@/data/repositories/movieRepository';
import type { ProfileRepository } from '@/data/repositories/profileRepository';
import type { Role } from '@/domain/permissions';
import type { MetadataService } from '@/services/tmdb/metadataService';

/**
 * The backend the app was started with: where repositories come from. Chosen ONCE at startup by
 * `resolveBackend`; screens never know whether they are on sample data or a real database.
 */
export interface Runtime {
  readonly kind: 'supabase' | 'mock';
  /** A repository bound to one account. Called once per signed-in session, never shared. */
  readonly repositoryFor: (userId: string, getRole: () => Role) => MovieRepository;
  /** The saved copy of the library on this device. Null on sample data, which has nothing to save. */
  readonly libraryCache: LibraryCache | null;
  /** What Discover showed lately, kept per account on this device. Null on sample data. */
  readonly history: HistoryStore | null;
  /** Titles hidden from Discover for a while, kept per account on this device. Null on sample data. */
  readonly snoozes: SnoozeStore | null;
  /** Poster and trailer lookups, kept per account on this device. Null on sample data. */
  readonly metadata: MetadataService | null;
  /**
   * Changes made while the server could not be reached, kept per account on this device and sent
   * when it can. Null on sample data (nothing is kept on the device), where writes stay online-only.
   */
  readonly outbox: OutboxStore | null;
  /** The access level this device last confirmed, so an owner can keep working offline. Null on sample data. */
  readonly roles: RoleStore | null;
  /** Null on sample data, where the role comes from the preview controls instead. */
  readonly profiles: ProfileRepository | null;
}

export const RuntimeContext = createContext<Runtime | null>(null);

export function useRuntime(): Runtime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('useRuntime must be used inside <RuntimeContext>');
  return runtime;
}
