import { describe, expect, it } from 'vitest';
import { DISPLAY_NAME_MAX, parseDisplayName } from '@/domain/profile';

describe('parseDisplayName', () => {
  it('trims and collapses spaces', () => {
    expect(parseDisplayName('  Yogeswar   Challa ')).toEqual({
      ok: true,
      value: 'Yogeswar Challa',
    });
  });

  it('treats an empty or blank name as "no name"', () => {
    expect(parseDisplayName('')).toEqual({ ok: true, value: null });
    expect(parseDisplayName('   \t ')).toEqual({ ok: true, value: null });
  });

  it('accepts exactly the limit and refuses one more, counting what a person sees as one character', () => {
    expect(parseDisplayName('a'.repeat(DISPLAY_NAME_MAX)).ok).toBe(true);
    expect(parseDisplayName('a'.repeat(DISPLAY_NAME_MAX + 1)).ok).toBe(false);
    const family = '👨‍👩‍👧'; // several code points, one visible character
    expect(parseDisplayName(family.repeat(DISPLAY_NAME_MAX)).ok).toBe(true);
    expect(parseDisplayName(family.repeat(DISPLAY_NAME_MAX + 1)).ok).toBe(false);
  });

  it.each([
    ['a control character', 'ab\u0000c'],
    ['a line break', 'ab\ncd'],
    ['a tab', 'ab\tcd'],
    ['a zero-width space', 'ab​cd'],
    ['a right-to-left override', 'ab‮cd'],
    ['a bidi isolate', 'ab⁦cd'],
    ['a byte-order mark inside the name', 'ab\ufeffcd'],
    ['a DEL character', 'ab\u007fcd'],
  ])('refuses %s instead of quietly editing it', (_label, input) => {
    expect(parseDisplayName(input).ok).toBe(false);
  });

  it('keeps the joiners real names and emoji need', () => {
    expect(parseDisplayName('a\u200cb').ok).toBe(true);
    expect(parseDisplayName('a\u200db').ok).toBe(true);
  });

  it('keeps ordinary punctuation and non-Latin names', () => {
    expect(parseDisplayName('Zoë O’Brien-Smith')).toEqual({ ok: true, value: 'Zoë O’Brien-Smith' });
    expect(parseDisplayName('యోగేశ్వర్')).toEqual({ ok: true, value: 'యోగేశ్వర్' });
  });
});
