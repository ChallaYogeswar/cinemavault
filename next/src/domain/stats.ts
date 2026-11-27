import type { Movie } from './movie';
import { genresOf } from './recommend';

/** Everything the Statistics page shows, computed from the library alone (pure, no clock of its own). */

export interface GenreStat {
  readonly genre: string;
  readonly total: number;
  readonly watched: number;
  readonly unwatched: number;
}

export interface MonthStat {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly count: number;
}

export interface YearStat {
  readonly year: number;
  readonly count: number;
}

export interface Stats {
  readonly total: number;
  readonly films: number;
  readonly series: number;
  readonly watched: number;
  readonly unwatched: number;
  /** watched / total as a whole percent; 0 for an empty library. */
  readonly completionPercent: number;
  readonly rating: {
    /** Mean of every rating given (one decimal), or null when nothing is rated. */
    readonly average: number | null;
    readonly rated: number;
    /** Index = whole stars (0..5), each rating rounded to the nearest star (.5 rounds up). */
    readonly buckets: readonly number[];
  };
  /** Every genre, biggest first. A title with several genres counts once in each. */
  readonly genres: readonly GenreStat[];
  /** The genres you have watched the most (ties alphabetical), at most five, none with zero watched. */
  readonly mostWatchedGenres: readonly GenreStat[];
  /** The last 12 calendar months ending with the current one, oldest first, zeros included. */
  readonly months: readonly MonthStat[];
  /** Years with at least one watch, newest first. */
  readonly years: readonly YearStat[];
  readonly watchedThisYear: number;
  /** The most recent `watchedOn` date among watched titles, or null. */
  readonly lastWatchedOn: string | null;
  readonly watchedMinutes: number;
  readonly backlog: {
    readonly count: number;
    /** Unwatched titles by genre, biggest first, at most five. */
    readonly byGenre: readonly { readonly genre: string; readonly count: number }[];
    /** Minutes of the unwatched titles whose runtime is known. */
    readonly knownMinutes: number;
    readonly unknownRuntime: number;
    /** Unwatched titles that have waited longest (by date added), at most five. */
    readonly longestWaiting: readonly Movie[];
  };
}

const DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** `YYYY-MM-DD` → `[year, month]`, or null when it is not a plausible calendar date. */
function parseDay(value: string | null): readonly [number, number] | null {
  if (value === null) return null;
  const match = DATE.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

const monthKey = (year: number, month: number): string =>
  `${String(year)}-${String(month).padStart(2, '0')}`;

function lastTwelveMonths(now: Date): string[] {
  const keys: string[] = [];
  for (let back = 11; back >= 0; back -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - back, 1);
    keys.push(monthKey(date.getFullYear(), date.getMonth() + 1));
  }
  return keys;
}

export function computeStats(library: readonly Movie[], now: Date): Stats {
  const movies = library.filter((m) => m.deletedAt === null);
  const watchedMovies = movies.filter((m) => m.watched);
  const unwatchedMovies = movies.filter((m) => !m.watched);

  // Ratings
  const buckets = [0, 0, 0, 0, 0, 0];
  let ratingSum = 0;
  let rated = 0;
  for (const movie of movies) {
    const value = movie.userRating;
    if (value === null || !Number.isFinite(value) || value < 0 || value > 5) continue;
    ratingSum += value;
    rated += 1;
    const bucket = Math.round(value);
    buckets[bucket] = (buckets[bucket] ?? 0) + 1;
  }

  // Genres
  const genreRows = new Map<
    string,
    { genre: string; total: number; watched: number; unwatched: number }
  >();
  for (const movie of movies) {
    for (const genre of genresOf(movie)) {
      const key = genre.toLowerCase();
      const row = genreRows.get(key) ?? { genre, total: 0, watched: 0, unwatched: 0 };
      row.total += 1;
      if (movie.watched) row.watched += 1;
      else row.unwatched += 1;
      genreRows.set(key, row);
    }
  }
  const byName = (a: { genre: string }, b: { genre: string }) =>
    a.genre.localeCompare(b.genre, 'en');
  const genres = [...genreRows.values()].sort((a, b) => b.total - a.total || byName(a, b));
  const mostWatchedGenres = genres
    .filter((g) => g.watched > 0)
    .sort((a, b) => b.watched - a.watched || byName(a, b))
    .slice(0, 5);

  // Watch history
  const perMonth = new Map<string, number>();
  const perYear = new Map<number, number>();
  let lastWatchedOn: string | null = null;
  for (const movie of watchedMovies) {
    const day = parseDay(movie.watchedOn);
    if (!day || movie.watchedOn === null) continue;
    perMonth.set(monthKey(day[0], day[1]), (perMonth.get(monthKey(day[0], day[1])) ?? 0) + 1);
    perYear.set(day[0], (perYear.get(day[0]) ?? 0) + 1);
    if (lastWatchedOn === null || movie.watchedOn > lastWatchedOn) lastWatchedOn = movie.watchedOn;
  }

  // Backlog
  const backlogGenres = genres
    .filter((g) => g.unwatched > 0)
    .map((g) => ({ genre: g.genre, count: g.unwatched }))
    .sort((a, b) => b.count - a.count || byName(a, b))
    .slice(0, 5);
  const runtimeOf = (m: Movie) =>
    m.runtimeMinutes !== null && m.runtimeMinutes > 0 ? m.runtimeMinutes : 0;

  return {
    total: movies.length,
    films: movies.filter((m) => m.mediaType === 'movie').length,
    series: movies.filter((m) => m.mediaType === 'tv').length,
    watched: watchedMovies.length,
    unwatched: unwatchedMovies.length,
    completionPercent:
      movies.length === 0 ? 0 : Math.round((watchedMovies.length / movies.length) * 100),
    rating: {
      average: rated === 0 ? null : Math.round((ratingSum / rated) * 10) / 10,
      rated,
      buckets,
    },
    genres,
    mostWatchedGenres,
    months: lastTwelveMonths(now).map((month) => ({ month, count: perMonth.get(month) ?? 0 })),
    years: [...perYear.entries()]
      .map(([year, count]) => ({ year, count }))
      .sort((a, b) => b.year - a.year),
    watchedThisYear: perYear.get(now.getFullYear()) ?? 0,
    lastWatchedOn,
    watchedMinutes: watchedMovies.reduce((sum, m) => sum + runtimeOf(m), 0),
    backlog: {
      count: unwatchedMovies.length,
      byGenre: backlogGenres,
      knownMinutes: unwatchedMovies.reduce((sum, m) => sum + runtimeOf(m), 0),
      unknownRuntime: unwatchedMovies.filter((m) => runtimeOf(m) === 0).length,
      longestWaiting: [...unwatchedMovies]
        .sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt) || a.title.localeCompare(b.title, 'en'),
        )
        .slice(0, 5),
    },
  };
}
