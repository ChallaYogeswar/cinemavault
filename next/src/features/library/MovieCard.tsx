import { memo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { Movie } from '@/domain/movie';
import { splitGenres } from '@/domain/library';
import { Poster } from '@/features/posters/Poster';
import { MEDIA_LABEL, formatRating } from './format';

interface Props {
  readonly movie: Movie;
}

/**
 * One title in the grid. The whole card is a single link to the detail dialog; filters in the URL
 * are carried along so closing the dialog returns to exactly the same view.
 * Memoized: with thousands of titles, showing another page must not redraw every card already on
 * screen. (`movie` objects keep their identity until that title actually changes.)
 * The poster comes from TMDB when it is available and is a deterministic placeholder otherwise.
 */
export const MovieCard = memo(function MovieCard({ movie }: Props) {
  const { search } = useLocation();
  const genre = splitGenres(movie.genre)[0];
  // What the badges on the poster say, for people who cannot see them (they are hidden from
  // assistive tech so the name is not read twice). The visible text stays part of the name.
  const status = [
    movie.mediaType === 'tv' ? 'Series' : null,
    movie.watched ? 'Watched' : 'To watch',
    movie.userRating === null ? null : `rated ${formatRating(movie.userRating)} out of 5`,
  ]
    .filter((part) => part !== null)
    .join(', ');

  return (
    <Link
      to={{ pathname: `/library/${movie.id}`, search }}
      state={{ overlay: true }}
      className="group block rounded-2xl outline-offset-4"
    >
      <Poster
        movie={movie}
        size="card"
        className="transition-transform duration-300 group-hover:-translate-y-1"
      >
        {movie.mediaType === 'tv' ? (
          <span
            aria-hidden="true"
            className="absolute left-2 top-2 rounded-full bg-black/55 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest backdrop-blur"
          >
            TV
          </span>
        ) : null}

        {movie.userRating !== null ? (
          <span
            aria-hidden="true"
            className="text-gold absolute right-2 top-2 rounded-full bg-black/55 px-2 py-0.5 font-mono text-[11px] backdrop-blur"
          >
            ★ {formatRating(movie.userRating)}
          </span>
        ) : null}

        <span
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2.5 pb-2 pt-6 text-[11px]"
        >
          <span
            aria-hidden="true"
            className={`size-1.5 rounded-full ${movie.watched ? 'bg-gold' : 'bg-white/35'}`}
          />
          {movie.watched ? 'Watched' : 'To watch'}
        </span>
      </Poster>

      <h3 className="mt-2.5 line-clamp-2 text-sm font-semibold leading-snug">{movie.title}</h3>
      <p className="text-muted mt-0.5 truncate text-xs">
        {movie.year ?? 'Year unknown'}
        {genre ? ` · ${genre}` : ` · ${MEDIA_LABEL[movie.mediaType]}`}
      </p>
      <span className="sr-only">{status}</span>
    </Link>
  );
});
