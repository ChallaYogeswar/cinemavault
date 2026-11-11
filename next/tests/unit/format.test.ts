import { describe, expect, it } from 'vitest';
import {
  formatRating,
  formatRuntime,
  formatWatchedOn,
  posterBackground,
  posterInitials,
  ratingWord,
  safeHttpUrl,
} from '@/features/library/format';

describe('formatRating', () => {
  it.each([
    [4, '4'],
    [4.5, '4.5'],
    [0, '0'],
    [3.0, '3'],
  ])('%s -> %s', (value, expected) => {
    expect(formatRating(value)).toBe(expected);
  });
});

describe('ratingWord', () => {
  it('names whole values and says "Not rated" for null', () => {
    expect(ratingWord(null)).toBe('Not rated');
    expect(ratingWord(5)).toBe('Masterpiece');
    expect(ratingWord(1)).toBe('Skip it');
  });
});

describe('formatRuntime', () => {
  it.each([
    [45, '45 min'],
    [60, '1 h'],
    [132, '2 h 12 min'],
  ])('%s -> %s', (minutes, expected) => {
    expect(formatRuntime(minutes)).toBe(expected);
  });
});

describe('formatWatchedOn', () => {
  it('formats a calendar date without timezone drift', () => {
    expect(formatWatchedOn('2026-10-20')).toBe('20 Oct 2026');
    expect(formatWatchedOn('2026-01-01')).toBe('1 Jan 2026');
  });
  it('returns the raw text for something unparseable instead of "Invalid Date"', () => {
    expect(formatWatchedOn('garbage')).toBe('garbage');
  });
});

describe('posterInitials and posterBackground', () => {
  it('takes up to two initials and skips leading symbols', () => {
    expect(posterInitials('#Manhole')).toBe('M');
    expect(posterInitials('The Dark Knight')).toBe('TD');
    expect(posterInitials('Amélie')).toBe('A');
    expect(posterInitials('???')).toBe('');
  });
  it('is deterministic per title and ignores case', () => {
    expect(posterBackground('Parasite')).toBe(posterBackground('PARASITE'));
    expect(posterBackground('Parasite')).not.toBe(posterBackground('Oldboy'));
  });
});

describe('safeHttpUrl', () => {
  it('passes http(s) and nothing else', () => {
    expect(safeHttpUrl('https://example.com/x')).toBe('https://example.com/x');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,hi')).toBeNull();
    expect(safeHttpUrl('not a url')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});
