import { describe, expect, it } from 'vitest';
import { hasAtMostOneDecimal, movieInputSchema, movieSchema } from '@/domain/validation';

const valid = {
  title: '  #Manhole ',
  mediaType: 'movie',
  year: 2023,
  genre: ' Thriller, Horror ',
  runtimeMinutes: 105,
  watched: false,
  watchedOn: null,
  userRating: null,
  verdict: null,
  technicalNotes: null,
  shotLink: null,
} as const;

describe('movieInputSchema', () => {
  it('accepts and normalises a valid movie', () => {
    const out = movieInputSchema.parse(valid);
    expect(out.title).toBe('#Manhole');
    expect(out.genre).toBe('Thriller, Horror');
  });

  it('collapses internal whitespace in titles', () => {
    expect(movieInputSchema.parse({ ...valid, title: 'The    Office' }).title).toBe('The Office');
  });

  it.each([
    ['blank title', { title: '   ' }],
    ['over-long title', { title: 'x'.repeat(201) }],
    ['unknown media type', { mediaType: 'book' }],
    ['year before cinema', { year: 1887 }],
    ['year too far ahead', { year: 2101 }],
    ['fractional year', { year: 2020.5 }],
    ['zero runtime', { runtimeMinutes: 0 }],
    ['negative runtime', { runtimeMinutes: -5 }],
    ['rating above scale (DB caps at 5)', { userRating: 6 }],
    ['negative rating', { userRating: -1 }],
    ['bad date format', { watched: true, watchedOn: '26-10-2026' }],
  ])('rejects %s', (_label, patch) => {
    expect(movieInputSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it('accepts boundary values', () => {
    for (const patch of [
      { year: 1888 },
      { year: 2100 },
      { userRating: 0 },
      { userRating: 5 },
      { userRating: 3.5 },
    ]) {
      expect(movieInputSchema.safeParse({ ...valid, ...patch }).success).toBe(true);
    }
  });

  it('mirrors DB constraint: a watched date requires watched = true', () => {
    expect(
      movieInputSchema.safeParse({ ...valid, watched: false, watchedOn: '2026-10-26' }).success,
    ).toBe(false);
    expect(
      movieInputSchema.safeParse({ ...valid, watched: true, watchedOn: '2026-10-26' }).success,
    ).toBe(true);
    expect(movieInputSchema.safeParse({ ...valid, watched: true, watchedOn: null }).success).toBe(
      true,
    );
  });
});

const withWatched = (watchedOn: string) => ({ ...valid, watched: true, watchedOn });

describe('watchedOn is a real calendar date', () => {
  it.each(['2026-10-26', '2026-12-31', '2026-01-01', '2024-02-29', '2000-02-29', '2026-02-28'])(
    'accepts %s',
    (d) => {
      expect(movieInputSchema.safeParse(withWatched(d)).success).toBe(true);
    },
  );

  it.each([
    ['impossible month and day', '2026-99-99'],
    ['February 31st', '2026-02-31'],
    ['April 31st', '2026-04-31'],
    ['month 13', '2026-13-01'],
    ['month 00', '2026-00-10'],
    ['day 00', '2026-10-00'],
    ['Feb 29 in a non-leap year', '2025-02-29'],
    ['Feb 29 in 1900 (divisible by 100, not 400)', '1900-02-29'],
    ['Feb 29 in 2100 (divisible by 100, not 400)', '2100-02-29'],
    ['single-digit parts', '2026-1-1'],
    ['a timestamp instead of a date', '2026-01-01T00:00:00Z'],
    ['day-month-year order', '26-10-2026'],
    ['empty string', ''],
  ])('rejects %s (%s)', (_label, d) => {
    expect(movieInputSchema.safeParse(withWatched(d)).success).toBe(false);
  });

  it('applies the same rule to stored records', () => {
    const record = {
      id: '3f2b1c8e-5d0a-4b3e-9c1d-2a7f6e5d4c3b',
      ownerId: 'caa6cc74-8df4-4408-b031-b17e76208e78',
      title: 't',
      normalizedTitle: 't',
      mediaType: 'movie',
      year: null,
      genre: null,
      runtimeMinutes: null,
      watched: true,
      watchedOn: '2026-02-31',
      userRating: null,
      verdict: null,
      technicalNotes: null,
      shotLink: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
    };
    expect(movieSchema.safeParse(record).success).toBe(false);
    expect(movieSchema.safeParse({ ...record, watchedOn: '2024-02-29' }).success).toBe(true);
  });
});

describe('userRating matches numeric(3,1)', () => {
  it.each([0, 4, 4.5, 5, 0.5, 1.1, 2.7])('accepts %s', (r) => {
    expect(movieInputSchema.safeParse({ ...valid, userRating: r }).success).toBe(true);
  });

  it.each([
    ['4.55 (would be rounded by Postgres)', 4.55],
    ['4.25', 4.25],
    ['0.05', 0.05],
    ['4.999', 4.999],
    ['float noise 0.30000000000000004', 0.1 + 0.2],
    ['above scale', 5.1],
    ['below scale', -0.1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s', (_label, r) => {
    expect(movieInputSchema.safeParse({ ...valid, userRating: r }).success).toBe(false);
  });

  it('null means "not rated"', () => {
    expect(movieInputSchema.safeParse({ ...valid, userRating: null }).success).toBe(true);
  });

  it('hasAtMostOneDecimal agrees on the boundaries', () => {
    expect(hasAtMostOneDecimal(4)).toBe(true);
    expect(hasAtMostOneDecimal(4.5)).toBe(true);
    expect(hasAtMostOneDecimal(4.55)).toBe(false);
    expect(hasAtMostOneDecimal(0)).toBe(true);
    expect(hasAtMostOneDecimal(5)).toBe(true);
  });
});

describe('movieSchema', () => {
  it('rejects non-UUID ids and bad timestamps', () => {
    const record = {
      id: 'not-a-uuid',
      ownerId: 'also-bad',
      title: 't',
      normalizedTitle: 't',
      mediaType: 'movie',
      year: null,
      genre: null,
      runtimeMinutes: null,
      watched: false,
      watchedOn: null,
      userRating: null,
      verdict: null,
      technicalNotes: null,
      shotLink: null,
      createdAt: 'yesterday',
      updatedAt: 'today',
      deletedAt: null,
    };
    expect(movieSchema.safeParse(record).success).toBe(false);
  });
});

describe('shotLink (rendered as a link, so only http(s) may be stored)', () => {
  const base = {
    title: 'X',
    mediaType: 'movie' as const,
    year: null,
    genre: null,
    runtimeMinutes: null,
    watched: false,
    watchedOn: null,
    userRating: null,
    verdict: null,
    technicalNotes: null,
  };
  it.each(['https://example.com/a.png', 'http://example.com'])('accepts %s', (shotLink) => {
    expect(movieInputSchema.safeParse({ ...base, shotLink }).success).toBe(true);
  });
  it.each([
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'ftp://x.test/a',
    'not a url',
    '//evil.test',
  ])('rejects %s', (shotLink) => {
    expect(movieInputSchema.safeParse({ ...base, shotLink }).success).toBe(false);
  });
  it('treats blank as no link', () => {
    const parsed = movieInputSchema.safeParse({ ...base, shotLink: '   ' });
    expect(parsed.success && parsed.data.shotLink).toBe(null);
  });
});
