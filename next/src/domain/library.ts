import type { Movie } from './movie';

/**
 * Pure library selectors: search, filter, sort and URL (de)serialisation. No React, no storage.
 * The library screen keeps its state in the URL, so every function that reads a query is total:
 * any junk in the address bar falls back to defaults instead of throwing.
 */

export const SORT_KEYS = ['added', 'title', 'year', 'rating'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const STATUS_FILTERS = ['all', 'watched', 'unwatched'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

/** `min3` means "rated 3 or higher". `unrated` means no rating at all. */
export const RATING_FILTERS = ['any', 'unrated', 'min3', 'min4', 'min5'] as const;
export type RatingFilter = (typeof RATING_FILTERS)[number];

export const TYPE_FILTERS = ['all', 'movie', 'tv'] as const;
export type TypeFilter = (typeof TYPE_FILTERS)[number];

export interface LibraryQuery {
  readonly search: string;
  readonly type: TypeFilter;
  readonly status: StatusFilter;
  readonly rating: RatingFilter;
  /** Exact genre label as produced by `splitGenres`; empty string means any genre. */
  readonly genre: string;
  readonly sort: SortKey;
}

export const DEFAULT_QUERY: LibraryQuery = {
  search: '',
  type: 'all',
  status: 'all',
  rating: 'any',
  genre: '',
  sort: 'added',
};

const oneOf = <T extends string>(allowed: readonly T[], value: string | null, fallback: T): T =>
  allowed.find((candidate) => candidate === value) ?? fallback;

/** Never throws; unknown or missing parameters become defaults. */
export function parseLibraryQuery(params: URLSearchParams): LibraryQuery {
  return {
    search: (params.get('q') ?? '').slice(0, 200),
    type: oneOf(TYPE_FILTERS, params.get('type'), DEFAULT_QUERY.type),
    status: oneOf(STATUS_FILTERS, params.get('status'), DEFAULT_QUERY.status),
    rating: oneOf(RATING_FILTERS, params.get('rating'), DEFAULT_QUERY.rating),
    genre: (params.get('genre') ?? '').slice(0, 100),
    sort: oneOf(SORT_KEYS, params.get('sort'), DEFAULT_QUERY.sort),
  };
}

/** Only non-default values are written, so a pristine library keeps a clean `/library` URL. */
export function serializeLibraryQuery(query: LibraryQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.search.trim() !== '') params.set('q', query.search);
  if (query.type !== DEFAULT_QUERY.type) params.set('type', query.type);
  if (query.status !== DEFAULT_QUERY.status) params.set('status', query.status);
  if (query.rating !== DEFAULT_QUERY.rating) params.set('rating', query.rating);
  if (query.genre !== '') params.set('genre', query.genre);
  if (query.sort !== DEFAULT_QUERY.sort) params.set('sort', query.sort);
  return params;
}

export function hasActiveFilters(query: LibraryQuery): boolean {
  return (
    query.search.trim() !== '' ||
    query.type !== DEFAULT_QUERY.type ||
    query.status !== DEFAULT_QUERY.status ||
    query.rating !== DEFAULT_QUERY.rating ||
    query.genre !== ''
  );
}

/** Lower-case and strip diacritics so "amelie" finds "Amélie". */
export function foldText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/** "Drama, Crime / Thriller" -> ["Drama", "Crime", "Thriller"], de-duplicated case-insensitively. */
export function splitGenres(genre: string | null): string[] {
  if (genre === null) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of genre.split(/[,/;|]/)) {
    const label = part.trim().replace(/\s+/g, ' ');
    const key = label.toLowerCase();
    if (label === '' || seen.has(key)) continue;
    seen.add(key);
    result.push(label);
  }
  return result;
}

/** Genres present in the library with counts, most common first (ties alphabetical). */
export function genreCounts(movies: readonly Movie[]): { genre: string; count: number }[] {
  const counts = new Map<string, { genre: string; count: number }>();
  for (const movie of movies) {
    for (const genre of splitGenres(movie.genre)) {
      const key = genre.toLowerCase();
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { genre, count: 1 });
    }
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.genre.localeCompare(b.genre, 'en'),
  );
}

const MIN_RATING: Record<'min3' | 'min4' | 'min5', number> = { min3: 3, min4: 4, min5: 5 };

function matchesRating(movie: Movie, filter: RatingFilter): boolean {
  if (filter === 'any') return true;
  if (filter === 'unrated') return movie.userRating === null;
  return movie.userRating !== null && movie.userRating >= MIN_RATING[filter];
}

function matchesType(movie: Movie, type: TypeFilter): boolean {
  return type === 'all' || movie.mediaType === type;
}

function searchHaystack(movie: Movie): string {
  return foldText(
    [
      movie.title,
      movie.year === null ? '' : String(movie.year),
      movie.genre ?? '',
      movie.verdict ?? '',
    ].join(' '),
  );
}

/** Every whitespace-separated term must appear somewhere in title, year, genre or verdict. */
export function matchesSearch(movie: Movie, search: string): boolean {
  const terms = foldText(search).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = searchHaystack(movie);
  return terms.every((term) => haystack.includes(term));
}

const byTitle = (a: Movie, b: Movie): number =>
  a.normalizedTitle.localeCompare(b.normalizedTitle, 'en') || a.id.localeCompare(b.id);

/** Nulls always sort last, whichever direction. */
function compareNullable(a: number | null, b: number | null, direction: 1 | -1): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * direction;
}

const COMPARATORS: Record<SortKey, (a: Movie, b: Movie) => number> = {
  added: (a, b) => b.createdAt.localeCompare(a.createdAt) || byTitle(a, b),
  title: byTitle,
  year: (a, b) => compareNullable(a.year, b.year, -1) || byTitle(a, b),
  rating: (a, b) => compareNullable(a.userRating, b.userRating, -1) || byTitle(a, b),
};

/**
 * Applies the query to LIVE movies. Tombstones are excluded here as well as in the repository so a
 * soft-deleted title can never be rendered even if a repository forgets to filter it.
 */
export function applyLibraryQuery(movies: readonly Movie[], query: LibraryQuery): Movie[] {
  const genreKey = query.genre.toLowerCase();
  return movies
    .filter((movie) => {
      if (movie.deletedAt !== null) return false;
      if (!matchesType(movie, query.type)) return false;
      if (query.status === 'watched' && !movie.watched) return false;
      if (query.status === 'unwatched' && movie.watched) return false;
      if (!matchesRating(movie, query.rating)) return false;
      if (
        genreKey !== '' &&
        !splitGenres(movie.genre).some((genre) => genre.toLowerCase() === genreKey)
      ) {
        return false;
      }
      return matchesSearch(movie, query.search);
    })
    .sort(COMPARATORS[query.sort]);
}
