// Migration rehearsal: copy a library into a DEVELOPMENT database and prove the copy is exact.
// Pure functions plus an orchestrator that takes the clients as arguments, so the same code is
// tested against a real Postgres (tests/unit/rehearsal.test.ts) and run by rehearse-migration.mjs.
import { createHash } from 'node:crypto';

export const PRODUCTION_PROJECT_REFS = ['qhopjfqpnmoinggejgvt'];

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
