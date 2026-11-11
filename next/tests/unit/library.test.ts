import { describe, expect, it } from 'vitest';
import { first } from '../helpers';
import { createSeedMovies, generateMovies } from '@/data/mock/fixtures';
import {
  DEFAULT_QUERY,
  applyLibraryQuery,
  foldText,
  genreCounts,
  hasActiveFilters,
  matchesSearch,
  parseLibraryQuery,
  serializeLibraryQuery,
  splitGenres,
  type LibraryQuery,
} from '@/domain/library';

const movies = createSeedMovies();
const q = (patch: Partial<LibraryQuery>): LibraryQuery => ({ ...DEFAULT_QUERY, ...patch });
const titles = (list: readonly { title: string }[]) => list.map((m) => m.title);

describe('splitGenres', () => {
  it('splits on commas, slashes, semicolons and pipes and trims', () => {
    expect(splitGenres('Drama, Crime / Thriller; Mystery | Horror')).toEqual([
      'Drama',
      'Crime',
      'Thriller',
      'Mystery',
      'Horror',
    ]);
  });
  it('de-duplicates case-insensitively keeping the first spelling', () => {
    expect(splitGenres('Drama, drama,  DRAMA')).toEqual(['Drama']);
  });
  it('returns an empty list for null, empty and separator-only input', () => {
    expect(splitGenres(null)).toEqual([]);
    expect(splitGenres('')).toEqual([]);
    expect(splitGenres(' , ; ')).toEqual([]);
  });
});

describe('search', () => {
  it('folds case and diacritics', () => {
    expect(foldText('Amélie')).toBe('amelie');
    expect(titles(applyLibraryQuery(movies, q({ search: 'AMELIE' })))).toEqual(['Amélie']);
  });
  it('requires every term, in any order, across title, year, genre and verdict', () => {
    expect(titles(applyLibraryQuery(movies, q({ search: 'thriller 2023' })))).toEqual(['#Manhole']);
    expect(titles(applyLibraryQuery(movies, q({ search: '2023 thriller' })))).toEqual(['#Manhole']);
    expect(applyLibraryQuery(movies, q({ search: 'thriller nonexistentword' }))).toEqual([]);
  });
  it('treats blank or whitespace-only search as no search', () => {
    expect(applyLibraryQuery(movies, q({ search: '   ' }))).toHaveLength(movies.length);
  });
  it('does not treat regex or wildcard characters specially', () => {
    expect(matchesSearch(first(movies), '.*')).toBe(false);
    expect(matchesSearch(first(movies), '(')).toBe(false);
  });
  it('matches the verdict text', () => {
    expect(titles(applyLibraryQuery(movies, q({ search: 'cried' })))).toEqual(['Coco']);
  });
});

describe('filters', () => {
  it('filters by media type', () => {
    const tv = applyLibraryQuery(movies, q({ type: 'tv' }));
    expect(tv.length).toBeGreaterThan(0);
    expect(tv.every((m) => m.mediaType === 'tv')).toBe(true);
  });
  it('filters by watched status', () => {
    expect(applyLibraryQuery(movies, q({ status: 'watched' })).every((m) => m.watched)).toBe(true);
    expect(applyLibraryQuery(movies, q({ status: 'unwatched' })).every((m) => !m.watched)).toBe(
      true,
    );
  });
  it('filters by minimum rating and never includes unrated titles in a min filter', () => {
    const four = applyLibraryQuery(movies, q({ rating: 'min4' }));
    expect(four.length).toBeGreaterThan(0);
    expect(four.every((m) => m.userRating !== null && m.userRating >= 4)).toBe(true);
    expect(applyLibraryQuery(movies, q({ rating: 'min5' })).every((m) => m.userRating === 5)).toBe(
      true,
    );
  });
  it('keeps half-point ratings in the right bucket', () => {
    const list = applyLibraryQuery(movies, q({ rating: 'min4' }));
    expect(titles(list)).toContain('Whiplash'); // 4.5
    expect(titles(applyLibraryQuery(movies, q({ rating: 'min3' })))).toContain('Gone Girl'); // 3.5
    expect(titles(applyLibraryQuery(movies, q({ rating: 'min4' })))).not.toContain('Gone Girl');
  });
  it('unrated means null only', () => {
    const unrated = applyLibraryQuery(movies, q({ rating: 'unrated' }));
    expect(unrated.every((m) => m.userRating === null)).toBe(true);
  });
  it('filters by exact genre, case-insensitively, inside multi-genre rows', () => {
    const list = applyLibraryQuery(movies, q({ genre: 'sci-fi' }));
    expect(titles(list)).toContain('Arrival');
    expect(titles(list)).toContain('Severance');
    expect(titles(list)).not.toContain('Parasite');
  });
  it('combines filters with AND', () => {
    const list = applyLibraryQuery(movies, q({ type: 'movie', rating: 'min5', genre: 'Thriller' }));
    expect(titles(list).sort()).toEqual(['Oldboy', 'Parasite']);
  });
  it('never returns a soft-deleted title, even if the repository leaks one', () => {
    const tombstone = { ...first(movies), deletedAt: '2026-10-02T00:00:00.000Z' };
    expect(applyLibraryQuery([tombstone], DEFAULT_QUERY)).toEqual([]);
  });
});

describe('sorting', () => {
  it('title sorts A–Z ignoring case, diacritics aside, with a stable id tiebreak', () => {
    const list = applyLibraryQuery(movies, q({ sort: 'title' }));
    const names = list.map((m) => m.normalizedTitle);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
  });
  it('year sorts newest first and puts missing years last', () => {
    const list = applyLibraryQuery(movies, q({ sort: 'year' }));
    const years = list.map((m) => m.year);
    const firstNull = years.indexOf(null);
    expect(firstNull).toBeGreaterThan(0);
    expect(years.slice(firstNull).every((y) => y === null)).toBe(true);
    const known = years.slice(0, firstNull) as number[];
    expect(known).toEqual([...known].sort((a, b) => b - a));
  });
  it('rating sorts best first and puts unrated last', () => {
    const list = applyLibraryQuery(movies, q({ sort: 'rating' }));
    const ratings = list.map((m) => m.userRating);
    const firstNull = ratings.indexOf(null);
    expect(ratings.slice(firstNull).every((r) => r === null)).toBe(true);
    const known = ratings.slice(0, firstNull) as number[];
    expect(known).toEqual([...known].sort((a, b) => b - a));
  });
  it('added sorts most recently created first', () => {
    const list = applyLibraryQuery(movies, q({ sort: 'added' }));
    expect(list[0]?.title).toBe('#Manhole');
  });
  it('does not mutate its input', () => {
    const before = titles(movies);
    applyLibraryQuery(movies, q({ sort: 'title' }));
    expect(titles(movies)).toEqual(before);
  });
});

describe('URL round-trip', () => {
  it('writes nothing for the default query', () => {
    expect(serializeLibraryQuery(DEFAULT_QUERY).toString()).toBe('');
    expect(hasActiveFilters(DEFAULT_QUERY)).toBe(false);
  });
  it('round-trips every field', () => {
    const query = q({
      search: 'dark knight',
      type: 'movie',
      status: 'watched',
      rating: 'min4',
      genre: 'Action',
      sort: 'rating',
    });
    expect(parseLibraryQuery(serializeLibraryQuery(query))).toEqual(query);
    expect(hasActiveFilters(query)).toBe(true);
  });
  it('falls back to defaults for junk instead of throwing', () => {
    const params = new URLSearchParams('type=<script>&status=nope&rating=99&sort=;drop&q=ok');
    expect(parseLibraryQuery(params)).toEqual({ ...DEFAULT_QUERY, search: 'ok' });
  });
  it('caps absurdly long search and genre values', () => {
    const parsed = parseLibraryQuery(
      new URLSearchParams({ q: 'a'.repeat(5_000), genre: 'b'.repeat(5_000) }),
    );
    expect(parsed.search).toHaveLength(200);
    expect(parsed.genre).toHaveLength(100);
  });
  it('survives characters that need URL encoding', () => {
    const query = q({ search: 'Fast & Furious: 100% "ok" +1' });
    expect(parseLibraryQuery(serializeLibraryQuery(query)).search).toBe(query.search);
  });
});

describe('genreCounts', () => {
  it('counts each genre once per title, most common first', () => {
    const counts = genreCounts(movies);
    expect(counts[0]?.count).toBeGreaterThanOrEqual(counts[1]?.count ?? 0);
    const drama = counts.find((c) => c.genre === 'Drama');
    expect(drama?.count).toBe(movies.filter((m) => splitGenres(m.genre).includes('Drama')).length);
  });
});

describe('at production scale', () => {
  it('filters and sorts 3,500 titles well inside a frame budget', () => {
    const big = generateMovies(3_500);
    const started = performance.now();
    const result = applyLibraryQuery(
      big,
      q({ search: 'sample 0', rating: 'min3', sort: 'rating' }),
    );
    const elapsed = performance.now() - started;
    expect(result.length).toBeGreaterThan(0);
    // Generous: guards against an accidental O(n²), not against a slow CI runner.
    expect(elapsed).toBeLessThan(1_000);
  });
});
