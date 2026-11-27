import { describe, expect, it } from 'vitest';
import { buildMovie } from '@/data/mock/fixtures';
import type { Movie } from '@/domain/movie';
import { computeStats } from '@/domain/stats';

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const NOW = new Date(2026, 10, 15, 12); // 15 Nov 2026, local time

let n = 900;
const title = (extra: Partial<Movie> & { genre?: string | null } = {}): Movie => {
  n += 1;
  return {
    ...buildMovie(
      n,
      [`T${String(n)}`, 'movie', 2000, 'Drama', 100, null, 'unwatched', null],
      OWNER,
    ),
    ...extra,
  };
};
const seen = (on: string, extra: Partial<Movie> = {}) =>
  title({ watched: true, watchedOn: on, ...extra });

describe('totals', () => {
  it('is all zero and never divides by zero for an empty library', () => {
    const s = computeStats([], NOW);
    expect(s).toMatchObject({
      total: 0,
      films: 0,
      series: 0,
      watched: 0,
      unwatched: 0,
      completionPercent: 0,
    });
    expect(s.rating).toEqual({ average: null, rated: 0, buckets: [0, 0, 0, 0, 0, 0] });
    expect(s.genres).toEqual([]);
    expect(s.years).toEqual([]);
    expect(s.lastWatchedOn).toBeNull();
    expect(s.months).toHaveLength(12);
    expect(s.months.every((m) => m.count === 0)).toBe(true);
    expect(s.backlog).toMatchObject({
      count: 0,
      byGenre: [],
      knownMinutes: 0,
      unknownRuntime: 0,
      longestWaiting: [],
    });
  });

  it('counts films, series, watched and unwatched, and ignores deleted titles', () => {
    const library = [
      title(),
      title({ mediaType: 'tv' }),
      seen('2026-01-02'),
      seen('2026-02-03', { mediaType: 'tv' }),
      seen('2026-02-04', { deletedAt: '2026-03-01T00:00:00.000Z' }),
      title({ deletedAt: '2026-03-01T00:00:00.000Z' }),
    ];
    const s = computeStats(library, NOW);
    expect(s).toMatchObject({
      total: 4,
      films: 2,
      series: 2,
      watched: 2,
      unwatched: 2,
      completionPercent: 50,
    });
  });

  it('rounds the completion percentage', () => {
    const library = [seen('2026-01-01'), title(), title()];
    expect(computeStats(library, NOW).completionPercent).toBe(33);
    expect(
      computeStats([seen('2026-01-01'), seen('2026-01-02'), title()], NOW).completionPercent,
    ).toBe(67);
  });
});

describe('ratings', () => {
  it('averages every rating given, to one decimal, ignoring unrated and deleted titles', () => {
    const library = [
      seen('2026-01-01', { userRating: 4.5 }),
      seen('2026-01-02', { userRating: 3 }),
      seen('2026-01-03', { userRating: 4 }),
      seen('2026-01-04'),
      seen('2026-01-05', { userRating: 1, deletedAt: '2026-03-01T00:00:00.000Z' }),
    ];
    const { rating } = computeStats(library, NOW);
    expect(rating.average).toBe(3.8);
    expect(rating.rated).toBe(3);
  });

  it('buckets by the nearest whole star, .5 up, and counts a rating of 0', () => {
    const ratings = [0, 0.5, 1, 1.5, 2.4, 2.5, 4.5, 5, 5];
    const { rating } = computeStats(
      ratings.map((r) => seen('2026-01-01', { userRating: r })),
      NOW,
    );
    expect(rating.buckets).toEqual([1, 2, 2, 1, 0, 3]);
    expect(rating.buckets.reduce((a, b) => a + b, 0)).toBe(ratings.length);
  });

  it('ignores out-of-range or non-finite ratings instead of poisoning the average', () => {
    const library = [
      seen('2026-01-01', { userRating: 4 }),
      seen('2026-01-02', { userRating: 9 }),
      seen('2026-01-03', { userRating: -1 }),
      seen('2026-01-04', { userRating: Number.NaN }),
    ];
    const { rating } = computeStats(library, NOW);
    expect(rating).toMatchObject({ average: 4, rated: 1 });
  });

  it('counts a rating on an unwatched title (it is still the person’s rating)', () => {
    expect(computeStats([title({ userRating: 2 })], NOW).rating.rated).toBe(1);
  });
});

describe('genres', () => {
  const library = [
    seen('2026-01-01', { genre: 'Drama' }),
    seen('2026-01-02', { genre: 'Drama, Crime' }),
    seen('2026-01-03', { genre: 'crime' }),
    title({ genre: 'Drama' }),
    title({ genre: 'Comedy' }),
    title({ genre: null }),
  ];
  const s = computeStats(library, NOW);

  it('counts a multi-genre title once in each genre, case-insensitively, biggest first', () => {
    expect(s.genres.map((g) => [g.genre, g.total, g.watched, g.unwatched])).toEqual([
      ['Drama', 3, 2, 1],
      ['Crime', 2, 2, 0],
      ['Comedy', 1, 0, 1],
      ['Uncategorized', 1, 0, 1],
    ]);
  });

  it('lists the most watched genres: only those watched at least once, at most five', () => {
    expect(s.mostWatchedGenres.map((g) => [g.genre, g.watched])).toEqual([
      ['Crime', 2],
      ['Drama', 2],
    ]);
    const many = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((g) => seen('2026-01-01', { genre: g }));
    expect(computeStats(many, NOW).mostWatchedGenres).toHaveLength(5);
  });
});

describe('watch history', () => {
  it('covers exactly the last 12 months, oldest first, with zeros', () => {
    const { months } = computeStats([], NOW);
    expect(months[0]?.month).toBe('2025-12');
    expect(months[11]?.month).toBe('2026-11');
  });

  it('crosses a year boundary and short months correctly', () => {
    const jan = computeStats([], new Date(2026, 0, 31));
    expect(jan.months.map((m) => m.month)).toEqual([
      '2025-02',
      '2025-03',
      '2025-04',
      '2025-05',
      '2025-06',
      '2025-07',
      '2025-08',
      '2025-09',
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
    ]);
    const mar = computeStats([], new Date(2026, 2, 31)); // 31 March: February must not be skipped
    expect(mar.months.map((m) => m.month)).toContain('2026-02');
  });

  it('counts watches per month, per year, and this year', () => {
    const library = [
      seen('2026-11-01'),
      seen('2026-11-30'),
      seen('2026-10-15'),
      seen('2025-12-31'),
      seen('2025-01-01'), // outside the 12 months, still in the yearly total
      seen('2024-06-06'),
    ];
    const s = computeStats(library, NOW);
    expect(s.months.find((m) => m.month === '2026-11')?.count).toBe(2);
    expect(s.months.find((m) => m.month === '2026-10')?.count).toBe(1);
    expect(s.months.find((m) => m.month === '2025-12')?.count).toBe(1);
    expect(s.months.reduce((sum, m) => sum + m.count, 0)).toBe(4);
    expect(s.years).toEqual([
      { year: 2026, count: 3 },
      { year: 2025, count: 2 },
      { year: 2024, count: 1 },
    ]);
    expect(s.watchedThisYear).toBe(3);
    expect(s.lastWatchedOn).toBe('2026-11-30');
  });

  it('skips a watched title with no usable date rather than guessing', () => {
    const library = [
      seen('2026-11-01'),
      title({ watched: true, watchedOn: null }),
      seen('not-a-date'),
      seen('2026-13-01'),
      seen('2026-02-30x'),
    ];
    const s = computeStats(library, NOW);
    expect(s.watched).toBe(5);
    expect(s.years).toEqual([{ year: 2026, count: 1 }]);
    expect(s.lastWatchedOn).toBe('2026-11-01');
  });

  it('ignores the date of an unwatched title', () => {
    const odd = title({ watched: false, watchedOn: '2026-11-01' });
    expect(computeStats([odd], NOW).years).toEqual([]);
  });
});

describe('backlog', () => {
  it('sums known runtimes, counts the unknown ones, and lists genres and the longest waiting', () => {
    const old = title({
      genre: 'Noir',
      runtimeMinutes: 90,
      createdAt: '2020-01-01T00:00:00.000Z',
      title: 'Old',
    });
    const library = [
      old,
      title({
        genre: 'Noir',
        runtimeMinutes: 110,
        createdAt: '2021-01-01T00:00:00.000Z',
        title: 'Newer',
      }),
      title({ genre: 'Comedy', runtimeMinutes: null, createdAt: '2022-01-01T00:00:00.000Z' }),
      title({ genre: 'Comedy', runtimeMinutes: 0, createdAt: '2023-01-01T00:00:00.000Z' }),
      seen('2026-01-01', { genre: 'Noir', runtimeMinutes: 100 }),
    ];
    const { backlog, watchedMinutes } = computeStats(library, NOW);
    expect(backlog.count).toBe(4);
    expect(backlog.knownMinutes).toBe(200);
    expect(backlog.unknownRuntime).toBe(2);
    expect(backlog.byGenre).toEqual([
      { genre: 'Comedy', count: 2 },
      { genre: 'Noir', count: 2 },
    ]);
    expect(backlog.longestWaiting[0]).toBe(old);
    expect(watchedMinutes).toBe(100);
  });

  it('shows at most five of each, oldest first', () => {
    const library = Array.from({ length: 8 }, (_, i) =>
      title({ createdAt: `20${String(10 + i)}-01-01T00:00:00.000Z` }),
    );
    const { backlog } = computeStats(library, NOW);
    expect(backlog.longestWaiting).toHaveLength(5);
    expect(backlog.longestWaiting.map((m) => m.createdAt.slice(0, 4))).toEqual([
      '2010',
      '2011',
      '2012',
      '2013',
      '2014',
    ]);
  });

  it('does not mutate the library it is given', () => {
    const library = [
      title({ createdAt: '2022-01-01T00:00:00.000Z' }),
      title({ createdAt: '2020-01-01T00:00:00.000Z' }),
    ];
    const before = library.map((m) => m.id);
    computeStats(library, NOW);
    expect(library.map((m) => m.id)).toEqual(before);
  });
});
