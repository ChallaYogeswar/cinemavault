import { normalizeTitle } from '@/domain/identity';
import type { MediaType, Movie } from '@/domain/movie';

/**
 * Deterministic demo data for milestone M2. These are NOT production records: ids, owner and dates
 * are synthetic, and nothing here is read from or written to Supabase.
 */
export const MOCK_OWNER_ID = '00000000-0000-4000-8000-0000000000aa';

export const fixtureId = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

type Row = readonly [
  title: string,
  mediaType: MediaType,
  year: number | null,
  genre: string | null,
  runtime: number | null,
  rating: number | null,
  /** A YYYY-MM-DD date, or the literal 'unwatched'. */
  watchedOn: string,
  verdict: string | null,
];

// Real, widely known titles used purely as realistic sample text.
const ROWS: readonly Row[] = [
  ['#Manhole', 'movie', 2023, 'Thriller', 100, 3, '2026-10-20', 'Tight premise, uneven finish.'],
  [
    'Parasite',
    'movie',
    2019,
    'Thriller, Drama',
    132,
    5,
    '2026-09-02',
    'Every frame earns its place.',
  ],
  ['Amélie', 'movie', 2001, 'Romance, Comedy', 122, 4, '2026-08-14', 'Pure warmth.'],
  [
    'Oldboy',
    'movie',
    2003,
    'Thriller, Mystery',
    120,
    5,
    '2026-07-11',
    'The hallway scene still hits.',
  ],
  ['Spirited Away', 'movie', 2001, 'Animation, Fantasy', 125, 5, '2026-06-30', null],
  ['The Dark Knight', 'movie', 2008, 'Action, Crime', 152, 4, '2026-06-02', 'Ledger carries it.'],
  ['Arrival', 'movie', 2016, 'Sci-Fi, Drama', 116, 4, '2026-05-18', null],
  [
    'Whiplash',
    'movie',
    2014,
    'Drama, Music',
    106,
    4.5,
    '2026-05-01',
    'Exhausting in the best way.',
  ],
  ['Breaking Bad (Series)', 'tv', 2008, 'Crime, Drama', null, 5, '2026-04-20', 'A flawless fall.'],
  ['Dark', 'tv', 2017, 'Sci-Fi, Mystery', null, 4, '2026-03-12', 'Needs a notebook.'],
  ['Chernobyl', 'tv', 2019, 'Drama, History', null, 5, '2026-02-02', null],
  ['Severance', 'tv', 2022, 'Sci-Fi, Thriller', null, null, 'unwatched', null],
  [
    'Interstellar',
    'movie',
    2014,
    'Sci-Fi, Adventure',
    169,
    3,
    '2026-01-09',
    'Big ideas, shaky third act.',
  ],
  ['Memories of Murder', 'movie', 2003, 'Crime, Mystery', 131, 5, '2025-12-21', null],
  ['Perfect Blue', 'movie', 1997, 'Animation, Thriller', 81, 4, '2025-12-05', null],
  ['The Handmaiden', 'movie', 2016, 'Romance, Thriller', 145, 4, '2025-11-17', null],
  [
    'Drishyam',
    'movie',
    2013,
    'Thriller, Drama',
    160,
    4,
    '2025-10-30',
    'Plot that keeps its promises.',
  ],
  ['Kumbalangi Nights', 'movie', 2019, 'Drama, Comedy', 135, null, 'unwatched', null],
  ['Hereditary', 'movie', 2018, 'Horror, Drama', 127, 2, '2025-10-02', 'Great first half.'],
  [
    'Everything Everywhere All at Once',
    'movie',
    2022,
    'Sci-Fi, Comedy',
    139,
    null,
    'unwatched',
    null,
  ],
  ['Blade Runner 2049', 'movie', 2017, 'Sci-Fi', 164, 4, '2025-09-09', null],
  [
    'Untitled Documentary Project',
    'movie',
    null,
    'Documentary',
    null,
    null,
    'unwatched',
    'Year unknown.',
  ],
  ['Old Family Footage', 'movie', null, null, 45, 1, '2025-08-01', null],
  ['Mad Max: Fury Road', 'movie', 2015, 'Action, Adventure', 120, 4, '2025-07-12', null],
  ['Gone Girl', 'movie', 2014, 'Thriller, Mystery', 149, 3.5, '2025-06-22', null],
  ['Fargo', 'tv', 2014, 'Crime, Drama', null, null, 'unwatched', null],
  ['Roma', 'movie', 2018, 'Drama', 135, 3, '2025-05-05', null],
  ['Coco', 'movie', 2017, 'Animation, Family', 105, 4, '2025-04-01', 'Cried. Twice.'],
];

const BASE_TIME = Date.parse('2026-10-01T09:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

export function buildMovie(n: number, row: Row, ownerId: string = MOCK_OWNER_ID): Movie {
  const [title, mediaType, year, genre, runtimeMinutes, userRating, watchedOn, verdict] = row;
  // Earlier rows are newer, so the default "recently added" order matches the array order.
  const created = BASE_TIME - n * 3_600_000;
  const watched = watchedOn !== 'unwatched';
  return {
    id: fixtureId(n + 1),
    ownerId,
    title,
    normalizedTitle: normalizeTitle(title),
    mediaType,
    year,
    genre,
    runtimeMinutes,
    watched,
    watchedOn: watched ? watchedOn : null,
    userRating,
    verdict,
    technicalNotes: null,
    shotLink: null,
    createdAt: iso(created),
    updatedAt: iso(created),
    deletedAt: null,
  };
}

export function createSeedMovies(ownerId: string = MOCK_OWNER_ID): Movie[] {
  return ROWS.map((row, index) => buildMovie(index, row, ownerId));
}

/**
 * Larger synthetic library to exercise rendering and filtering at the production scale
 * (3,243 live rows at the 2026-10-26 baseline). Deterministic: same count, same output.
 */
export function generateMovies(count: number, ownerId: string = MOCK_OWNER_ID): Movie[] {
  const genres = ['Drama', 'Thriller', 'Comedy', 'Sci-Fi', 'Crime', 'Animation', 'Horror'];
  return Array.from({ length: count }, (_, i) => {
    const year = 1950 + ((i * 7) % 76);
    const rated = i % 3 !== 0;
    return buildMovie(
      1_000 + i,
      [
        `Sample Title ${String(i + 1).padStart(4, '0')}`,
        i % 5 === 0 ? 'tv' : 'movie',
        i % 41 === 0 ? null : year,
        `${genres[i % genres.length] ?? 'Drama'}, ${genres[(i + 3) % genres.length] ?? 'Crime'}`,
        80 + (i % 90),
        rated ? ((i % 10) + 1) / 2 : null,
        rated ? '2026-01-15' : 'unwatched',
        null,
      ],
      ownerId,
    );
  });
}
