// Migration rehearsal: copy a library into a DEVELOPMENT database and prove the copy is exact.
// Pure functions plus an orchestrator that takes the clients as arguments, so the same code is
// tested against a real Postgres (tests/unit/rehearsal.test.ts) and run by rehearse-migration.mjs.
import { createHash } from 'node:crypto';

export const PRODUCTION_PROJECT_REFS = ['ermjvreodaeovawbsbyh'];

export const COLUMNS = [
  'id',
  'owner_id',
  'title',
  'normalized_title',
  'media_type',
  'year',
  'genre',
  'runtime_minutes',
  'watched',
  'watched_on',
  'user_rating',
  'verdict',
  'technical_notes',
  'shot_link',
  'created_at',
  'updated_at',
  'deleted_at',
];

const refOf = (url) => new URL(url).hostname.split('.')[0] ?? '';

/** The destination must never be production, and must not be the source. */
export function assertSafeTargets({
  sourceUrl,
  destUrl,
  productionRefs = PRODUCTION_PROJECT_REFS,
}) {
  const dest = refOf(destUrl);
  if (productionRefs.includes(dest)) {
    throw new Error(`Refusing to write: the destination (${dest}) is a PRODUCTION project.`);
  }
  if (sourceUrl && refOf(sourceUrl) === dest) {
    throw new Error('Refusing to write: source and destination are the same project.');
  }
}

/** Every row, by keyset pagination on id (immune to the server's row cap), tombstones included. */
export async function readAllRows(client, { pageSize = 1000, maxPages = 500 } = {}) {
  const rows = [];
  let after = null;
  for (let page = 0; page < maxPages; page += 1) {
    let query = client.from('movies').select(COLUMNS.join(', ')).order('id', { ascending: true });
    if (after !== null) query = query.gt('id', after);
    const { data, error } = await query.limit(pageSize);
    if (error) throw new Error(`read failed on page ${String(page)}: ${error.message}`);
    if (!data || data.length === 0) return rows;
    rows.push(...data);
    after = data[data.length - 1].id;
  }
  throw new Error(
    `read stopped after ${String(maxPages)} pages; refusing to return a partial copy`,
  );
}

const canonical = (row) => JSON.stringify(COLUMNS.map((column) => row[column] ?? null));

/** One fingerprint for a whole library; any changed field, id or count changes it. */
export function digestRows(rows) {
  const hash = createHash('sha256');
  for (const row of [...rows].sort((a, b) => (a.id < b.id ? -1 : 1)))
    hash.update(canonical(row) + '\n');
  return hash.digest('hex');
}

/** Field-by-field comparison. Timestamps are compared as the exact strings the server returned. */
export function diffRows(source, target) {
  const byId = new Map(target.map((row) => [row.id, row]));
  const seen = new Set();
  const changed = [];
  const missing = [];
  for (const row of source) {
    const other = byId.get(row.id);
    if (!other) {
      missing.push(row.id);
      continue;
    }
    seen.add(row.id);
    const fields = COLUMNS.filter(
      (column) => !Object.is(row[column] ?? null, other[column] ?? null),
    ).map((column) => ({ column, source: row[column] ?? null, target: other[column] ?? null }));
    if (fields.length > 0) changed.push({ id: row.id, fields });
  }
  const extra = target.filter((row) => !seen.has(row.id)).map((row) => row.id);
  return {
    sourceCount: source.length,
    targetCount: target.length,
    missing,
    extra,
    changed,
    identical: missing.length === 0 && extra.length === 0 && changed.length === 0,
  };
}

/** A shape profile, so a human can sanity-check what is being moved. */
export function profileRows(rows) {
  const count = (test) => rows.filter(test).length;
  const subMs = (value) =>
    typeof value === 'string' &&
    /\.\d{4,6}(?=[+Z])/.test(value) &&
    !/\.\d{3}0*(?=[+Z])/.test(value);
  return {
    total: rows.length,
    live: count((r) => r.deleted_at === null),
    tombstones: count((r) => r.deleted_at !== null),
    owners: new Set(rows.map((r) => r.owner_id)).size,
    yearless: count((r) => r.year === null),
    rated: count((r) => r.user_rating !== null),
    tv: count((r) => r.media_type === 'tv'),
    microsecondTimestamps: count((r) => subMs(r.updated_at)),
    distinctVersions: new Set(rows.map((r) => r.updated_at)).size,
  };
}

async function writeRows(client, rows, batchSize, log) {
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const { error } = await client.from('movies').insert(batch);
    if (error) {
      throw new Error(
        `write failed at rows ${String(start)}-${String(start + batch.length - 1)}: ${error.message}. ` +
          'Nothing in production was changed; empty the dev table and re-run.',
      );
    }
    log(`  wrote ${String(Math.min(start + batch.length, rows.length))}/${String(rows.length)}`);
  }
}

/**
 * Reads `source`, optionally copies into `dest`, reads `dest` back and compares.
 *  - `source`  : { readAll(): Promise<row[]> }  (production, read-only, or a backup file)
 *  - `dest`    : a supabase-js-like client for the DEVELOPMENT project
 *  - `apply`   : false = dry run (profile only, no writes anywhere)
 */
export async function rehearse({ source, dest, apply, batchSize = 200, log = () => {} }) {
  const rows = await source.readAll();
  const report = { profile: profileRows(rows), sourceDigest: digestRows(rows), applied: false };
  log(`source: ${JSON.stringify(report.profile)}`);
  if (!apply) return report;

  const existing = await readAllRows(dest);
  if (existing.length > 0) {
    throw new Error(
      `The destination already holds ${String(existing.length)} rows. Empty it first (--reset-dev) so the comparison is meaningful.`,
    );
  }
  await writeRows(dest, rows, batchSize, log);
  const copy = await readAllRows(dest);
  const diff = diffRows(rows, copy);
  return {
    ...report,
    applied: true,
    targetDigest: digestRows(copy),
    diff: {
      ...diff,
      missing: diff.missing.slice(0, 20),
      extra: diff.extra.slice(0, 20),
      changed: diff.changed.slice(0, 20),
    },
    identical: diff.identical && digestRows(copy) === report.sourceDigest,
  };
}

// ---------------------------------------------------------------------------------------------
// The data-integrity GATE: the checks that were run by hand against production (docs/migration-
// plan.md, "Baseline measured on production"), as code, so they can be re-run before and after
// every migration, rehearsal and cutover with one command. Pure: rows in, verdict out.
// ---------------------------------------------------------------------------------------------

/** MIRRORS src/domain/identity.ts (`comparableTitle`); tests/unit/dataGate.test.ts pins the parity. */
export function comparableTitle(normalized) {
  return normalized
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// MIRRORS the application's `normalizeTitle`; used only to COUNT rows whose stored value differs (F9).
const appNormalize = (title) =>
  (title ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\(series\)|\(show\)|\(tv\)/gi, '')
    .replace(/\s+season\s+\d+$/i, '')
    .trim();

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const timeOf = (value) => (typeof value === 'string' ? Date.parse(value) : Number.NaN);

/**
 * `fail` checks must be zero before and after a cutover: they are things the application cannot
 * represent or that break the "one title, one row" promise. `note` checks are known, documented
 * data conditions (F7, F9, F10 in docs/migration-plan.md): they are reported with their count so
 * a change since the last baseline is visible, but they never fail the gate by themselves.
 */
export function gateRows(rows) {
  const live = rows.filter((row) => row.deleted_at === null);
  const bad = (name, kind, test, rowsToCheck = rows) => {
    const hits = rowsToCheck.filter(test);
    return {
      name,
      kind,
      count: hits.length,
      pass: kind === 'note' || hits.length === 0,
      sample: hits.slice(0, 5).map((row) => row.id),
    };
  };

  const groups = new Map();
  for (const row of live) {
    const key = `${row.media_type}|${comparableTitle(String(row.normalized_title ?? ''))}|${row.year ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), row.id]);
  }
  const duplicateGroups = [...groups.values()].filter((ids) => ids.length > 1);
  const idCounts = new Map();
  for (const row of rows) idCounts.set(row.id, (idCounts.get(row.id) ?? 0) + 1);
  const repeatedIds = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id);

  const checks = [
    {
      name: 'every id appears once',
      kind: 'fail',
      count: repeatedIds.length,
      pass: repeatedIds.length === 0,
      sample: repeatedIds.slice(0, 5),
    },
    {
      name: 'duplicate live titles (same type, comparable title and year)',
      kind: 'fail',
      count: duplicateGroups.length,
      pass: duplicateGroups.length === 0,
      sample: duplicateGroups.slice(0, 5).map((ids) => ids.join(' + ')),
    },
    bad(
      'every row has an owner',
      'fail',
      (r) => typeof r.owner_id !== 'string' || r.owner_id === '',
    ),
    bad(
      'titles are present, at most 200 characters, with no control characters',
      'fail',
      (r) =>
        typeof r.title !== 'string' ||
        r.title.trim() === '' ||
        r.title.length > 200 ||
        CONTROL.test(r.title),
    ),
    bad(
      'media type is movie or tv',
      'fail',
      (r) => r.media_type !== 'movie' && r.media_type !== 'tv',
    ),
    bad(
      'year is empty or between 1888 and 2100',
      'fail',
      (r) => r.year !== null && !(Number.isInteger(r.year) && r.year >= 1888 && r.year <= 2100),
    ),
    bad(
      'rating is empty or between 0 and 5',
      'fail',
      (r) => r.user_rating !== null && !(Number(r.user_rating) >= 0 && Number(r.user_rating) <= 5),
    ),
    bad(
      'runtime is empty or a whole number of minutes from 0 to 10000',
      'fail',
      (r) =>
        r.runtime_minutes !== null &&
        !(
          Number.isInteger(r.runtime_minutes) &&
          r.runtime_minutes >= 0 &&
          r.runtime_minutes <= 10_000
        ),
    ),
    bad(
      '"not watched" rows have no watched date',
      'fail',
      (r) => r.watched === false && r.watched_on !== null,
    ),
    bad(
      'notes are at most 5,000 characters',
      'fail',
      (r) => String(r.technical_notes ?? '').length > 5000,
    ),
    bad(
      'timestamps parse, and a row is never updated before it was created',
      'fail',
      (r) =>
        Number.isNaN(timeOf(r.created_at)) ||
        Number.isNaN(timeOf(r.updated_at)) ||
        timeOf(r.updated_at) < timeOf(r.created_at),
    ),
    bad(
      'a deleted row was deleted after it was created',
      'fail',
      (r) =>
        r.deleted_at !== null &&
        (Number.isNaN(timeOf(r.deleted_at)) || timeOf(r.deleted_at) < timeOf(r.created_at)),
    ),
    bad(
      'stored normalized title is trimmed and lower-case',
      'fail',
      (r) =>
        typeof r.normalized_title !== 'string' ||
        r.normalized_title !== r.normalized_title.trim().toLowerCase(),
    ),
    // Known, documented conditions: reported, not failed.
    bad('F7: shot link is not an http(s) address', 'note', (r) => {
      const link = String(r.shot_link ?? '').trim();
      return link !== '' && !/^https?:\/\//i.test(link);
    }),
    bad(
      'F9: stored normalized title differs from the application’s spelling',
      'note',
      (r) => r.normalized_title !== appNormalize(r.title),
      live,
    ),
    bad('F10: title looks like pasted search-result text', 'note', (r) =>
      /\b(1[89]|20)\d\d\s*[·‧•,|]\s|\buser noted\b/i.test(String(r.title ?? '')),
    ),
  ];

  return {
    rows: rows.length,
    live: live.length,
    tombstones: rows.length - live.length,
    checks,
    pass: checks.every((c) => c.pass),
  };
}

/**
 * Compares a library with an earlier backup's expectations. Used right after a cutover to prove
 * that nothing changed under the migration: same count, same digest.
 */
export function compareWithExpectation(rows, { digest, count } = {}) {
  const problems = [];
  if (count !== undefined && rows.length !== count) {
    problems.push(`expected ${String(count)} rows but found ${String(rows.length)}`);
  }
  if (digest !== undefined && digestRows(rows) !== digest) {
    problems.push('the library’s digest differs from the expected one: some value changed');
  }
  return { pass: problems.length === 0, problems };
}
