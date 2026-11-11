import { describe, expect, it } from 'vitest';
import { belongsToAnotherUser, moviesKey, privateKey } from '@/app/privateKey';

describe('private query keys', () => {
  it('differ per account', () => {
    expect(moviesKey('alice')).not.toEqual(moviesKey('bob'));
    expect(moviesKey('alice')).toEqual(['u', 'alice', 'movies']);
  });
  it('flag only other accounts’ private data', () => {
    expect(belongsToAnotherUser(moviesKey('bob'), 'alice')).toBe(true);
    expect(belongsToAnotherUser(moviesKey('alice'), 'alice')).toBe(false);
    expect(belongsToAnotherUser(['public', 'x'], 'alice')).toBe(false);
    expect(belongsToAnotherUser([], 'alice')).toBe(false);
  });
  it('supports further parts under the same owner', () => {
    expect(privateKey('alice', 'movies', 'abc')).toEqual(['u', 'alice', 'movies', 'abc']);
  });
});
