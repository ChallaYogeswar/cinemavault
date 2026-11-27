import { describe, expect, it } from 'vitest';
import { readStoredIdentity } from '@/services/auth/storedIdentity';

const ID = '00000000-0000-4000-8000-0000000000a1';
const at = (value: unknown) => ({
  getItem: () =>
    value === null ? null : typeof value === 'string' ? value : JSON.stringify(value),
});

describe('readStoredIdentity', () => {
  it('reads who the stored session belongs to', () => {
    const session = {
      user: { id: ID, email: 'a@example.com' },
      refresh_token: 'r',
      access_token: 'x',
    };
    expect(readStoredIdentity('k', at(session))).toEqual({ id: ID, email: 'a@example.com' });
  });

  it('a user without an email is still a user', () => {
    expect(readStoredIdentity('k', at({ user: { id: ID }, refresh_token: 'r' }))).toEqual({
      id: ID,
      email: null,
    });
  });

  it.each([
    ['nothing stored', null],
    ['not JSON', 'oops{'],
    ['no refresh token (nothing could ever refresh it)', { user: { id: ID } }],
    ['an empty refresh token', { user: { id: ID }, refresh_token: '' }],
    ['a user id that is not a UUID', { user: { id: 'nope' }, refresh_token: 'r' }],
    ['no user', { refresh_token: 'r' }],
    ['an array', []],
  ])('%s is nobody', (_name, value) => {
    expect(readStoredIdentity('k', at(value))).toBeNull();
  });

  it('storage that throws is nobody, not a crash', () => {
    expect(
      readStoredIdentity('k', {
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBeNull();
  });

  it('reads the key it was given', () => {
    const seen: string[] = [];
    readStoredIdentity('cinemavault-next-auth', {
      getItem: (key) => {
        seen.push(key);
        return null;
      },
    });
    expect(seen).toEqual(['cinemavault-next-auth']);
  });
});
