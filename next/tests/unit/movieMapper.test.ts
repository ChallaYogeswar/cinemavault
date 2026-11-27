import { describe, expect, it } from 'vitest';
import { movieToRow, rowToMovie } from '@/data/mappers/movieMapper';

const row = {
  id: '3f2b1c8e-5d0a-4b3e-9c1d-2a7f6e5d4c3b',
  owner_id: 'caa6cc74-8df4-4408-b031-b17e76208e78',
  title: '(500) Days of Summer',
  normalized_title: '(500) days of summer',
  media_type: 'movie',
  year: 2009,
  genre: 'Romance, Drama',
  runtime_minutes: 95,
  watched: true,
  watched_on: '2026-01-02',
  user_rating: 4,
  verdict: 'Great',
  technical_notes: null,
  shot_link: null,
  created_at: '2026-01-01T10:00:00.123456+00:00',
  updated_at: '2026-01-02T10:00:00+00:00',
  deleted_at: null,
};

describe('movie row mapper', () => {
  it('maps a PostgREST row to the domain model', () => {
    const movie = rowToMovie(row);
    expect(movie).toMatchObject({
      id: row.id,
      ownerId: row.owner_id,
      title: row.title,
      normalizedTitle: row.normalized_title,
      mediaType: 'movie',
      year: 2009,
      userRating: 4,
      watched: true,
      watchedOn: '2026-01-02',
      deletedAt: null,
    });
    expect(movie.createdAt).toBe('2026-01-01T10:00:00.123456+00:00');
    expect(movie.updatedAt).toBe('2026-01-02T10:00:00+00:00');
  });

  it('round-trips without changing data (R2)', () => {
    const movie = rowToMovie(row);
    const back = movieToRow(movie);
    expect(rowToMovie(back)).toEqual(movie);
    expect(back.id).toBe(row.id);
    expect(back.owner_id).toBe(row.owner_id);
    expect(back.normalized_title).toBe(row.normalized_title);
  });

  it('accepts numeric ratings sent as strings (numeric(3,1))', () => {
    expect(rowToMovie({ ...row, user_rating: '3.5' }).userRating).toBe(3.5);
  });

  it('preserves soft-deleted tombstones', () => {
    const m = rowToMovie({ ...row, deleted_at: '2026-02-01T00:00:00Z' });
    expect(m.deletedAt).toBe('2026-02-01T00:00:00Z');
    expect(movieToRow(m).deleted_at).toBe('2026-02-01T00:00:00Z');
  });

  it('rejects corrupt rows instead of coercing them', () => {
    expect(() => rowToMovie({ ...row, id: 'nope' })).toThrow();
    expect(() => rowToMovie({ ...row, media_type: 'book' })).toThrow();
    expect(() => rowToMovie({ ...row, user_rating: 9 })).toThrow();
    expect(() => rowToMovie({ ...row, user_rating: 4.55 })).toThrow();
    expect(() => rowToMovie({ ...row, watched_on: '2026-02-31' })).toThrow();
    expect(() => rowToMovie({ ...row, created_at: 'garbage' })).toThrow();
    expect(() => rowToMovie({ ...row, title: undefined })).toThrow();
  });

  describe('timestamps are opaque version tokens', () => {
    it('keeps microseconds so two versions less than a millisecond apart stay distinct', () => {
      const a = rowToMovie({ ...row, updated_at: '2026-10-26T10:00:00.123456+00:00' });
      const b = rowToMovie({ ...row, updated_at: '2026-10-26T10:00:00.123789+00:00' });
      expect(a.updatedAt).not.toBe(b.updatedAt);
      expect(a.updatedAt).toBe('2026-10-26T10:00:00.123456+00:00');
    });

    it('writes back exactly what it read (the value used in the guarded WHERE clause)', () => {
      for (const stamp of [
        '2026-10-26T10:00:00.123456+00:00',
        '2026-10-26T10:00:00.5+00:00',
        '2026-10-26T10:00:00+00:00',
        '2026-10-26T15:30:00.000001+05:30',
      ]) {
        const movie = rowToMovie({ ...row, updated_at: stamp });
        expect(movie.updatedAt).toBe(stamp);
        expect(movieToRow(movie).updated_at).toBe(stamp);
      }
    });

    it('still rejects something that is not a timestamp', () => {
      expect(() => rowToMovie({ ...row, updated_at: 'yesterday' })).toThrow();
    });
  });
});
