import { splitGenres } from './library';
import type { Movie } from './movie';

/**
 * "What should I watch?" Pure and deterministic given a random source: no storage, no clock, no
 * React. The rules are the old app's, kept on purpose so the picks feel the same:
 *  - only unwatched, non-deleted titles are eligible;
 *  - global mode picks a GENRE first, weighted by backlog size (soft: count^0.6, so a huge genre
 *    leads but does not drown the rest) and cooled down for genres picked recently, then picks a
 *    title at random inside it, avoiding the last few titles shown;
 *  - genre mode is a plain random choice inside the chosen genre.
 */

export const UNCATEGORIZED = 'Uncategorized';
/** How strongly a genre's backlog counts: 1 = linearly, 0 = not at all. */
export const BACKLOG_EXPONENT = 0.6;
/** Each recent appearance of a genre multiplies its weight by this (up to MAX_COOLDOWN_HITS times). */
export const COOLDOWN_FACTOR = 0.42;
export const MAX_COOLDOWN_HITS = 3;
/** The smallest weight any genre keeps, so nothing becomes impossible. */
export const MIN_WEIGHT = 0.05;
/** How many recent picks count towards the genre cooldown, and how many titles are kept off the list. */
export const RECENT_GENRE_WINDOW = 12;
export const RECENT_TITLE_WINDOW = 6;

/** A random source returning a number in [0, 1), like Math.random. Injected so tests are exact. */
export type Random = () => number;

export type PickKind = 'recommended' | 'genre-random';

/** One thing the person was shown. Newest first when passed to the pickers. */
export interface HistoryEntry {
  readonly movieId: string;
  readonly genres: readonly string[];
  readonly result: PickKind;
  /** ISO-8601, from the device clock. */
  readonly at: string;
}

export interface Pick {
  readonly movie: Movie;
  readonly genre: string;
  readonly kind: PickKind;
  /** One plain sentence on why, shown under the title. */
  readonly reason: string;
}

export interface GenreInventory {
  readonly genre: string;
  readonly count: number;
  readonly movies: readonly Movie[];
}

export const genresOf = (movie: Movie): string[] => {
  const genres = splitGenres(movie.genre);
  return genres.length > 0 ? genres : [UNCATEGORIZED];
};

/** Not watched and not deleted. */
export const isEligible = (movie: Movie): boolean => !movie.watched && movie.deletedAt === null;

const sameGenre = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Unwatched titles grouped by genre (case-insensitively), biggest backlog first, ties alphabetical. */
export function inventory(movies: readonly Movie[]): GenreInventory[] {
  const groups = new Map<string, { genre: string; movies: Movie[] }>();
  for (const movie of movies) {
    if (!isEligible(movie)) continue;
    for (const genre of genresOf(movie)) {
      const key = genre.toLowerCase();
      const group = groups.get(key);
      if (group) group.movies.push(movie);
      else groups.set(key, { genre, movies: [movie] });
    }
  }
  return [...groups.values()]
    .map((group) => ({ genre: group.genre, count: group.movies.length, movies: group.movies }))
    .sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre, 'en'));
}

/** Backlog weight, cooled down by how often the genre was picked lately. Exposed for tests. */
export function genreWeight(count: number, recentHits: number): number {
  const cooldown = recentHits > 0 ? COOLDOWN_FACTOR ** Math.min(recentHits, MAX_COOLDOWN_HITS) : 1;
  return Math.max(MIN_WEIGHT, count ** BACKLOG_EXPONENT * cooldown);
}

/** Total even if `random` misbehaves: anything outside [0, 1) is clamped, never throws. */
const unit = (random: Random): number => {
  const value = random();
  if (!Number.isFinite(value) || value < 0) return 0;
  return value >= 1 ? 1 - Number.EPSILON : value;
};

function weightedIndex(weights: readonly number[], random: Random): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = unit(random) * total;
  for (const [index, weight] of weights.entries()) {
    cursor -= weight;
    if (cursor < 0) return index;
  }
  return weights.length - 1;
}

function chooseTitle(
  titles: readonly Movie[],
  recentIds: ReadonlySet<string>,
  avoid: ReadonlySet<string>,
  current: string | undefined,
  random: Random,
): Movie | null {
  // Prefer a title that was not shown lately and is not the one on screen; relax in that order
  // rather than returning nothing from a small genre.
  const tiers = [
    titles.filter((m) => !recentIds.has(m.id) && !avoid.has(m.id)),
    titles.filter((m) => !avoid.has(m.id)),
    // Everything here was shown already: repeat one, but never the title that is on screen now.
    titles.filter((m) => m.id !== current),
    titles,
  ];
  const pool = tiers.find((tier) => tier.length > 0);
  if (!pool) return null;
  return pool[Math.floor(unit(random) * pool.length)] ?? null;
}

export interface PickOptions {
  readonly movies: readonly Movie[];
  /** Newest first. */
  readonly history?: readonly HistoryEntry[];
  readonly random: Random;
  /** Titles to avoid if anything else is possible, for example the pick already on screen. */
  readonly avoid?: readonly string[];
  /** The title on screen now: never suggested again unless it is the only candidate. */
  readonly current?: string;
}

/** The balanced random pick across the whole library, or null when nothing is left to watch. */
export function pickGlobal({
  movies,
  history = [],
  random,
  avoid = [],
  current,
}: PickOptions): Pick | null {
  const rows = inventory(movies);
  if (rows.length === 0) return null;

  const recentGenres = history.slice(0, RECENT_GENRE_WINDOW).flatMap((entry) => entry.genres);
  const weights = rows.map((row) =>
    genreWeight(row.count, recentGenres.filter((g) => sameGenre(g, row.genre)).length),
  );
  const row = rows[weightedIndex(weights, random)];
  if (!row) return null;

  const recentIds = new Set(history.slice(0, RECENT_TITLE_WINDOW).map((entry) => entry.movieId));
  const movie = chooseTitle(row.movies, recentIds, new Set(avoid), current, random);
  if (!movie) return null;

  const biggest = rows[0]?.count ?? row.count;
  return {
    movie,
    genre: row.genre,
    kind: 'recommended',
    reason:
      row.count >= biggest * 0.85
        ? `${row.genre} currently has a large unwatched backlog.`
        : 'Randomly selected with your backlog balance in mind.',
  };
}

/** A plain random pick inside one genre (case-insensitive), or null if it has nothing unwatched. */
export function pickInGenre(options: PickOptions & { readonly genre: string }): Pick | null {
  const { movies, genre, history = [], random, avoid = [], current } = options;
  const target = genre.trim();
  const candidates = movies.filter(
    (movie) => isEligible(movie) && genresOf(movie).some((g) => sameGenre(g, target)),
  );
  const recentIds = new Set(history.slice(0, RECENT_TITLE_WINDOW).map((entry) => entry.movieId));
  const movie = chooseTitle(candidates, recentIds, new Set(avoid), current, random);
  if (!movie) return null;
  const label = genresOf(movie).find((g) => sameGenre(g, target)) ?? target;
  return {
    movie,
    genre: label,
    kind: 'genre-random',
    reason: `A random pick from your unwatched ${label} titles.`,
  };
}

/** What gets remembered about a pick. */
export const historyEntryFor = (pick: Pick, at: Date): HistoryEntry => ({
  movieId: pick.movie.id,
  genres: genresOf(pick.movie),
  result: pick.kind,
  at: at.toISOString(),
});

/** What Discover showed more than this long ago says nothing about what feels fresh today. */
export const HISTORY_MAX_AGE_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * The history that should still influence a pick: newest first, at most `HISTORY_MAX_AGE_DAYS`
 * old, and with no entry whose date cannot be read (or lies in the future, which a wrong device
 * clock can produce) because its age is unknown.
 */
export function freshHistory(entries: readonly HistoryEntry[], now: Date): HistoryEntry[] {
  const newest = now.getTime();
  const oldest = newest - HISTORY_MAX_AGE_DAYS * DAY_MS;
  return entries.filter((entry) => {
    const at = Date.parse(entry.at);
    return Number.isFinite(at) && at >= oldest && at <= newest;
  });
}

export type KindFilter = 'movie' | 'tv' | null;

/** The titles a pick may be drawn from: the chosen kind only, and nothing the person hid for now. */
export function narrow(
  movies: readonly Movie[],
  options: { readonly kind: KindFilter; readonly hidden: ReadonlySet<string> },
): Movie[] {
  return movies.filter(
    (movie) =>
      (options.kind === null || movie.mediaType === options.kind) && !options.hidden.has(movie.id),
  );
}

const MONTH_MS = 30.44 * DAY_MS;

const plural = (n: number, one: string): string => `${String(n)} ${one}${n === 1 ? '' : 's'}`;

function minutesText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${String(minutes)} min`;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}

/**
 * Plain, checkable facts about a suggestion, so the person can see why it is a reasonable pick
 * (rather than being told it is). Every sentence is derived from the library itself; none is
 * invented. One each for time on the list, genre progress and length: three at most.
 */
export function pickFacts(movie: Movie, library: readonly Movie[], now: Date): string[] {
  const facts: string[] = [];

  const added = Date.parse(movie.createdAt);
  if (Number.isFinite(added) && added <= now.getTime()) {
    const months = Math.floor((now.getTime() - added) / MONTH_MS);
    if (months >= 12)
      facts.push(`On your list for over ${plural(Math.floor(months / 12), 'year')}.`);
    else if (months >= 2) facts.push(`On your list for ${plural(months, 'month')}.`);
    else facts.push('Added recently.');
  }

  const [primary] = genresOf(movie);
  if (primary && primary !== UNCATEGORIZED) {
    const inGenre = library.filter(
      (m) => m.deletedAt === null && genresOf(m).some((g) => sameGenre(g, primary)),
    );
    const watched = inGenre.filter((m) => m.watched).length;
    facts.push(
      watched === 0
        ? `You haven’t watched any of your ${String(inGenre.length)} ${primary} titles yet.`
        : `You’ve watched ${String(watched)} of your ${String(inGenre.length)} ${primary} titles.`,
    );
  }

  const minutes = movie.runtimeMinutes;
  if (movie.mediaType === 'movie' && minutes !== null && minutes > 0) {
    if (minutes <= 90) facts.push(`A short one: ${minutesText(minutes)}.`);
    else if (minutes >= 150) facts.push(`A long one: ${minutesText(minutes)}.`);
    else facts.push(`About ${minutesText(minutes)}.`);
  }
  return facts;
}
