import { describe, expect, it } from 'vitest';
import { createSeedMovies } from '@/data/mock/fixtures';
import { EMPTY_MOVIE_INPUT, FIELD_LABELS, changedFields, movieToInput } from '@/domain/movieInput';
import { first } from '../helpers';

describe('changedFields', () => {
  const base = movieToInput(first(createSeedMovies()));

  it('is empty for identical versions', () => {
    expect(changedFields(base, { ...base })).toEqual([]);
  });
  it('names only what differs, in a stable order', () => {
    expect(changedFields(base, { ...base, verdict: 'x', title: 'Other' })).toEqual([
      'title',
      'verdict',
    ]);
  });
  it('treats null and a value as different, and null and null as equal', () => {
    expect(changedFields({ ...base, userRating: null }, { ...base, userRating: 3 })).toEqual([
      'userRating',
    ]);
    expect(changedFields({ ...base, genre: null }, { ...base, genre: null })).toEqual([]);
  });
  it('has a human label for every editable field', () => {
    expect(Object.keys(FIELD_LABELS).sort()).toEqual(Object.keys(EMPTY_MOVIE_INPUT).sort());
  });
});

describe('movieToInput', () => {
  it('drops system-managed fields', () => {
    const input = movieToInput(first(createSeedMovies()));
    expect(input).not.toHaveProperty('id');
    expect(input).not.toHaveProperty('updatedAt');
    expect(input).not.toHaveProperty('deletedAt');
  });
});
