import type { Movie } from './movie';
import { genresOf } from './recommend';

export interface GenreSummary {
  readonly genre: string;
  readonly total: number;
  readonly unwatched: number;
}

/** Every genre with how many titles it holds and how many are still unwatched. Deleted titles are ignored. */
export function summarizeGenres(movies: readonly Movie[]): GenreSummary[] {
  const rows = new Map<string, { genre: string; total: number; unwatched: number }>();
  for (const movie of movies) {
    if (movie.deletedAt !== null) continue;
    for (const genre of genresOf(movie)) {
      const key = genre.toLowerCase();
      const row = rows.get(key) ?? { genre, total: 0, unwatched: 0 };
      row.total += 1;
      if (!movie.watched) row.unwatched += 1;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort(
    (a, b) => b.total - a.total || a.genre.localeCompare(b.genre, 'en'),
  );
}
