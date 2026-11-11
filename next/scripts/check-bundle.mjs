// Fails the build if a real server-side credential ended up in the browser bundle.
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

const problems = [];
for (const file of files(dir)) {
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

if (problems.length > 0) {
  console.error('Server credential found in the client bundle:\n' + problems.join('\n'));
  process.exit(1);
}
console.log(`Client bundle in ${dir} contains no server credentials.`);
