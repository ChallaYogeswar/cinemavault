import { comparableTitle, normalizeTitle } from './identity';
import { MEDIA_TYPES, type Movie } from './movie';
import { movieInputSchema, type MovieInputValues } from './validation';

/**
 * Export, import and backup of a library. Pure: no browser, storage or network access, so every
 * rule here is testable on its own and the same code backs the Settings screen.
 *
 * Principles:
 *  - A backup holds only what the user typed (the editable fields). Ids, owner and timestamps are
 *    system-managed and are NOT exported, so a file can be restored into any account.
 *  - Nothing is saved from a file until the person has seen a preview that says what will happen
 *    to every row. Duplicates (of the library AND within the file) and invalid rows are skipped,
 *    never merged or overwritten: importing can only ADD titles.
 *  - A spreadsheet opened from our CSV must not be able to run a formula, so any cell that starts
 *    like one is written with a leading apostrophe; the same apostrophe is removed on import.
 */

export const EXPORT_FORMAT = 'cinemavault-export';
export const EXPORT_VERSION = 1;
/** A personal library is a few thousand rows; anything near these limits is not a library file. */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 10_000;

/** Column order of the CSV and of the canonical JSON the checksum covers. */
export const EXPORT_FIELDS = [
  'title',
  'mediaType',
  'year',
  'genre',
  'runtimeMinutes',
  'watched',
  'watchedOn',
  'userRating',
  'verdict',
  'technicalNotes',
  'shotLink',
] as const satisfies readonly (keyof MovieInputValues)[];

export interface ExportFile {
  readonly format: typeof EXPORT_FORMAT;
  readonly version: typeof EXPORT_VERSION;
  readonly exportedAt: string;
  readonly count: number;
  /** SHA-256 over the canonical `movies` array: detects a damaged or hand-edited file. */
  readonly checksum: string;
  readonly movies: readonly MovieInputValues[];
}

const toExported = (movie: Movie | MovieInputValues): MovieInputValues => ({
  title: movie.title,
  mediaType: movie.mediaType,
  year: movie.year,
  genre: movie.genre,
  runtimeMinutes: movie.runtimeMinutes,
  watched: movie.watched,
  watchedOn: movie.watchedOn,
  userRating: movie.userRating,
  verdict: movie.verdict,
  technicalNotes: movie.technicalNotes,
  shotLink: movie.shotLink,
});

/** Same order every time, whatever order the library happened to be in. */
function sortedForExport(movies: readonly (Movie | MovieInputValues)[]): MovieInputValues[] {
  return movies
    .map(toExported)
    .sort(
      (a, b) =>
        a.title.localeCompare(b.title, 'en') ||
        (a.year ?? 0) - (b.year ?? 0) ||
        a.mediaType.localeCompare(b.mediaType),
    );
}

const canonical = (movies: readonly MovieInputValues[]): string =>
  JSON.stringify(movies.map((m) => EXPORT_FIELDS.map((field) => m[field])));

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function buildJsonExport(
  movies: readonly (Movie | MovieInputValues)[],
  now: Date,
): Promise<string> {
  const sorted = sortedForExport(movies);
  const file: ExportFile = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    count: sorted.length,
    checksum: await sha256Hex(canonical(sorted)),
    movies: sorted,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** Quotes a CSV cell, and defuses anything a spreadsheet would run as a formula. */
function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n;]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildCsvExport(movies: readonly (Movie | MovieInputValues)[]): string {
  const rows = sortedForExport(movies).map((m) =>
    EXPORT_FIELDS.map((field) => csvCell(m[field])).join(','),
  );
  // A byte-order mark makes Excel read the file as UTF-8 (accented titles survive).
  return `\uFEFF${[EXPORT_FIELDS.join(','), ...rows].join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

export interface ParsedRow {
  /** 1-based position in the file the person can look at: CSV line (header is 1) or JSON index. */
  readonly line: number;
  readonly input: MovieInputValues | null;
  readonly problems: readonly string[];
}

export type ParseOutcome =
  | {
      readonly ok: true;
      readonly kind: 'json' | 'csv';
      readonly rows: readonly ParsedRow[];
      /** JSON backups only: whether the checksum in the file still matches its content. */
      readonly checksum: 'verified' | 'mismatch' | 'absent';
      readonly ignoredColumns: readonly string[];
    }
  | { readonly ok: false; readonly message: string };

const fail = (message: string): ParseOutcome => ({ ok: false, message });

const FIELD_ALIASES: Record<keyof MovieInputValues, readonly string[]> = {
  title: ['title', 'name', 'movie', 'moviename', 'movietitle', 'film'],
  mediaType: ['mediatype', 'type', 'kind', 'category'],
  year: ['year', 'releaseyear', 'released'],
  genre: ['genre', 'genres'],
  runtimeMinutes: ['runtimeminutes', 'runtime', 'duration', 'minutes'],
  watched: ['watched', 'seen', 'status'],
  watchedOn: ['watchedon', 'datewatched', 'watcheddate', 'dateseen'],
  userRating: ['userrating', 'rating', 'myrating', 'score'],
  verdict: ['verdict', 'review', 'comment', 'comments'],
  technicalNotes: ['technicalnotes', 'notes', 'technical'],
  shotLink: ['shotlink', 'link', 'screenshot', 'screenshotlink', 'url'],
};

const headerKey = (raw: string): string =>
  raw
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

function fieldForHeader(raw: string): keyof MovieInputValues | null {
  const key = headerKey(raw);
  for (const field of EXPORT_FIELDS) {
    if (FIELD_ALIASES[field].includes(key)) return field;
  }
  return null;
}

/** RFC 4180 CSV: quoted cells, doubled quotes, line breaks inside quotes, CRLF or LF. */
export function parseCsv(source: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let touched = false; // something was read on this line, so an empty cell still counts
  const endCell = (): void => {
    row.push(cell);
    cell = '';
  };
  const endRow = (): void => {
    if (touched || row.length > 0 || cell !== '') {
      endCell();
      rows.push(row);
    }
    row = [];
    touched = false;
  };
  for (let i = 0; i < source.length; i += 1) {
    const ch = source.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (source.charAt(i + 1) === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
      touched = true;
    } else if (ch === delimiter) {
      endCell();
      touched = true;
    } else if (ch === '\r') {
      if (source.charAt(i + 1) === '\n') i += 1;
      endRow();
    } else if (ch === '\n') {
      endRow();
    } else {
      cell += ch;
      touched = true;
    }
  }
  if (quoted) throw new Error('A quoted cell is never closed.');
  endRow();
  return rows;
}

/** The delimiter of the header line: comma, semicolon (Excel in many locales) or tab. */
function detectDelimiter(source: string): string {
  const firstLine = source.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', ';', '\t'].map((d) => ({ d, n: firstLine.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0] && counts[0].n > 0 ? counts[0].d : ',';
}

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'watched', 'seen', 'done']);
const FALSE_WORDS = new Set([
  'false',
  'no',
  'n',
  '0',
  'unwatched',
  'to watch',
  'towatch',
  'watchlist',
  'pending',
]);
const TV_WORDS = new Set([
  'tv',
  'series',
  'show',
  'tv show',
  'tvshow',
  'tv series',
  'tvseries',
  'web series',
]);
const MOVIE_WORDS = new Set(['movie', 'film', 'movies', 'films']);

/** `csv`: also undo the apostrophe our own CSV export adds in front of formula-like cells. */
const clean = (value: unknown, csv: boolean): string | null => {
  const raw =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : null;
  if (raw === null) return null;
  const s = raw.trim();
  const unsafe = csv && /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s;
  return unsafe === '' ? null : unsafe;
};

interface Coerced {
  readonly values: Partial<Record<keyof MovieInputValues, unknown>>;
  readonly problems: string[];
}

/** Turns loosely typed cells (CSV text or JSON values) into the shape the schema validates. */
function coerce(raw: Partial<Record<keyof MovieInputValues, unknown>>, csv: boolean): Coerced {
  const text = (value: unknown): string | null => clean(value, csv);
  const problems: string[] = [];
  const values: Partial<Record<keyof MovieInputValues, unknown>> = {};

  values.title = text(raw.title) ?? '';

  const kind = text(raw.mediaType)?.toLowerCase();
  if (kind === undefined || MOVIE_WORDS.has(kind)) values.mediaType = 'movie';
  else if (TV_WORDS.has(kind) || (MEDIA_TYPES as readonly string[]).includes(kind)) {
    values.mediaType = TV_WORDS.has(kind) ? 'tv' : kind;
  } else problems.push(`Type “${kind}” is not movie or tv`);

  const whole = (field: 'year' | 'runtimeMinutes', label: string): void => {
    const cell = raw[field];
    if (cell === null || cell === undefined || text(cell) === null) {
      values[field] = null;
      return;
    }
    const match = /^\s*(\d{1,6})\b/.exec(text(cell) ?? '');
    const n = typeof cell === 'number' ? cell : match ? Number(match[1]) : Number.NaN;
    if (Number.isFinite(n) && Number.isInteger(n)) values[field] = n;
    else problems.push(`${label} “${text(cell) ?? ''}” is not a whole number`);
  };
  whole('year', 'Year');
  whole('runtimeMinutes', 'Runtime');

  for (const field of ['genre', 'verdict', 'technicalNotes', 'shotLink'] as const) {
    values[field] = text(raw[field]);
  }

  const watchedCell = raw.watched;
  const watchedText = text(watchedCell)?.toLowerCase();
  const date = text(raw.watchedOn);
  if (typeof watchedCell === 'boolean') values.watched = watchedCell;
  else if (watchedText === undefined)
    values.watched = date !== null; // a date means it was watched
  else if (TRUE_WORDS.has(watchedText)) values.watched = true;
  else if (FALSE_WORDS.has(watchedText)) values.watched = false;
  else problems.push(`Watched “${watchedText}” is not yes or no`);
  values.watchedOn = date !== null ? date.slice(0, 10) : null;

  const ratingCell = raw.userRating;
  if (ratingCell === null || ratingCell === undefined || text(ratingCell) === null) {
    values.userRating = null;
  } else {
    const n =
      typeof ratingCell === 'number'
        ? ratingCell
        : Number((text(ratingCell) ?? '').replace(',', '.'));
    if (Number.isFinite(n)) values.userRating = n;
    else problems.push(`Rating “${text(ratingCell) ?? ''}” is not a number`);
  }
  return { values, problems };
}

function validate(line: number, coerced: Coerced): ParsedRow {
  if (coerced.problems.length > 0) return { line, input: null, problems: coerced.problems };
  const parsed = movieInputSchema.safeParse(coerced.values);
  if (parsed.success) return { line, input: parsed.data, problems: [] };
  return {
    line,
    input: null,
    problems: parsed.error.issues.map((issue) => issue.message),
  };
}

function parseCsvFile(source: string): ParseOutcome {
  let table: string[][];
  try {
    table = parseCsv(source, detectDelimiter(source));
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'The file is not a valid CSV.');
  }
  const header = table[0];
  if (!header) return fail('The file is empty.');
  const fields = header.map(fieldForHeader);
  if (!fields.includes('title')) {
    return fail(
      `No title column found. The first line has: ${header.map((h) => `“${h.replace(/^\uFEFF/, '')}”`).join(', ')}. Name one column “title”.`,
    );
  }
  const ignoredColumns = header
    .filter((_, i) => fields[i] === null)
    .map((h) => h.replace(/^\uFEFF/, ''));
  const body = table.slice(1).filter((cells) => cells.some((c) => c.trim() !== ''));
  if (body.length > IMPORT_MAX_ROWS)
    return fail(`The file has more than ${String(IMPORT_MAX_ROWS)} rows.`);
  const rows = body.map((cells, index) => {
    const raw: Partial<Record<keyof MovieInputValues, unknown>> = {};
    fields.forEach((field, column) => {
      if (field !== null && raw[field] === undefined) raw[field] = cells[column] ?? '';
    });
    return validate(index + 2, coerce(raw, true));
  });
  return { ok: true, kind: 'csv', rows, checksum: 'absent', ignoredColumns };
}

async function parseJsonFile(source: string): Promise<ParseOutcome> {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    return fail('The file is not valid JSON.');
  }
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  const list = Array.isArray(data) ? (data as unknown[]) : isRecord(data) ? data.movies : undefined;
  if (!Array.isArray(list)) return fail('The file has no “movies” list.');
  if (isRecord(data) && data.format !== undefined && data.format !== EXPORT_FORMAT) {
    return fail('This JSON file is not a CinemaVault export.');
  }
  if (isRecord(data) && typeof data.version === 'number' && data.version > EXPORT_VERSION) {
    return fail('This backup was made by a newer version of CinemaVault. Update the app first.');
  }
  if (list.length > IMPORT_MAX_ROWS)
    return fail(`The file has more than ${String(IMPORT_MAX_ROWS)} rows.`);

  const rows: ParsedRow[] = list.map((item, index) => {
    if (!isRecord(item)) return { line: index + 1, input: null, problems: ['Not an object'] };
    const raw: Partial<Record<keyof MovieInputValues, unknown>> = {};
    for (const field of EXPORT_FIELDS) {
      const key = Object.keys(item).find((k) => fieldForHeader(k) === field);
      if (key !== undefined) raw[field] = item[key];
    }
    return validate(index + 1, coerce(raw, false));
  });

  let checksum: 'verified' | 'mismatch' | 'absent' = 'absent';
  if (isRecord(data) && typeof data.checksum === 'string') {
    // Only a file whose every row is readable can be compared with the checksum it carries.
    const all = rows.every((row) => row.input !== null);
    const sorted = sortedForExport(rows.flatMap((row) => (row.input ? [row.input] : [])));
    checksum =
      all && (await sha256Hex(canonical(sorted))) === data.checksum ? 'verified' : 'mismatch';
  }
  const known = new Set<string>(EXPORT_FIELDS);
  const ignored = new Set<string>();
  for (const item of list) {
    if (isRecord(item))
      for (const key of Object.keys(item))
        if (!known.has(key) && fieldForHeader(key) === null) ignored.add(key);
  }
  return { ok: true, kind: 'json', rows, checksum, ignoredColumns: [...ignored] };
}

/** Reads a backup (JSON) or a spreadsheet export (CSV). Never throws. */
export async function parseImportFile(source: string): Promise<ParseOutcome> {
  if (source.length > IMPORT_MAX_BYTES) return fail('The file is larger than 5 MB.');
  const body = source.replace(/^\uFEFF/, '').trimStart();
  if (body.startsWith('{') || body.startsWith('[')) return parseJsonFile(body);
  return parseCsvFile(source);
}

// ---------------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------------

/**
 * What will happen to a row:
 *  - new       will be added
 *  - exists    skipped: the library already has this title (same name, type and year)
 *  - repeated  skipped: an earlier row of the same file is the same title
 *  - invalid   skipped: a value cannot be saved (see `problems`)
 */
export type RowStatus = 'new' | 'exists' | 'repeated' | 'invalid';

export interface PlannedRow {
  readonly line: number;
  readonly status: RowStatus;
  readonly input: MovieInputValues | null;
  readonly problems: readonly string[];
  /** For `exists`: how the library spells it. */
  readonly matches?: string;
}

export interface ImportPlan {
  readonly rows: readonly PlannedRow[];
  readonly counts: Readonly<Record<RowStatus, number> & { total: number }>;
  /** In file order; exactly the rows with status `new`. */
  readonly toCreate: readonly MovieInputValues[];
}

const identity = (title: string, mediaType: string, year: number | null): string =>
  `${mediaType}|${comparableTitle(normalizeTitle(title))}|${year === null ? '' : String(year)}`;

/** Same duplicate rule as the repositories (documented in identity.ts), so a plan never disagrees. */
export function planImport(parsed: readonly ParsedRow[], library: readonly Movie[]): ImportPlan {
  const existing = new Map<string, string>();
  for (const movie of library) {
    if (movie.deletedAt === null) {
      existing.set(identity(movie.title, movie.mediaType, movie.year), movie.title);
    }
  }
  const seen = new Set<string>();
  const rows: PlannedRow[] = [];
  const counts = { new: 0, exists: 0, repeated: 0, invalid: 0, total: parsed.length };
  for (const row of parsed) {
    if (row.input === null) {
      counts.invalid += 1;
      rows.push({ line: row.line, status: 'invalid', input: null, problems: row.problems });
      continue;
    }
    const key = identity(row.input.title, row.input.mediaType, row.input.year);
    const match = existing.get(key);
    if (match !== undefined) {
      counts.exists += 1;
      rows.push({
        line: row.line,
        status: 'exists',
        input: row.input,
        problems: [],
        matches: match,
      });
    } else if (seen.has(key)) {
      counts.repeated += 1;
      rows.push({ line: row.line, status: 'repeated', input: row.input, problems: [] });
    } else {
      seen.add(key);
      counts.new += 1;
      rows.push({ line: row.line, status: 'new', input: row.input, problems: [] });
    }
  }
  return {
    rows,
    counts,
    toCreate: rows.flatMap((row) => (row.status === 'new' && row.input ? [row.input] : [])),
  };
}
