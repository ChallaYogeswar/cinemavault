import { describe, expect, it } from 'vitest';
import { comparableTitle, identityKey, isSameIdentity, normalizeTitle } from '@/domain/identity';

/**
 * Parity vectors: these are the exact outputs of the existing app's normalizeTitle
 * (src/storage/movieRepository.js). If one of these changes, existing rows would get a new identity.
 */
describe('normalizeTitle — parity with the existing app', () => {
  const vectors: [string, string][] = [
    ['#Manhole', '#manhole'],
    ['Manhole', 'manhole'],
    ['  The   Office  ', 'the office'],
    ['The Office (Series)', 'the office'],
    ['Dark (TV)', 'dark'],
    ['Dark (Show)', 'dark'],
    ['Dark (SERIES)', 'dark'],
    ['Breaking Bad Season 3', 'breaking bad'],
    ['Breaking Bad season 12', 'breaking bad'],
    ['(500) Days of Summer', '(500) days of summer'],
    ['12 Angry Men', '12 angry men'],
    ['Se7en', 'se7en'],
    ['Amélie', 'amélie'],
    ['Season 2 Episode', 'season 2 episode'],
    ['Show Season 2 Finale', 'show season 2 finale'],
  ];
  it.each(vectors)('%j -> %j', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });

  it('handles null/undefined/empty like the old app', () => {
    expect(normalizeTitle(null)).toBe('');
    expect(normalizeTitle(undefined)).toBe('');
    expect(normalizeTitle('   ')).toBe('');
  });

  it('is idempotent', () => {
    for (const [input] of vectors) {
      const once = normalizeTitle(input);
      expect(normalizeTitle(once)).toBe(once);
    }
  });
});

describe('duplicate identity rule', () => {
  const base = { normalizedTitle: 'dark', mediaType: 'tv', year: 2017 } as const;

  it('same title+type+year is a duplicate', () => {
    expect(isSameIdentity(base, { ...base })).toBe(true);
  });
  it('movie vs series are different identities', () => {
    expect(isSameIdentity(base, { ...base, mediaType: 'movie' })).toBe(false);
  });
  it('different year is a different identity (remakes)', () => {
    expect(isSameIdentity(base, { ...base, year: 2018 })).toBe(false);
  });
  it('a missing year equals another missing year (app-level rule; the DB index does not enforce this)', () => {
    expect(isSameIdentity({ ...base, year: null }, { ...base, year: null })).toBe(true);
    expect(isSameIdentity({ ...base, year: null }, base)).toBe(false);
  });
  it('identityKey is stable and distinguishes null from a year', () => {
    expect(identityKey({ ...base, year: null })).toBe('tv|dark|');
    expect(identityKey(base)).toBe('tv|dark|2017');
    expect(identityKey({ ...base, year: null })).not.toBe(identityKey(base));
  });
});

describe('comparableTitle: the two stored spellings meet in the middle', () => {
  it.each([
    ["the pope's exorcist", 'the pope s exorcist'],
    ['mr. & mrs. mahi', 'mr mrs mahi'],
    ['barfi!', 'barfi'],
    ['léon', 'leon'],
    ['amélie (le fabuleux destin d’amélie poulain)', 'amelie le fabuleux destin d amelie poulain'],
    ['Se7en', 'se7en'],
  ])('%s ≡ %s', (app, imported) => {
    expect(comparableTitle(app)).toBe(comparableTitle(imported));
  });

  it('still tells different titles apart', () => {
    expect(comparableTitle('alien')).not.toBe(comparableTitle('aliens'));
    expect(comparableTitle('se7en')).not.toBe(comparableTitle('se 7en'));
  });

  it('never returns an empty string for a real title', () => {
    expect(comparableTitle('300')).toBe('300');
  });
});
