import { describe, expect, it } from 'vitest';
import { movieToRow, rowToMovie } from '@/data/mappers/movieMapper';

const OWNER = 'caa6cc74-8df4-4408-b031-b17e76208e78';
const row = (patch: Record<string, unknown>) => ({
  // widened on purpose: PostgREST may send a numeric as a string

  id: '8158cf95-1046-4a3a-ae6a-8a2a0dc6e96e',
  owner_id: OWNER,
  title: 'Gangs of New York',
  normalized_title: 'gangs of new york',
  media_type: 'movie',
  year: 2002,
  genre: 'Crime/Drama',
  runtime_minutes: 167,
  watched: false,
  watched_on: null,
  user_rating: null,
  verdict: null,
  technical_notes: null,
  shot_link: null,
  created_at: '2026-10-15T18:16:47.846372+00:00',
  updated_at: '2026-10-15T18:16:47.846372+00:00',
  deleted_at: null,
  ...patch,
});

/**
 * Shapes found in the real library during the migration rehearsal. Each is a way production data
 * differs from what a tidy fixture looks like; every one must load, and write back unchanged.
 */
describe('rows shaped like the real library', () => {
  it.each([
    [
      'imported punctuation-free normalized title',
      { title: 'Mr. & Mrs. Mahi', normalized_title: 'mr mrs mahi' },
    ],
    [
      'accent-folded normalized title',
      { title: 'Léon: The Professional', normalized_title: 'leon the professional' },
    ],
    ['title with straight quotes', { title: 'Goodfellas (Listed as "Good fellas")' }],
    [
      'pasted web-snippet title with a bullet',
      {
        title: 'Psycho . 1960 ‧ Horror/Mystery ‧ 1h 49m',
        normalized_title: 'psycho . 1960 ‧ horror/mystery ‧ 1h 49m',
      },
    ],
    ['no year, no runtime', { year: null, runtime_minutes: null }],
    ['a far-future watched date', { watched: true, watched_on: '2222-01-01', user_rating: 4 }],
    ['a rating PostgREST returns as a string', { user_rating: '4.0' }],
    ['a tombstone with millisecond precision', { deleted_at: '2026-10-23T16:07:08.732+00:00' }],
    [
      'a version stamp that is not a whole millisecond',
      { updated_at: '2026-10-25T16:08:58.396273+00:00' },
    ],
    ['a created stamp with a short fraction', { created_at: '2026-10-21T09:12:35.956+00:00' }],
  ])('%s', (_name, patch) => {
    const raw = row(patch);
    const movie = rowToMovie(raw);
    const back = movieToRow(movie);
    expect(back.title).toBe(raw.title);
    expect(back.normalized_title).toBe(raw.normalized_title);
    expect(back.created_at).toBe(raw.created_at);
    expect(back.updated_at).toBe(raw.updated_at);
    expect(back.deleted_at).toBe(raw.deleted_at);
    expect(back.watched_on).toBe(raw.watched_on);
    expect(back.year).toBe(raw.year);
    expect(back.user_rating).toBe(
      Object.entries(patch).some(([key, value]) => key === 'user_rating' && value === '4.0')
        ? 4
        : raw.user_rating,
    );
  });
});
