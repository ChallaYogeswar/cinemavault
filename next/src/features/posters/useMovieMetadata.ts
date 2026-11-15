import { skipToken, useQuery } from '@tanstack/react-query';
import { privateKey } from '@/app/privateKey';
import { useRuntime } from '@/app/runtime';
import { useSession } from '@/app/session';
import type { Movie } from '@/domain/movie';
import type { MovieMetadata } from '@/services/tmdb/metadataService';
import { metadataKey } from '@/services/tmdb/title';

type Target = Pick<Movie, 'title' | 'year' | 'mediaType'>;

/**
 * Poster, rating and overview for a library title, or null when there is nothing to show (sample
 * data, TMDB has no match, the poster service is not set up, or the device is offline). Never an
 * error: a poster is decoration, so every failure is simply "no poster".
 *
 * The in-memory copy lives under the account's private key, so it is dropped with the account.
 */
export function useMovieMetadata(movie: Target): MovieMetadata | null {
  const { metadata } = useRuntime();
  const { userId, isCurrent } = useSession();
  const key = metadataKey(movie.title, movie.year, movie.mediaType);
  const query = useQuery({
    queryKey: privateKey(userId, 'metadata', key),
    queryFn: metadata
      ? async ({ signal }) => {
          const found = await metadata.lookup(
            userId,
            { title: movie.title, year: movie.year, mediaType: movie.mediaType },
            signal,
          );
          if (!isCurrent()) throw new Error('session changed');
          // Failing (rather than returning "nothing") keeps a temporary problem from being remembered.
          if (found.kind === 'unavailable') throw new Error(found.failure);
          return found.kind === 'found' ? found.metadata : null;
        }
      : skipToken,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
  return query.data ?? null;
}

/** A YouTube video id for the title's trailer, looked up only when asked (the detail view, Discover). */
export function useTrailerKey(movie: Target, enabled: boolean): string | null {
  const { metadata } = useRuntime();
  const { userId, isCurrent } = useSession();
  const query = useQuery({
    queryKey: privateKey(userId, 'trailer', metadataKey(movie.title, movie.year, movie.mediaType)),
    queryFn:
      metadata && enabled
        ? async ({ signal }) => {
            const trailer = await metadata.trailerKey(
              userId,
              { title: movie.title, year: movie.year, mediaType: movie.mediaType },
              signal,
            );
            if (!isCurrent()) throw new Error('session changed');
            return trailer;
          }
        : skipToken,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return query.data ?? null;
}
