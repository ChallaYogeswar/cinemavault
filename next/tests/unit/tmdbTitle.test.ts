import { describe, expect, it } from 'vitest';
import {
  bareTitle,
  STRONG_MATCH,
  WEAK_MATCH,
  chooseResult,
  normalizeTitle,
  titleSimilarity,
  type Candidate,
  metadataKey,
  sanitizeTitle,
  youtubeSearchUrl,
} from '../../src/services/tmdb/title';

describe('sanitizeTitle', () => {
  it.each([
    ['Dark (Series)', 'Dark'],
    ['Dark [TV]', 'Dark'],
    ['Attack on Titan (Anime)', 'Attack on Titan'],
    ['Friends Season 3', 'Friends'],
    ['  Spaced   out   title ', 'Spaced out title'],
    ['Heat', 'Heat'],
    ['TV Guide', 'TV Guide'],
    ['Season of the Witch', 'Season of the Witch'],
    ['', ''],
  ])('%j → %j', (input, expected) => {
    expect(sanitizeTitle(input)).toBe(expected);
  });
});

describe('bareTitle', () => {
  it('drops leading symbols only', () => {
    expect(bareTitle('#Alive')).toBe('Alive');
    expect(bareTitle('(500) Days of Summer')).toBe('500) Days of Summer');
    expect(bareTitle('Se7en')).toBeNull();
    expect(bareTitle('!!!')).toBeNull();
  });
});

describe('normalizeTitle', () => {
  it.each([
    ['The Dark Knight', 'dark knight'],
    ['Amélie', 'amelie'],
    ['Spider-Man: No Way Home', 'spider man no way home'],
    ['Tom & Jerry', 'tom and jerry'],
    ['A', 'a'],
    ['The', 'the'],
    ['  !!! ', ''],
    ['Ｓｅｖｅｎ', 'seven'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });
});

describe('titleSimilarity', () => {
  it('is 1 for the same title however it is written', () => {
    expect(titleSimilarity('The Matrix', 'Matrix')).toBe(1);
    expect(titleSimilarity('Spider-Man', 'Spider Man')).toBe(1);
    expect(titleSimilarity('AMÉLIE', 'Amelie')).toBe(1);
  });
  it('tolerates a typo but not a different title', () => {
    expect(titleSimilarity('Interstellr', 'Interstellar')).toBeGreaterThanOrEqual(WEAK_MATCH);
    expect(titleSimilarity('Interstellr', 'Interstellar')).toBeLessThan(STRONG_MATCH);
    expect(titleSimilarity('Heat', 'Heat Wave')).toBeLessThan(WEAK_MATCH);
    expect(titleSimilarity('Dune', 'Dune: Part Two')).toBeLessThan(WEAK_MATCH);
    expect(titleSimilarity('Inception', 'The Notebook')).toBeLessThan(0.3);
  });
  it('is symmetric, bounded and 0 for nothing', () => {
    expect(titleSimilarity('Alien', 'Aliens')).toBe(titleSimilarity('Aliens', 'Alien'));
    expect(titleSimilarity('', 'Alien')).toBe(0);
    expect(titleSimilarity('!!!', 'Alien')).toBe(0);
    for (const [a, b] of [
      ['a', 'b'],
      ['Se7en', 'Seven'],
      ['x', 'x y z'],
    ] as const) {
      const v = titleSimilarity(a, b);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('chooseResult', () => {
  const movie = (title: string, year: number, extra: Partial<Candidate> = {}): Candidate => ({
    media_type: 'movie',
    title,
    release_date: `${String(year)}-06-01`,
    poster_path: '/p.jpg',
    ...extra,
  });
  const show = (name: string, year: number, extra: Partial<Candidate> = {}): Candidate => ({
    media_type: 'tv',
    name,
    first_air_date: `${String(year)}-01-01`,
    poster_path: '/s.jpg',
    ...extra,
  });
  const target = (title: string, year: number | null, mediaType: 'movie' | 'tv' = 'movie') => ({
    title,
    year,
    mediaType,
  });

  it('picks the remake or original by year', () => {
    const results = [movie('Dune', 2021), movie('Dune', 1984)];
    expect(chooseResult(results, target('Dune', 1984))).toBe(results[1]);
    expect(chooseResult(results, target('Dune', 2021))).toBe(results[0]);
  });

  it('without a year, prefers the right kind of title, then TMDB’s own order', () => {
    const film = movie('Heat', 1995);
    const series = show('Heat', 2020);
    expect(chooseResult([series, film], target('Heat', null, 'movie'))).toBe(film);
    expect(chooseResult([film, series], target('Heat', null, 'tv'))).toBe(series);
    const a = movie('Heat', 1995);
    const b = movie('Heat', 1996);
    expect(chooseResult([a, b], target('Heat', null))).toBe(a);
  });

  it('the year outranks the kind: a title from the right year beats one of the right kind from another year', () => {
    const oldFilm = movie('Heat', 1995);
    const newSeries = show('Heat', 2020);
    expect(chooseResult([oldFilm, newSeries], target('Heat', 2020, 'movie'))).toBe(newSeries);
  });

  it('a result with a poster beats an equal one without', () => {
    const bare = movie('Heat', 1995, { poster_path: null });
    const full = movie('Heat', 1995);
    expect(chooseResult([bare, full], target('Heat', 1995))).toBe(full);
  });

  it('rejects a different title instead of showing the wrong poster', () => {
    expect(chooseResult([movie('Heat Wave', 2010)], target('Heat', 1995))).toBeNull();
    expect(chooseResult([movie('The Notebook', 2004)], target('Inception', 2010))).toBeNull();
    expect(
      chooseResult([movie('Inception: The Cobol Job', 2010)], target('Inception', 2010)),
    ).toBeNull();
  });

  it('accepts a close title only when the release year agrees', () => {
    const close = movie('Interstellr', 2014);
    expect(chooseResult([close], target('Interstellar', 2014))).toBe(close);
    expect(chooseResult([close], target('Interstellar', 2015))).toBeNull();
    expect(chooseResult([close], target('Interstellar', null))).toBeNull();
  });

  it('treats the library year as a hint: the same title with another year is still accepted', () => {
    const r = movie('Parasite', 2019);
    expect(chooseResult([r], target('Parasite', 2020))).toBe(r);
  });

  it('matches on the original title too (foreign releases)', () => {
    const r = movie('Parasite', 2019, { original_title: 'Gisaengchung' });
    expect(chooseResult([r], target('Gisaengchung', 2019))).toBe(r);
  });

  it('ignores accents, punctuation, "&" and a leading article', () => {
    const r = movie('Amélie', 2001);
    expect(chooseResult([r], target('Amelie', 2001))).toBe(r);
    const t = movie('Tom & Jerry', 2021);
    expect(chooseResult([t], target('Tom and Jerry', 2021))).toBe(t);
  });

  it('returns null for nothing, and for results with no name at all', () => {
    expect(chooseResult([], target('Heat', 1995))).toBeNull();
    expect(chooseResult([{ media_type: 'movie' }], target('Heat', 1995))).toBeNull();
  });
});

describe('keys and links', () => {
  it('keys ignore case, tags and spacing, and keep the year apart', () => {
    expect(metadataKey('Dark (Series)', 2017, 'tv')).toBe(metadataKey(' dark ', 2017, 'tv'));
    expect(metadataKey('Dark', 2017, 'tv')).not.toBe(metadataKey('Dark', null, 'tv'));
    expect(metadataKey('Dark', 2017, 'tv')).not.toBe(metadataKey('Dark', 2017, 'movie'));
    expect(metadataKey('Dark', 2017, 'tv')).toMatch(/^tmdb:v2:/);
  });
  it('builds an encoded YouTube search link', () => {
    expect(youtubeSearchUrl('Tom & Jerry (Series)')).toBe(
      'https://www.youtube.com/results?search_query=Tom%20%26%20Jerry%20official%20trailer',
    );
  });
});

describe('urls', () => {
  it('uses the small poster for cards and the larger one for the detail view', async () => {
    const { posterUrl, youtubeWatchUrl } = await import('../../src/services/tmdb/title');
    expect(posterUrl('/a.jpg', 'card')).toBe('https://image.tmdb.org/t/p/w342/a.jpg');
    expect(posterUrl('/a.jpg', 'detail')).toBe('https://image.tmdb.org/t/p/w500/a.jpg');
    expect(youtubeWatchUrl('abc')).toBe('https://www.youtube.com/watch?v=abc');
  });
});
