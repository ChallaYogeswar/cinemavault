import { describe, expect, it } from 'vitest';
import { createSeedMovies } from '@/data/mock/fixtures';
import { EMPTY_MOVIE_INPUT } from '@/domain/movieInput';
import {
  IMPORT_MAX_ROWS,
  buildCsvExport,
  buildJsonExport,
  parseCsv,
  parseImportFile,
  planImport,
  type ParsedRow,
} from '@/domain/transfer';
import type { MovieInputValues } from '@/domain/validation';
import { at, first } from '../helpers';

const NOW = new Date('2026-11-13T10:00:00.000Z');
const movie = (patch: Partial<MovieInputValues> = {}): MovieInputValues => ({
  ...EMPTY_MOVIE_INPUT,
  title: 'Heat',
  year: 1995,
  ...patch,
});

async function parsed(source: string) {
  const out = await parseImportFile(source);
  if (!out.ok) throw new Error(`parse failed: ${out.message}`);
  return out;
}

describe('JSON backup', () => {
  it('round-trips the whole seeded library exactly and verifies its checksum', async () => {
    const library = createSeedMovies();
    const file = await buildJsonExport(library, NOW);
    const back = await parsed(file);
    expect(back.kind).toBe('json');
    expect(back.checksum).toBe('verified');
    expect(back.rows.every((row) => row.problems.length === 0)).toBe(true);
    const restored = back.rows.flatMap((row) => (row.input ? [row.input] : []));
    expect(restored).toHaveLength(library.length);
    const key = (m: MovieInputValues) => `${m.title}|${m.mediaType}|${String(m.year)}`;
    expect(new Set(restored.map(key))).toEqual(new Set(library.map(key)));
    for (const original of library) {
      const copy = restored.find((r) => key(r) === key(original));
      expect(copy).toMatchObject({
        genre: original.genre,
        runtimeMinutes: original.runtimeMinutes,
        watched: original.watched,
        watchedOn: original.watchedOn,
        userRating: original.userRating,
        verdict: original.verdict,
      });
    }
  });

  it('holds only what the person typed: no ids, owner or timestamps', async () => {
    const file = JSON.parse(await buildJsonExport(createSeedMovies(), NOW)) as {
      movies: Record<string, unknown>[];
      count: number;
      exportedAt: string;
    };
    expect(file.exportedAt).toBe(NOW.toISOString());
    expect(file.count).toBe(file.movies.length);
    for (const row of file.movies) {
      for (const secret of [
        'id',
        'ownerId',
        'createdAt',
        'updatedAt',
        'deletedAt',
        'normalizedTitle',
      ]) {
        expect(row).not.toHaveProperty(secret);
      }
    }
  });

  it('is identical whatever order the library is in', async () => {
    const library = createSeedMovies();
    const a = await buildJsonExport(library, NOW);
    const b = await buildJsonExport([...library].reverse(), NOW);
    expect(b).toBe(a);
  });

  it('notices a file changed after it was exported (checksum mismatch) but still reads it', async () => {
    const file = JSON.parse(await buildJsonExport([movie()], NOW)) as {
      movies: { title: string }[];
    };
    at(file.movies, 0).title = 'Heat 2';
    const out = await parsed(JSON.stringify(file));
    expect(out.checksum).toBe('mismatch');
    expect(at(out.rows, 0).input?.title).toBe('Heat 2');
  });

  it('accepts a plain array of objects, with no checksum to verify', async () => {
    const out = await parsed(JSON.stringify([{ title: 'Alien', year: 1979 }]));
    expect(out.checksum).toBe('absent');
    expect(at(out.rows, 0).input).toMatchObject({ title: 'Alien', year: 1979, mediaType: 'movie' });
  });

  it('refuses a foreign JSON file and a backup from a newer version, with a clear reason', async () => {
    expect(await parseImportFile(JSON.stringify({ format: 'other', movies: [] }))).toMatchObject({
      ok: false,
      message: expect.stringContaining('not a CinemaVault export') as unknown,
    });
    expect(
      await parseImportFile(
        JSON.stringify({ format: 'cinemavault-export', version: 99, movies: [] }),
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining('newer version') as unknown });
    expect(await parseImportFile('{"movies": 5}')).toMatchObject({ ok: false });
    expect(await parseImportFile('{not json')).toMatchObject({ ok: false });
  });

  it('does not apply the CSV apostrophe rule to JSON titles', async () => {
    const out = await parsed(JSON.stringify([{ title: "'=weird", year: 2000 }]));
    expect(at(out.rows, 0).input?.title).toBe("'=weird");
  });
});

describe('CSV', () => {
  it('writes a header, a byte-order mark and CRLF lines, quoting commas, quotes and line breaks', () => {
    const csv = buildCsvExport([
      movie({ title: 'Se7en, "Seven"', year: 1995, verdict: 'Line one\nline two' }),
    ]);
    expect(
      csv.startsWith(
        '﻿title,mediaType,year,genre,runtimeMinutes,watched,watchedOn,userRating,verdict,technicalNotes,shotLink\r\n',
      ),
    ).toBe(true);
    expect(csv).toContain('"Se7en, ""Seven"""');
    expect(csv).toContain('"Line one\nline two"');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('defuses spreadsheet formulas, and the import removes the apostrophe again', async () => {
    const nasty = ['=HYPERLINK("http://evil","x")', '+1+1', '-2+3', '@SUM(A1)'];
    const csv = buildCsvExport(nasty.map((title, i) => movie({ title, year: 2000 + i })));
    for (const title of nasty) {
      const cell = title.includes('"') ? `"'${title.replace(/"/g, '""')}"` : `'${title}`;
      expect(csv).toContain(cell);
    }
    const out = await parsed(csv);
    expect(out.rows.map((r) => r.input?.title).sort()).toEqual([...nasty].sort());
  });

  it('round-trips every field, including accents, commas and line breaks', async () => {
    const original = [
      movie({
        title: 'Léon: The Professional',
        year: 1994,
        genre: 'Crime, Drama',
        runtimeMinutes: 110,
        watched: true,
        watchedOn: '2026-10-26',
        userRating: 4.5,
        verdict: 'Natalie, "wow"\nsecond line',
        technicalNotes: 'Blu-ray',
        shotLink: 'https://example.com/a?b=1',
      }),
      movie({ title: 'Severance', mediaType: 'tv', year: 2022 }),
    ];
    const out = await parsed(buildCsvExport(original));
    expect(out.kind).toBe('csv');
    const rows = out.rows.map((r) => r.input);
    for (const o of original) expect(rows).toContainEqual(o);
  });

  it('reads Excel-style files: semicolons, a BOM, header aliases, yes/no and decimal commas', async () => {
    const src =
      '﻿Name;Type;Release Year;Seen;Date Watched;My Rating;Notes\r\n' +
      'Dune;Film;2021;Yes;2026-01-02;4,5;IMAX\r\n' +
      'Dark;TV Series;2017;no;;;\r\n';
    const out = await parsed(src);
    expect(out.ignoredColumns).toEqual([]);
    expect(at(out.rows, 0).input).toMatchObject({
      title: 'Dune',
      mediaType: 'movie',
      year: 2021,
      watched: true,
      watchedOn: '2026-01-02',
      userRating: 4.5,
      technicalNotes: 'IMAX',
    });
    expect(at(out.rows, 1).input).toMatchObject({
      mediaType: 'tv',
      watched: false,
      userRating: null,
    });
  });

  it('a watched date alone means watched; an unknown column is reported, not guessed at', async () => {
    const out = await parsed('title,watched on,colour\nHeat,2026-02-03,red\n');
    expect(at(out.rows, 0).input).toMatchObject({ watched: true, watchedOn: '2026-02-03' });
    expect(out.ignoredColumns).toEqual(['colour']);
  });

  it('explains a file with no title column, naming what it did find', async () => {
    const out = await parseImportFile('foo,bar\n1,2\n');
    expect(out).toMatchObject({ ok: false });
    expect(out.ok ? '' : out.message).toContain('“foo”');
  });

  it('reports each bad row with its line number and a reason, and still reads the good ones', async () => {
    const out = await parsed(
      [
        'title,year,rating,watched,type,link',
        'Good,2000,4,yes,movie,',
        ',2000,4,yes,movie,', // no title
        'Future,3000,4,yes,movie,', // year out of range
        'Bad Rating,2000,9,yes,movie,',
        'Half,2000,4.55,yes,movie,',
        'Maybe,2000,4,perhaps,movie,',
        'Odd Type,2000,4,yes,opera,',
        'Script,2000,4,yes,movie,javascript:alert(1)',
        'Fine,,,,,',
      ].join('\n'),
    );
    const bad = out.rows.filter((r) => r.input === null);
    expect(bad.map((r) => r.line)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    for (const row of bad) expect(row.problems.length).toBeGreaterThan(0);
    expect(
      out.rows.filter((r) => r.input !== null).map((r) => at(out.rows, r.line - 2).input?.title),
    ).toEqual(['Good', 'Fine']);
  });

  it('skips blank lines and survives a missing final newline', async () => {
    const out = await parsed('title\nA\n\n\nB');
    expect(out.rows.map((r) => r.input?.title)).toEqual(['A', 'B']);
  });

  it('refuses an unterminated quote instead of swallowing the rest of the file', async () => {
    expect(await parseImportFile('title\n"never closed\nA\n')).toMatchObject({ ok: false });
  });

  it('parseCsv follows RFC 4180 for quotes and line breaks', () => {
    expect(parseCsv('a,"b ""c"" d","e\nf"\r\n1,2,3', ',')).toEqual([
      ['a', 'b "c" d', 'e\nf'],
      ['1', '2', '3'],
    ]);
  });
});

describe('limits and hostile input', () => {
  it('refuses a file over 5 MB and one with more than the row limit', async () => {
    expect(await parseImportFile('x'.repeat(5 * 1024 * 1024 + 1))).toMatchObject({ ok: false });
    const many = [
      'title',
      ...Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `T${String(i)}`),
    ];
    expect(await parseImportFile(many.join('\n'))).toMatchObject({ ok: false });
  });

  it('applies the row limit to JSON files too', async () => {
    const list = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => ({
      title: `T${String(i)}`,
    }));
    expect(await parseImportFile(JSON.stringify(list))).toMatchObject({ ok: false });
  });

  it('never throws, whatever it is given', async () => {
    const junk = [
      '',
      ' ',
      '\u0000\u0001',
      '[[[[',
      '{"movies":[null,1,"x",[]]}',
      'a,b\n"',
      '﻿',
      '<html>',
      '[]',
      '{}',
    ];
    for (const source of junk) {
      await expect(parseImportFile(source)).resolves.toBeDefined();
    }
  });

  it('stores HTML-looking text as plain text and rejects script links', async () => {
    const out = await parsed(
      JSON.stringify([{ title: '<img src=x onerror=alert(1)>', shotLink: 'javascript:alert(1)' }]),
    );
    expect(at(out.rows, 0).input).toBeNull(); // the link makes the row invalid
    const ok = await parsed(JSON.stringify([{ title: '<img src=x onerror=alert(1)>' }]));
    expect(at(ok.rows, 0).input?.title).toBe('<img src=x onerror=alert(1)>'); // kept verbatim; React escapes it
  });
});

describe('planImport', () => {
  const rows = (...inputs: (MovieInputValues | null)[]): ParsedRow[] =>
    inputs.map((input, i) => ({ line: i + 2, input, problems: input ? [] : ['bad'] }));
  const library = createSeedMovies();

  it('classifies new, existing, repeated and invalid rows, and lists only the new ones to create', () => {
    const seeded = first(library);
    const plan = planImport(
      rows(
        movie({ title: 'Brand New', year: 2020 }),
        {
          ...EMPTY_MOVIE_INPUT,
          title: seeded.title,
          mediaType: seeded.mediaType,
          year: seeded.year,
        },
        movie({ title: 'Brand New', year: 2020 }),
        null,
        movie({ title: 'Brand New', year: 2021 }),
      ),
      library,
    );
    expect(plan.rows.map((r) => r.status)).toEqual(['new', 'exists', 'repeated', 'invalid', 'new']);
    expect(plan.counts).toEqual({ new: 2, exists: 1, repeated: 1, invalid: 1, total: 5 });
    expect(plan.toCreate.map((m) => `${m.title}${String(m.year)}`)).toEqual([
      'Brand New2020',
      'Brand New2021',
    ]);
    expect(plan.rows[1]?.matches).toBe(seeded.title);
  });

  it('uses the same rule as the repositories: case, punctuation and (Series) suffix do not matter', () => {
    const base = {
      ...EMPTY_MOVIE_INPUT,
      title: 'Breaking Bad',
      mediaType: 'tv' as const,
      year: 2008,
    };
    const plan = planImport(
      rows(
        base,
        { ...base, title: 'BREAKING   BAD (series)' },
        { ...base, title: 'Breaking Bad!' },
      ),
      library,
    );
    expect(plan.counts.exists).toBe(3);
  });

  it('treats the same title in another year or type as new, and ignores deleted library titles', () => {
    const seeded = first(library);
    const gone = [{ ...seeded, deletedAt: '2026-01-01T00:00:00.000Z' }];
    const plan = planImport(
      rows({
        ...EMPTY_MOVIE_INPUT,
        title: seeded.title,
        mediaType: seeded.mediaType,
        year: seeded.year,
      }),
      gone,
    );
    expect(plan.counts.new).toBe(1);
    const other = planImport(
      rows({
        ...EMPTY_MOVIE_INPUT,
        title: seeded.title,
        mediaType: seeded.mediaType === 'tv' ? 'movie' : 'tv',
        year: seeded.year,
      }),
      library,
    );
    expect(other.counts.new).toBe(1);
  });

  it('is deterministic and does not mutate its inputs', () => {
    const input = rows(movie({ title: 'Same' }), movie({ title: 'same' }));
    const frozen = JSON.stringify(input);
    const a = planImport(input, library);
    const b = planImport(input, library);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(input)).toBe(frozen);
  });
});
