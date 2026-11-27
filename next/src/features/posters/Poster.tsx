import { useState } from 'react';
import type { Movie } from '@/domain/movie';
import { posterBackground, posterInitials } from '@/features/library/format';
import { posterUrl } from '@/services/tmdb/title';
import { useMovieMetadata } from './useMovieMetadata';

interface Props {
  readonly movie: Pick<Movie, 'title' | 'year' | 'mediaType'>;
  readonly size: 'card' | 'detail';
  readonly className?: string;
  readonly children?: React.ReactNode;
}

/**
 * The poster frame. The deterministic placeholder (a gradient and the title's initials) is always
 * drawn first and stays underneath, so the layout never jumps and a missing, slow or blocked image
 * (offline, an ad-blocker) leaves a good-looking card instead of a broken one.
 */
export function Poster({ movie, size, className = '', children }: Props) {
  const metadata = useMovieMetadata(movie);
  const path = metadata?.posterPath ?? null;
  // Remember WHICH poster failed, so a later, different poster for the same card is still tried.
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = path !== null && failed !== path;

  return (
    <div
      className={`border-line relative grid aspect-[2/3] place-items-center overflow-hidden rounded-2xl border ${className}`}
      style={{ background: posterBackground(movie.title) }}
    >
      <span
        aria-hidden="true"
        className="font-serif text-5xl font-semibold tracking-tight text-white/85 sm:text-6xl"
      >
        {posterInitials(movie.title)}
      </span>
      {showImage ? (
        <img
          src={posterUrl(path, size)}
          alt={size === 'detail' ? `Poster for ${movie.title}` : ''}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => {
            setFailed(path);
          }}
          className="absolute inset-0 size-full object-cover"
        />
      ) : null}
      {children}
    </div>
  );
}
