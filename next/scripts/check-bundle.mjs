// Fails the build if (1) a real server-side credential ended up in the browser bundle, or
// (2) a JavaScript file grew past its size budget (raw bytes, before compression).
// Looks for credential *shapes*, not words: the app's own env validator legitimately mentions
// names such as "service_role" and "sb_secret_" in order to reject them.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'dist';
const SECRET_KEY = /sb_secret_[A-Za-z0-9_-]{16,}/;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g;

function* files(root) {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

/** Budgets in bytes. Generous on purpose: they catch an accident (a whole library pulled in), not a tweak. */
const MAX_FILE_BYTES = 300 * 1024; // the biggest file today is ~215 kB
const MAX_TOTAL_JS_BYTES = 1100 * 1024; // all JavaScript together, today ~0.94 MB

const problems = [];
let totalJs = 0;
for (const file of files(dir)) {
  if (file.endsWith('.js')) {
    const size = statSync(file).size;
    totalJs += size;
    if (size > MAX_FILE_BYTES) {
      problems.push(
        `${file}: ${Math.round(size / 1024)} kB is over the ${MAX_FILE_BYTES / 1024} kB per-file budget`,
      );
    }
  }
  if (!/\.(js|mjs|css|html|map|json|webmanifest)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  if (SECRET_KEY.test(text)) problems.push(`${file}: Supabase secret key`);
  for (const match of text.matchAll(JWT)) {
    try {
      const payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
      if (payload.role === 'service_role') problems.push(`${file}: service_role JWT`);
    } catch {
      /* not a JWT payload */
    }
  }
}

if (totalJs > MAX_TOTAL_JS_BYTES) {
  problems.push(
    `total JavaScript ${Math.round(totalJs / 1024)} kB is over the ${MAX_TOTAL_JS_BYTES / 1024} kB budget`,
  );
}

if (problems.length > 0) {
  console.error('Bundle check failed:\n' + problems.join('\n'));
  process.exit(1);
}
console.log(
  `Client bundle in ${dir}: no server credentials; JavaScript ${Math.round(totalJs / 1024)} kB in total, every file within budget.`,
);
