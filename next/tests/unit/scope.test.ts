import { describe, expect, it } from 'vitest';
import { cacheDatabaseName } from '@/data/local/scope';

describe('cache scoping (R7)', () => {
  const a = 'caa6cc74-8df4-4408-b031-b17e76208e78';
  const b = '11111111-1111-4111-8111-111111111111';

  it('derives a distinct database per user', () => {
    expect(cacheDatabaseName(a)).not.toBe(cacheDatabaseName(b));
    expect(cacheDatabaseName(a)).toBe(`cinemavault-next:${a}`);
  });
  it('fails closed on anything that is not a user id', () => {
    for (const bad of ['', 'anonymous', 'undefined', '../x', 'null']) {
      expect(() => cacheDatabaseName(bad)).toThrow();
    }
  });
});
