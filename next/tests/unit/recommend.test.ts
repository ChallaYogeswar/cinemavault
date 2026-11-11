import { describe, expect, it } from 'vitest';
import { buildMovie } from '@/data/mock/fixtures';
import type { Movie } from '@/domain/movie';
import {
  BACKLOG_EXPONENT,
  COOLDOWN_FACTOR,
  MIN_WEIGHT,
  HISTORY_MAX_AGE_DAYS,
  UNCATEGORIZED,
  freshHistory,
  genreWeight,
  genresOf,
  historyEntryFor,
  inventory,
  narrow,
  pickFacts,
  pickGlobal,
  pickInGenre,
  type HistoryEntry,
  type Random,
} from '@/domain/recommend';

const OWNER = '00000000-0000-4000-8000-0000000000aa';
let counter = 700;
const movie = (genre: string | null, extra: Partial<Movie> = {}): Movie => {
  counter += 1;
  return {
    ...buildMovie(
      counter,
      [`Title ${String(counter)}`, 'movie', 2000, genre, 100, null, 'unwatched', null],
      OWNER,
    ),
    ...extra,
  };
};
const many = (n: number, genre: string | null) => Array.from({ length: n }, () => movie(genre));

/** mulberry32: a tiny seeded generator so statistical tests are exact and repeatable. */
const seeded = (seed: number): Random => {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const fixed = (...values: number[]): Random => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
};
const entry = (m: Movie, genres: string[] = genresOf(m)): HistoryEntry => ({
  movieId: m.id,
  genres,
  result: 'recommended',
  at: '2026-11-01T00:00:00.000Z',
});

describe('genres and inventory', () => {
  it('gives titles with no genre their own bucket', () => {
    expect(genresOf(movie(null))).toEqual([UNCATEGORIZED]);
    expect(genresOf(movie('  '))).toEqual([UNCATEGORIZED]);
  });

  it('counts only unwatched, non-deleted titles, once per genre, case-insensitively', () => {
    const rows = inventory([
      movie('Drama, Crime'),
      movie('drama'),
      movie('Drama', { watched: true }),
      movie('Drama', { deletedAt: '2026-01-01T00:00:00.000Z' }),
      movie('Comedy'),
    ]);
    expect(rows.map((r) => [r.genre, r.count])).toEqual([
      ['Drama', 2],
      ['Comedy', 1],
      ['Crime', 1],
    ]);
  });

  it('sorts by backlog, then alphabetically', () => {
    const rows = inventory([movie('B'), movie('A'), movie('C'), movie('C')]);
    expect(rows.map((r) => r.genre)).toEqual(['C', 'A', 'B']);
  });
});

describe('genre weight', () => {
  it('grows with the backlog but sub-linearly', () => {
    expect(genreWeight(1, 0)).toBe(1);
    expect(genreWeight(16, 0)).toBeCloseTo(16 ** BACKLOG_EXPONENT);
    expect(genreWeight(16, 0)).toBeLessThan(16);
  });

  it('cools down by recent hits, capped at three', () => {
    expect(genreWeight(10, 1)).toBeCloseTo(10 ** BACKLOG_EXPONENT * COOLDOWN_FACTOR);
    expect(genreWeight(10, 3)).toBeCloseTo(10 ** BACKLOG_EXPONENT * COOLDOWN_FACTOR ** 3);
    expect(genreWeight(10, 9)).toBe(genreWeight(10, 3));
  });

  it('never reaches zero', () => {
    expect(genreWeight(0, 0)).toBe(MIN_WEIGHT);
    expect(genreWeight(1, 3)).toBeGreaterThanOrEqual(MIN_WEIGHT);
  });
});

describe('global pick', () => {
  it('returns null when nothing is left to watch', () => {
    expect(pickGlobal({ movies: [], random: Math.random })).toBeNull();
    expect(
      pickGlobal({ movies: [movie('Drama', { watched: true })], random: Math.random }),
    ).toBeNull();
    expect(
      pickGlobal({
        movies: [movie('Drama', { deletedAt: '2026-01-01T00:00:00.000Z' })],
        random: Math.random,
      }),
    ).toBeNull();
  });

  it('never picks a watched or deleted title', () => {
    const movies = [
      ...many(5, 'Drama'),
      ...many(5, 'Drama').map((m) => ({ ...m, watched: true })),
      ...many(5, 'Drama').map((m) => ({ ...m, deletedAt: '2026-01-01T00:00:00.000Z' })),
    ];
    const random = seeded(1);
    for (let i = 0; i < 300; i += 1) {
      const pick = pickGlobal({ movies, random });
      expect(pick?.movie.watched).toBe(false);
      expect(pick?.movie.deletedAt).toBeNull();
    }
  });

  it('favours a big backlog without drowning small genres (statistically, seeded)', () => {
    const movies = [...many(16, 'Drama'), ...many(1, 'Western')];
    const random = seeded(42);
    let drama = 0;
    const draws = 20_000;
    for (let i = 0; i < draws; i += 1) {
      if (pickGlobal({ movies, random })?.genre === 'Drama') drama += 1;
    }
    const expected = 16 ** BACKLOG_EXPONENT / (16 ** BACKLOG_EXPONENT + 1); // ≈ 0.84
    expect(drama / draws).toBeGreaterThan(expected - 0.02);
    expect(drama / draws).toBeLessThan(expected + 0.02);
  });

  it('cools down genres shown recently', () => {
    const movies = [...many(16, 'Drama'), ...many(1, 'Western')];
    const [lastDrama] = movies;
    if (!lastDrama) throw new Error('fixture is empty');
    const history = [entry(lastDrama), entry(lastDrama), entry(lastDrama)];
    const random = seeded(7);
    let drama = 0;
    const draws = 20_000;
    for (let i = 0; i < draws; i += 1) {
      if (pickGlobal({ movies, history, random })?.genre === 'Drama') drama += 1;
    }
    const w = 16 ** BACKLOG_EXPONENT * COOLDOWN_FACTOR ** 3;
    const expected = w / (w + 1); // ≈ 0.28
    expect(drama / draws).toBeGreaterThan(expected - 0.02);
    expect(drama / draws).toBeLessThan(expected + 0.02);
  });

  it('avoids the last few titles shown, but still answers from a tiny genre', () => {
    const [a, b, c] = many(3, 'Drama') as [Movie, Movie, Movie];
    const random = seeded(3);
    for (let i = 0; i < 200; i += 1) {
      expect(
        pickGlobal({ movies: [a, b, c], history: [entry(a), entry(b)], random })?.movie.id,
      ).toBe(c.id);
    }
    // Everything was shown lately: still picks something rather than nothing.
    const pick = pickGlobal({ movies: [a], history: [entry(a)], random });
    expect(pick?.movie.id).toBe(a.id);
  });

  it('avoids the title on screen when asked, if there is any other', () => {
    const [a, b] = many(2, 'Drama') as [Movie, Movie];
    const random = seeded(5);
    for (let i = 0; i < 100; i += 1) {
      expect(pickGlobal({ movies: [a, b], avoid: [a.id], random })?.movie.id).toBe(b.id);
    }
    expect(pickGlobal({ movies: [a], avoid: [a.id], random })?.movie.id).toBe(a.id);
  });

  it('when the only other titles were shown lately, prefers them over repeating the one on screen', () => {
    const [a, b] = many(2, 'Drama') as [Movie, Movie];
    const random = seeded(21);
    for (let i = 0; i < 100; i += 1) {
      expect(
        pickGlobal({ movies: [a, b], history: [entry(b)], avoid: [a.id], random })?.movie.id,
      ).toBe(b.id);
    }
  });

  it('never repeats the title on screen when everything else was already shown (current)', () => {
    const [a, b, c] = many(3, 'Drama') as [Movie, Movie, Movie];
    const random = seeded(33);
    for (let i = 0; i < 200; i += 1) {
      const pick = pickGlobal({
        movies: [a, b, c],
        history: [entry(a), entry(b), entry(c)],
        avoid: [a.id, b.id, c.id],
        current: a.id,
        random,
      });
      expect(pick?.movie.id).not.toBe(a.id);
    }
  });

  it('still answers with the current title when it is the only one there is', () => {
    const [a] = many(1, 'Drama') as [Movie];
    expect(
      pickGlobal({ movies: [a], avoid: [a.id], current: a.id, random: seeded(1) })?.movie.id,
    ).toBe(a.id);
  });

  it('prefers a title not shown on this visit over one that was, even when current is set', () => {
    const [a, b, c] = many(3, 'Drama') as [Movie, Movie, Movie];
    const random = seeded(44);
    for (let i = 0; i < 100; i += 1) {
      expect(
        pickGlobal({ movies: [a, b, c], avoid: [a.id, b.id], current: a.id, random })?.movie.id,
      ).toBe(c.id);
    }
  });

  it('handles extreme random values (0 and just under 1) and a broken generator', () => {
    const movies = [...many(3, 'Drama'), ...many(3, 'Comedy')];
    expect(pickGlobal({ movies, random: fixed(0, 0) })?.movie).toBeDefined();
    expect(pickGlobal({ movies, random: fixed(0.9999999999, 0.9999999999) })?.movie).toBeDefined();
    for (const bad of [Number.NaN, -1, 5, Number.POSITIVE_INFINITY]) {
      expect(pickGlobal({ movies, random: () => bad })?.movie).toBeDefined();
    }
  });

  it('says why: a large backlog, or balance', () => {
    const big = pickGlobal({
      movies: [...many(10, 'Drama'), ...many(1, 'Western')],
      random: fixed(0, 0),
    });
    expect(big?.reason).toMatch(/Drama currently has a large unwatched backlog/);
    const small = pickGlobal({
      movies: [...many(10, 'Drama'), ...many(1, 'Western')],
      random: fixed(0.999, 0),
    });
    expect(small?.genre).toBe('Western');
    expect(small?.reason).toMatch(/backlog balance/);
  });

  it('a movie in several genres can be reached through any of them', () => {
    const only = movie('Drama, Crime');
    const seen = new Set<string>();
    const random = seeded(9);
    for (let i = 0; i < 100; i += 1) {
      const pick = pickGlobal({ movies: [only], random });
      expect(pick?.movie.id).toBe(only.id);
      seen.add(pick?.genre ?? '');
    }
    expect(seen).toEqual(new Set(['Drama', 'Crime']));
  });
});

describe('genre pick', () => {
  const movies = [
    ...many(4, 'Drama, Crime'),
    ...many(4, 'Comedy'),
    movie('Drama', { watched: true }),
  ];

  it('only returns titles of that genre, ignoring case and whitespace', () => {
    const random = seeded(11);
    for (let i = 0; i < 100; i += 1) {
      const pick = pickInGenre({ movies, genre: '  dRaMa ', random });
      expect(pick?.movie.genre).toContain('Drama');
      expect(pick?.movie.watched).toBe(false);
      expect(pick?.genre).toBe('Drama');
      expect(pick?.kind).toBe('genre-random');
    }
  });

  it('returns null for a genre with nothing unwatched, or one that does not exist', () => {
    expect(pickInGenre({ movies, genre: 'Western', random: Math.random })).toBeNull();
    expect(
      pickInGenre({
        movies: [movie('Drama', { watched: true })],
        genre: 'Drama',
        random: Math.random,
      }),
    ).toBeNull();
  });

  it('is uniform inside the genre (seeded)', () => {
    const drama = many(4, 'Drama');
    const counts = new Map<string, number>();
    const random = seeded(13);
    for (let i = 0; i < 8000; i += 1) {
      const id = pickInGenre({ movies: drama, genre: 'Drama', random })?.movie.id ?? '';
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const count of counts.values()) expect(Math.abs(count / 8000 - 0.25)).toBeLessThan(0.03);
  });

  it('avoids the title on screen when it can', () => {
    const [a, b] = many(2, 'Drama') as [Movie, Movie];
    const random = seeded(17);
    for (let i = 0; i < 50; i += 1) {
      expect(pickInGenre({ movies: [a, b], genre: 'Drama', avoid: [a.id], random })?.movie.id).toBe(
        b.id,
      );
    }
  });
});

describe('pickInGenre with current', () => {
  it('never repeats the title on screen when the genre was fully shown', () => {
    const [a, b] = many(2, 'Drama') as [Movie, Movie];
    const random = seeded(55);
    for (let i = 0; i < 100; i += 1) {
      expect(
        pickInGenre({ movies: [a, b], genre: 'Drama', avoid: [a.id, b.id], current: a.id, random })
          ?.movie.id,
      ).toBe(b.id);
    }
  });
});

describe('history entries', () => {
  it('records what was shown, in a form the pickers read back', () => {
    const m = movie('Drama, Crime');
    const pick = pickInGenre({ movies: [m], genre: 'crime', random: Math.random });
    if (!pick) throw new Error('expected a pick');
    expect(historyEntryFor(pick, new Date('2026-11-04T10:00:00Z'))).toEqual({
      movieId: m.id,
      genres: ['Drama', 'Crime'],
      result: 'genre-random',
      at: '2026-11-04T10:00:00.000Z',
    });
  });
});

describe('freshHistory', () => {
  const NOW = new Date('2026-11-05T12:00:00.000Z');
  const at = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
  const rec = (when: string): HistoryEntry => ({ ...entry(movie('Drama')), at: when });

  it('keeps recent entries in their order and drops those older than the limit', () => {
    const entries = [
      rec(at(1)),
      rec(at(HISTORY_MAX_AGE_DAYS)),
      rec(at(HISTORY_MAX_AGE_DAYS + 0.01)),
    ];
    const fresh = freshHistory(entries, NOW);
    expect(fresh).toEqual([entries[0], entries[1]]);
  });

  it('drops entries whose date is unreadable or in the future (a wrong device clock)', () => {
    const entries = [rec('not a date'), rec(''), rec(at(-1)), rec(at(2))];
    expect(freshHistory(entries, NOW)).toEqual([entries[3]]);
  });

  it('an entry from this very moment still counts', () => {
    expect(freshHistory([rec(NOW.toISOString())], NOW)).toHaveLength(1);
  });

  it('makes a stale history stop steering the pick', () => {
    const drama = many(4, 'Drama');
    const comedy = many(4, 'Comedy');
    const recent = Array.from({ length: 12 }, () => rec(at(60))); // all stale Drama picks
    const withStale = Array.from(
      { length: 40 },
      (_, i) =>
        pickGlobal({ movies: [...drama, ...comedy], history: recent, random: seeded(i) })?.genre,
    );
    const cleaned = Array.from(
      { length: 40 },
      (_, i) =>
        pickGlobal({
          movies: [...drama, ...comedy],
          history: freshHistory(recent, NOW),
          random: seeded(i),
        })?.genre,
    );
    expect(withStale.filter((g) => g === 'Drama').length).toBeLessThan(
      cleaned.filter((g) => g === 'Drama').length,
    );
  });
});

describe('narrow', () => {
  const film = movie('Drama', { mediaType: 'movie' });
  const show = movie('Drama', { mediaType: 'tv' });
  const none = new Set<string>();

  it('keeps everything when nothing is chosen', () => {
    expect(narrow([film, show], { kind: null, hidden: none })).toEqual([film, show]);
  });

  it('keeps only the chosen kind', () => {
    expect(narrow([film, show], { kind: 'tv', hidden: none })).toEqual([show]);
    expect(narrow([film, show], { kind: 'movie', hidden: none })).toEqual([film]);
  });

  it('drops hidden titles whatever the kind', () => {
    expect(narrow([film, show], { kind: null, hidden: new Set([film.id]) })).toEqual([show]);
    expect(narrow([film, show], { kind: 'movie', hidden: new Set([film.id]) })).toEqual([]);
  });
});

describe('pickFacts', () => {
  const NOW = new Date('2026-11-05T12:00:00.000Z');
  const added = (iso: string) => ({ createdAt: iso, runtimeMinutes: null });

  it('says how long it has been on the list, in plain units', () => {
    expect(pickFacts(movie(null, added('2026-11-01T00:00:00.000Z')), [], NOW)).toEqual([
      'Added recently.',
    ]);
    expect(pickFacts(movie(null, added('2026-09-01T00:00:00.000Z')), [], NOW)[0]).toBe(
      'On your list for 2 months.',
    );
    expect(pickFacts(movie(null, added('2025-10-01T00:00:00.000Z')), [], NOW)[0]).toBe(
      'On your list for over 1 year.',
    );
    expect(pickFacts(movie(null, added('2023-01-01T00:00:00.000Z')), [], NOW)[0]).toBe(
      'On your list for over 3 years.',
    );
  });

  it('says nothing about time when the added date is unreadable or in the future', () => {
    expect(pickFacts(movie(null, added('garbage')), [], NOW)).toEqual([]);
    expect(pickFacts(movie(null, added('2030-01-01T00:00:00.000Z')), [], NOW)).toEqual([]);
  });

  it('reports how much of the genre has been watched, counting multi-genre titles and ignoring deleted ones', () => {
    const target = movie('Drama, Crime', added('2026-11-04T00:00:00.000Z'));
    const library = [
      target,
      movie('drama', { watched: true }),
      movie('Thriller, Drama', { watched: true }),
      movie('Drama', { watched: true, deletedAt: '2026-01-01T00:00:00.000Z' }),
      movie('Comedy', { watched: true }),
    ];
    expect(pickFacts(target, library, NOW)).toContain('You’ve watched 2 of your 3 Drama titles.');
  });

  it('says so when none of the genre has been watched, and nothing for an uncategorized title', () => {
    const target = movie('Noir');
    expect(pickFacts(target, [target], NOW)).toContain(
      'You haven’t watched any of your 1 Noir titles yet.',
    );
    const plain = movie(null);
    expect(pickFacts(plain, [plain], NOW).some((f) => f.includes(UNCATEGORIZED))).toBe(false);
  });

  it('describes runtime for films only, as short, long or plain', () => {
    expect(pickFacts(movie(null, { runtimeMinutes: 88 }), [], NOW)).toContain(
      'A short one: 1 h 28 min.',
    );
    expect(pickFacts(movie(null, { runtimeMinutes: 75 }), [], NOW)).toContain(
      'A short one: 1 h 15 min.',
    );
    expect(pickFacts(movie(null, { runtimeMinutes: 50 }), [], NOW)).toContain(
      'A short one: 50 min.',
    );
    expect(pickFacts(movie(null, { runtimeMinutes: 170 }), [], NOW)).toContain(
      'A long one: 2 h 50 min.',
    );
    expect(pickFacts(movie(null, { runtimeMinutes: 120 }), [], NOW)).toContain('About 2 h.');
    expect(pickFacts(movie(null, { runtimeMinutes: null }), [], NOW).join(' ')).not.toMatch(
      /min|About/,
    );
    expect(pickFacts(movie(null, { runtimeMinutes: 0 }), [], NOW).join(' ')).not.toMatch(
      /short|long/,
    );
    expect(
      pickFacts(movie(null, { mediaType: 'tv', runtimeMinutes: 45 }), [], NOW).join(' '),
    ).not.toMatch(/min/);
  });

  it('gives one fact for each thing that is known, three at most', () => {
    const m = movie('Drama', { ...added('2020-01-01T00:00:00.000Z'), runtimeMinutes: 100 });
    expect(pickFacts(m, [m], NOW)).toHaveLength(3);
  });
});
