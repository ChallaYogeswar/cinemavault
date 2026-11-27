#!/usr/bin/env node
// Rehearse the library migration on a DEVELOPMENT Supabase project.
//
//   dry run (reads only, nothing written anywhere):
//     node scripts/rehearse-migration.mjs
//   copy into the dev project and compare field by field:
//     node scripts/rehearse-migration.mjs --apply [--reset-dev]
//   use a saved backup instead of reading production:
//     node scripts/rehearse-migration.mjs --apply --from-backup rehearsal-output/backup-….json
//
// Environment (never commit these):
//   SOURCE_URL SOURCE_KEY SOURCE_EMAIL SOURCE_PASSWORD   the library to copy, read with SELECT only
//   DEST_URL   DEST_KEY   DEST_EMAIL   DEST_PASSWORD     the DEVELOPMENT project (owner account)
// KEYs are the publishable (anon) keys. The destination may never be a production project.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { assertSafeTargets, digestRows, readAllRows, rehearse } from './rehearsal-lib.mjs';

const args = new Set(process.argv.slice(2));
const flag = (name) => args.has(name);
const valueOf = (name) => {
  const argv = process.argv.slice(2);
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};

const signedIn = async (url, key, email, password) => {
  const client = createClient(url, key, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Sign-in to ${new URL(url).hostname} failed: ${error.message}`);
  return client;
};

/** Exposes SELECT only, so the source cannot be modified by this script even by mistake. */
const readOnly = (client) => ({
  from: (table) => {
    const query = client.from(table);
    return { select: (...a) => query.select(...a) };
  },
});

const backupPath = valueOf('--from-backup');
const apply = flag('--apply');
const outDir = 'rehearsal-output';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

const destUrl = need('DEST_URL');
assertSafeTargets({ sourceUrl: backupPath ? undefined : need('SOURCE_URL'), destUrl });

let source;
if (backupPath) {
  const saved = JSON.parse(readFileSync(backupPath, 'utf8'));
  if (digestRows(saved.rows) !== saved.digest)
    throw new Error('Backup file is corrupt: its digest does not match.');
  source = { readAll: () => Promise.resolve(saved.rows) };
  console.log(`source: backup ${backupPath} (${String(saved.rows.length)} rows, digest verified)`);
} else {
  const client = await signedIn(
    need('SOURCE_URL'),
    need('SOURCE_KEY'),
    need('SOURCE_EMAIL'),
    need('SOURCE_PASSWORD'),
  );
  source = {
    readAll: async () => {
      const rows = await readAllRows(readOnly(client));
      mkdirSync(outDir, { recursive: true });
      const file = `${outDir}/backup-${stamp}.json`;
      writeFileSync(
        file,
        JSON.stringify({ takenAt: new Date().toISOString(), digest: digestRows(rows), rows }),
      );
      console.log(
        `backup written: ${file} (${String(rows.length)} rows) — this is your rollback copy`,
      );
      return rows;
    },
  };
}

const dest = await signedIn(destUrl, need('DEST_KEY'), need('DEST_EMAIL'), need('DEST_PASSWORD'));

if (apply && flag('--reset-dev')) {
  const existing = await readAllRows(dest);
  for (let start = 0; start < existing.length; start += 200) {
    const ids = existing.slice(start, start + 200).map((row) => row.id);
    const { error } = await dest.from('movies').delete().in('id', ids);
    if (error) throw new Error(`reset failed: ${error.message}`);
  }
  console.log(`dev reset: removed ${String(existing.length)} rows`);
}

const report = await rehearse({ source, dest, apply, log: (line) => console.log(line) });
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/report-${stamp}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (apply && !report.identical) {
  console.error('\nMISMATCH: the copy is not identical to the source. See the report above.');
  process.exit(1);
}
console.log(
  apply
    ? '\nOK: every row, field and timestamp matches.'
    : '\nDry run only. Re-run with --apply to copy into the dev project.',
);
