import { describe, expect, it } from 'vitest';
import { movieToRow } from '@/data/mappers/movieMapper';
import { MOCK_OWNER_ID, generateMovies } from '@/data/mock/fixtures';
import { comparableTitle as appComparable, normalizeTitle } from '@/domain/identity';
import {
  compareWithExpectation,
  comparableTitle,
  digestRows,
  gateRows,
  type Row,
} from '../../scripts/rehearsal-lib.mjs';
import { first } from '../helpers';

const clean = (): Row[] =>
  generateMovies(60, MOCK_OWNER_ID).map((m) => movieToRow(m) as unknown as Row);
const failing = (rows: Row[]) =>
  gateRows(rows)
    .checks.filter((c) => !c.pass)
    .map((c) => c.name);

describe('data gate', () => {
  it('passes a clean library and counts live and deleted rows', () => {
    const rows = clean();
    const g = gateRows(rows);
    expect(g.pass).toBe(true);
    expect(g.rows).toBe(60);
    expect(g.live + g.tombstones).toBe(60);
  });

  it('the comparison title matches the application’s exactly, so the gate and the app agree on "duplicate"', () => {
    for (const title of [
      "The Pope's Exorcist",
      'Léon: The Professional',
      'Mr. & Mrs. Mahi',
      'Amélie',
      'WALL·E',
      '  spaced   out  ',
      'Delhi-6',
      '世界',
    ]) {
      const stored = normalizeTitle(title);
      expect(comparableTitle(stored)).toBe(appComparable(stored));
    }
  });

  const cases: [string, (r: Row) => Row, RegExp][] = [
    ['rating above 5', (r) => ({ ...r, user_rating: 5.5 }), /rating/],
    ['negative rating', (r) => ({ ...r, user_rating: -1 }), /rating/],
    [
      'unwatched with a date',
      (r) => ({ ...r, watched: false, watched_on: '2026-01-01' }),
      /watched date/,
    ],
    ['blank title', (r) => ({ ...r, title: '   ' }), /titles are present/],
    ['title with a control character', (r) => ({ ...r, title: 'A\u0007B' }), /titles are present/],
    ['title over 200', (r) => ({ ...r, title: 'x'.repeat(201) }), /titles are present/],
    ['unknown media type', (r) => ({ ...r, media_type: 'book' }), /media type/],
    ['year out of range', (r) => ({ ...r, year: 1800 }), /year/],
    ['fractional runtime', (r) => ({ ...r, runtime_minutes: 90.5 }), /runtime/],
    ['no owner', (r) => ({ ...r, owner_id: '' }), /owner/],
    [
      'updated before created',
      (r) => ({ ...r, updated_at: '2000-01-01T00:00:00+00:00' }),
      /updated before/,
    ],
    ['unparseable timestamp', (r) => ({ ...r, created_at: 'yesterday' }), /timestamps/],
    [
      'deleted before created',
      (r) => ({ ...r, deleted_at: '2000-01-01T00:00:00+00:00' }),
      /deleted after/,
    ],
    [
      'untrimmed normalized title',
      (r) => ({ ...r, normalized_title: ' Upper ' }),
      /normalized title is trimmed/,
    ],
    ['notes over 5000', (r) => ({ ...r, technical_notes: 'n'.repeat(5001) }), /notes/],
  ];
  it.each(cases)('fails on %s', (_name, mutate, expected) => {
    const rows = clean();
    rows[3] = mutate(first(rows.slice(3)));
    const names = failing(rows);
    expect(names.length).toBeGreaterThan(0);
    expect(names.some((n) => expected.test(n))).toBe(true);
  });

  it('fails on a repeated id and on a duplicate live title, including a punctuation-folded and a year-less duplicate', () => {
    const rows = clean();
    expect(failing([...rows, first(rows)])).toContain('every id appears once');

    const a = {
      ...first(rows),
      id: '00000000-0000-4000-8000-0000000000a1',
      title: "The Pope's Exorcist",
      normalized_title: "the pope's exorcist",
      year: 2023,
      media_type: 'movie',
      deleted_at: null,
    };
    const b = {
      ...a,
      id: '00000000-0000-4000-8000-0000000000a2',
      normalized_title: 'the pope s exorcist',
    }; // F9 spelling
    expect(failing([...rows, a, b]).join()).toMatch(/duplicate live titles/);

    const c = { ...a, id: '00000000-0000-4000-8000-0000000000a3', year: null };
    const d = { ...c, id: '00000000-0000-4000-8000-0000000000a4' };
    expect(failing([...rows, c, d]).join()).toMatch(/duplicate live titles/); // F2: the database would allow it
  });

  it('a deleted row never counts as a duplicate of a live one', () => {
    const rows = clean();
    const live = first(rows);
    const ghost = {
      ...live,
      id: '00000000-0000-4000-8000-0000000000b1',
      deleted_at: '2099-01-01T00:00:00+00:00',
      updated_at: '2099-01-01T00:00:00+00:00',
    };
    expect(gateRows([...rows, ghost]).pass).toBe(true);
  });

  it('known conditions are reported but never fail the gate', () => {
    const rows = clean();
    rows[1] = { ...first(rows.slice(1)), shot_link: 'ftp://nope' };
    rows[2] = {
      ...first(rows.slice(2)),
      title: 'Psycho . 1960 ‧ Horror/Mystery',
      normalized_title: 'psycho . 1960 ‧ horror/mystery',
    };
    rows[4] = {
      ...first(rows.slice(4)),
      normalized_title: 'folded title',
      title: 'Folded: Title!',
    };
    const g = gateRows(rows);
    expect(g.pass).toBe(true);
    const note = (prefix: string) => g.checks.find((c) => c.name.startsWith(prefix));
    expect(note('F7')?.count).toBe(1);
    expect(note('F10')?.count).toBeGreaterThanOrEqual(1);
    expect(note('F9')?.count).toBeGreaterThanOrEqual(1);
  });

  it('proves "nothing changed" against a digest and a count, and names what differs', () => {
    const rows = clean();
    const digest = digestRows(rows);
    expect(compareWithExpectation(rows, { digest, count: 60 })).toEqual({
      pass: true,
      problems: [],
    });
    expect(compareWithExpectation(rows.slice(1), { digest, count: 60 }).problems).toHaveLength(2);
    const edited = rows.map((r, i) => (i === 0 ? { ...r, genre: 'changed' } : r));
    expect(compareWithExpectation(edited, { digest }).problems[0]).toMatch(/digest/);
    expect(compareWithExpectation(rows).pass).toBe(true); // no expectation given: nothing to compare
  });
});
