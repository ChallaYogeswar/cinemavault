import { describe, expect, it } from 'vitest';
import { can, resolveRole, type Action } from '@/domain/permissions';

describe('resolveRole — fails closed (R1)', () => {
  it('only an explicit owner profile is an owner', () => {
    expect(resolveRole({ role: 'owner' })).toBe('owner');
    expect(resolveRole({ id: 'x', role: 'owner', display_name: 'Y' })).toBe('owner');
  });

  it.each([
    ['null (profile query failed)', null],
    ['undefined (profile not loaded)', undefined],
    ['empty object', {}],
    ['viewer', { role: 'viewer' }],
    ['unknown role', { role: 'admin' }],
    ['wrong casing', { role: 'OWNER' }],
    ['padded', { role: ' owner ' }],
    ['role as non-string', { role: true }],
    ['a string instead of an object', 'owner'],
    ['an array', ['owner']],
    ['nested role', { profile: { role: 'owner' } }],
    ['a number', 1],
  ])('%s -> viewer', (_label, value) => {
    expect(resolveRole(value)).toBe('viewer');
  });
});

describe('can()', () => {
  const writes: Action[] = ['movie:create', 'movie:update', 'movie:delete', 'metadata:write'];
  const ownerOnly: Action[] = [...writes, 'users:manage'];

  it('owner can do everything', () => {
    for (const a of [...ownerOnly, 'movie:read', 'account:manage-own'] as Action[]) {
      expect(can('owner', a)).toBe(true);
    }
  });
  it('viewer can read and manage their OWN account, but never write', () => {
    expect(can('viewer', 'movie:read')).toBe(true);
    expect(can('viewer', 'account:manage-own')).toBe(true);
    for (const a of writes) expect(can('viewer', a)).toBe(false);
  });
  it('administering other users or roles is owner-only, never granted to a viewer', () => {
    expect(can('viewer', 'users:manage')).toBe(false);
    expect(can('owner', 'users:manage')).toBe(true);
    expect(can(resolveRole(null), 'users:manage')).toBe(false);
  });
  it('an unresolved profile cannot write', () => {
    for (const a of ownerOnly) expect(can(resolveRole(null), a)).toBe(false);
  });
});
