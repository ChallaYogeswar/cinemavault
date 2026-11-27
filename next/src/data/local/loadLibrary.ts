import type { MovieRepository } from '@/data/repositories/movieRepository';
import type { Movie } from '@/domain/movie';
import { err, ok, sessionChanged, type Result } from '@/domain/result';
import type { LibraryCache } from './libraryCache';

/** Where the library on screen came from. Everything the person sees about it derives from this. */
export type LibraryOrigin = 'network' | 'cache';

export interface LibrarySource {
  readonly origin: LibraryOrigin;
  /** `network`: when it was fetched. `cache`: when the saved copy was taken. ISO-8601. */
  readonly at: string;
}

export interface LoadedLibrary {
  readonly movies: readonly Movie[];
  readonly source: LibrarySource;
}

/** How long to wait for the server before showing the saved copy (when there is one). */
export const SERVER_PATIENCE_MS = 8_000;

interface Options {
  readonly repository: MovieRepository;
  /** Null where nothing is saved on the device (sample data). */
  readonly cache: LibraryCache | null;
  readonly userId: string;
  /** False from the instant the account changes or signs out. Nothing may be applied after that. */
  readonly isCurrent: () => boolean;
  readonly patienceMs?: number;
  readonly now?: () => Date;
}

const TIMED_OUT = Symbol('timed out');

/**
 * Online first, saved copy second:
 *  - the server's answer always wins, and is saved as the new snapshot;
 *  - ONLY a network failure (no connection, timeout) falls back to the saved copy. A refusal
 *    (forbidden, signed out) or a server error is shown as what it is, never papered over;
 *  - with a saved copy, a server that has not answered within `patienceMs` is treated as
 *    unreachable, so a bad connection shows the library instead of a spinner;
 *  - a library that belongs to a previous account is never returned or saved.
 */
export async function loadLibrary(options: Options): Promise<Result<LoadedLibrary>> {
  const { repository, cache, userId, isCurrent } = options;
  const now = options.now ?? (() => new Date());
  const patience = options.patienceMs ?? SERVER_PATIENCE_MS;

  const fromCache = async (): Promise<Result<LoadedLibrary> | null> => {
    if (!cache) return null;
    const saved = await cache.read(userId);
    if (!isCurrent()) return sessionChanged();
    return saved
      ? ok({ movies: saved.movies, source: { origin: 'cache', at: saved.savedAt } })
      : null;
  };

  const request = repository.list();
  let answer: Awaited<typeof request> | typeof TIMED_OUT;
  if (cache) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const patienceRanOut = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        resolve(TIMED_OUT);
      }, patience);
    });
    answer = await Promise.race([request, patienceRanOut]);
    clearTimeout(timer);
  } else {
    answer = await request;
  }
  if (!isCurrent()) return sessionChanged();

  if (answer === TIMED_OUT) {
    const saved = await fromCache();
    if (saved) return saved;
    answer = await request; // nothing saved: keep waiting, as before
    if (!isCurrent()) return sessionChanged();
  }

  if (answer.ok) {
    if (cache) void cache.write(userId, answer.value); // best effort; never blocks or breaks the screen
    return ok({ movies: answer.value, source: { origin: 'network', at: now().toISOString() } });
  }
  if (answer.error.code === 'network') {
    const saved = await fromCache();
    if (saved) return saved;
  }
  return err(answer.error.code, answer.error.message, answer.error.cause);
}
