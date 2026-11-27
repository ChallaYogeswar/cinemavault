import type { Movie } from '@/domain/movie';
import {
  normalizeTitle,
  sanitizeTitle,
  youtubeSearchUrl,
  youtubeWatchUrl,
} from '@/services/tmdb/title';
import { Poster } from './Poster';
import { useMovieMetadata, useTrailerKey } from './useMovieMetadata';

/** A link to the trailer: the exact video when TMDB knows it, otherwise a YouTube search. */
export function TrailerLink({
  movie,
  className = '',
}: {
  readonly movie: Pick<Movie, 'title' | 'year' | 'mediaType'>;
  readonly className?: string;
}) {
  const key = useTrailerKey(movie, true);
  return (
    <a
      href={key ? youtubeWatchUrl(key) : youtubeSearchUrl(movie.title)}
      target="_blank"
      rel="noopener noreferrer"
      className={`text-gold underline underline-offset-4 ${className}`}
    >
      {key ? 'Watch the trailer' : 'Find the trailer on YouTube'}
    </a>
  );
}

/** Poster, TMDB overview and rating, and the trailer link, for the detail view. */
export function TitleArtwork({
  movie,
}: {
  readonly movie: Pick<Movie, 'title' | 'year' | 'mediaType'>;
}) {
  const metadata = useMovieMetadata(movie);
  return (
    <div className="flex gap-4">
      <Poster movie={movie} size="detail" className="w-28 shrink-0 sm:w-36" />
      <div className="min-w-0 space-y-3 text-sm">
        {metadata?.voteAverage ? (
          <p className="text-muted font-mono text-xs">
            TMDB {metadata.voteAverage.toFixed(1)} / 10
          </p>
        ) : null}
        {metadata &&
        normalizeTitle(metadata.matchedTitle) !== normalizeTitle(sanitizeTitle(movie.title)) ? (
          <p className="text-muted text-xs">
            Matched on TMDB as “{metadata.matchedTitle}”
            {metadata.matchedYear === null ? '' : ` (${String(metadata.matchedYear)})`}
          </p>
        ) : null}
        {metadata?.overview ? (
          <p className="line-clamp-6 leading-relaxed">{metadata.overview}</p>
        ) : null}
        <TrailerLink movie={movie} />
      </div>
    </div>
  );
}
