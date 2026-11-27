// Writes the security headers from `security/policy.mjs` into `vercel.json`.
//   node scripts/sync-security-headers.mjs          rewrite vercel.json
//   node scripts/sync-security-headers.mjs --check  exit 1 if vercel.json is out of date (CI)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applySecurityHeaders } from '../security/policy.mjs';

const file = resolve(import.meta.dirname, '../vercel.json');
const current = readFileSync(file, 'utf8');
const wanted = `${JSON.stringify(applySecurityHeaders(JSON.parse(current)), null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (current !== wanted) {
    console.error('vercel.json is out of date. Run: node scripts/sync-security-headers.mjs');
    process.exit(1);
  }
  console.log('vercel.json matches security/policy.mjs.');
} else {
  writeFileSync(file, wanted);
  console.log('vercel.json updated from security/policy.mjs.');
}
