// Probes a deployed CinemaVault Next URL and says WHICH /api/tmdb implementation is answering.
//
//   npm run check:deployment -- https://my-preview.vercel.app [--token <access token>]
//
// Why: this repository holds two proxies. `next/api/tmdb.ts` (this app, checks sign-in against the
// deployment's own Supabase project) and the older root `api/tmdb.js` (hard-codes the PRODUCTION
// project). Which one is deployed depends on the Vercel project's Root Directory, which must be
// `next`. Only the new one sends the X-CinemaVault-Proxy header, so this fails loudly when the
// wrong one answers. Without --token only the signed-out checks run; with a token (the
// `access_token` of a signed-in test user on THAT deployment's Supabase project) the rest run too.
import { pathToFileURL } from 'node:url';

const MARKER = 'x-cinemavault-proxy';

const checkOf = (name, ok, detail = '') => ({ name, ok, detail });

/** `fetchImpl` is injectable so the logic can be tested without a network. */
export async function probe(base, { token, fetchImpl = fetch } = {}) {
  const root = base.replace(/\/+$/, '');
  const call = async (query, authorized) => {
    const headers = authorized && token ? { Authorization: `Bearer ${token}` } : {};
    try {
      const reply = await fetchImpl(`${root}/api/tmdb?${query}`, { headers });
      return { status: reply.status, marker: reply.headers.get(MARKER) };
    } catch (error) {
      return { status: 0, marker: null, error: String(error) };
    }
  };
  const checks = [];

  const anonymous = await call('path=/search/multi&query=Inception', false);
  const identified = anonymous.marker !== null;
  checks.push(
    checkOf(
      'the new proxy (next/api/tmdb.ts) is the one answering',
      identified,
      anonymous.status === 0
        ? `could not reach the deployment: ${anonymous.error ?? ''}`
        : `status ${String(anonymous.status)} without the ${MARKER} header. Either the Vercel project's Root Directory is not "next" (the old api/tmdb.js is serving), no function is deployed, or Vercel Deployment Protection answered first`,
    ),
  );
  if (!identified) return checks;

  checks.push(
    checkOf('without a token: 401', anonymous.status === 401, `status ${String(anonymous.status)}`),
  );
  const noKey = anonymous.status === 501;
  if (noKey) {
    checks.push(
      checkOf('TMDB_API_KEY is set on the server', false, 'answered 501 (not configured)'),
    );
    return checks;
  }
  if (!token) return checks;

  const search = await call('path=/search/multi&query=Inception', true);
  checks.push(
    checkOf(
      'signed-in search: 200',
      search.status === 200,
      search.status === 502
        ? 'status 502: TMDB rejected the API key, or TMDB is down'
        : search.status === 503
          ? 'status 503: this deployment could not check the sign-in (SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY?)'
          : search.status === 401
            ? 'status 401: the token is not from THIS deployment’s Supabase project'
            : `status ${String(search.status)}`,
    ),
  );
  const badPath = await call('path=/account', true);
  checks.push(
    checkOf(
      'a path outside the allow-list: 400',
      badPath.status === 400,
      `status ${String(badPath.status)}`,
    ),
  );
  const twice = await call('path=/search/multi&path=/account&query=x', true);
  checks.push(
    checkOf('two path parameters: 400', twice.status === 400, `status ${String(twice.status)}`),
  );
  const extra = await call('path=/search/multi&query=x&api_key=mine', true);
  checks.push(
    checkOf('an extra parameter: 400', extra.status === 400, `status ${String(extra.status)}`),
  );
  return checks;
}

async function main() {
  const args = process.argv.slice(2);
  const tokenAt = args.indexOf('--token');
  const token = tokenAt === -1 ? undefined : args[tokenAt + 1];
  const base = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--token');
  if (!base || !/^https?:\/\//.test(base)) {
    console.error(
      'Usage: npm run check:deployment -- https://your-deployment.vercel.app [--token <access token>]',
    );
    process.exit(2);
  }
  const checks = await probe(base, { token });
  for (const c of checks)
    console.log(
      `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok || !c.detail ? '' : `\n      ${c.detail}`}`,
    );
  if (!token) console.log('\n(no --token: signed-in checks skipped)');
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
