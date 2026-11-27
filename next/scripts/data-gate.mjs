#!/usr/bin/env node
// The data-integrity gate. READ-ONLY: it signs in, runs SELECT, and writes a report. It cannot
// modify the database it reads (it is only ever handed `select`).
//
//   node scripts/data-gate.mjs                          check a library, print the verdict
//   node scripts/data-gate.mjs --expect-backup FILE     also prove the library is IDENTICAL to a backup
//   node scripts/data-gate.mjs --expect-digest HEX [--expect-count N]
//
// Run it (1) on production just before the cutover, (2) on production right after, and (3) on the
// development project after every rehearsal. A non-zero exit means: stop, do not continue.
//
// Environment (never commit): GATE_URL GATE_KEY GATE_EMAIL GATE_PASSWORD  (publishable key, owner sign-in)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { compareWithExpectation, digestRows, gateRows, readAllRows } from './rehearsal-lib.mjs';

const argv = process.argv.slice(2);
const valueOf = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};

const client = createClient(need('GATE_URL'), need('GATE_KEY'), {
  auth: { persistSession: false },
});
const { error } = await client.auth.signInWithPassword({
  email: need('GATE_EMAIL'),
  password: need('GATE_PASSWORD'),
});
if (error) throw new Error(`Sign-in failed: ${error.message}`);

// Exposes SELECT only, so this script cannot change the library even by mistake.
const readOnly = {
  from: (table) => {
    const query = client.from(table);
    return { select: (...a) => query.select(...a) };
  },
};

const rows = await readAllRows(readOnly);
const gate = gateRows(rows);

let expectation = { digest: valueOf('--expect-digest'), count: undefined };
const countArg = valueOf('--expect-count');
if (countArg !== undefined) expectation.count = Number(countArg);
const backupFile = valueOf('--expect-backup');
if (backupFile) {
  const saved = JSON.parse(readFileSync(backupFile, 'utf8'));
  if (digestRows(saved.rows) !== saved.digest) throw new Error('The backup file is corrupt.');
  expectation = { digest: saved.digest, count: saved.rows.length };
}
const compared = compareWithExpectation(rows, expectation);

const report = {
  checkedAt: new Date().toISOString(),
  host: new URL(need('GATE_URL')).hostname,
  digest: digestRows(rows),
  gate,
  expectation: compared,
};
mkdirSync('rehearsal-output', { recursive: true });
const file = `rehearsal-output/gate-${report.checkedAt.replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify(report, null, 2));

console.log(
  `${String(gate.rows)} rows (${String(gate.live)} live, ${String(gate.tombstones)} deleted); digest ${report.digest}`,
);
for (const check of gate.checks) {
  const mark = check.pass ? (check.kind === 'note' ? 'note' : 'ok  ') : 'FAIL';
  console.log(`${mark}  ${String(check.count).padStart(5)}  ${check.name}`);
  if (!check.pass) console.log(`        e.g. ${check.sample.join(', ')}`);
}
for (const problem of compared.problems) console.log(`FAIL  ${problem}`);
console.log(`report: ${file}`);
if (!gate.pass || !compared.pass) {
  console.error('\nGATE FAILED. Do not continue the cutover.');
  process.exit(1);
}
console.log('\nGATE PASSED.');
