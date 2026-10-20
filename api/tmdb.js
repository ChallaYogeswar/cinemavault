/* Vercel serverless function: TMDB proxy.
 *
 * Keeps the TMDB key on the server (Vercel env var TMDB_API_KEY) so no browser or device ever needs it.
 * Only signed-in CinemaVault users may call it, and only a few read-only TMDB paths are allowed.
 *
 *   GET /api/tmdb?path=/search/multi&query=Inception
 *   GET /api/tmdb?path=/movie/27205/videos
 */
const SUPABASE_URL = 'https://qhopjfqpnmoinggejgvt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_bvBb8dJt1bkRLLvIQIYEBw_EVZWq-yo'; // public/publishable key

const ALLOWED = [/^\/search\/multi$/, /^\/(movie|tv)\/\d+\/videos$/];

async function signedIn(token) {
  if (!token) return false;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token } });
    return r.ok;
  } catch (_) { return false; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.TMDB_API_KEY;
  if (!key) return res.status(501).json({ error: 'TMDB_API_KEY is not configured on the server.' });

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!(await signedIn(token))) return res.status(401).json({ error: 'Sign in required.' });

  const url = new URL(req.url, 'http://localhost');
  const path = url.searchParams.get('path') || '';
  if (!ALLOWED.some(rx => rx.test(path))) return res.status(400).json({ error: 'Path not allowed.' });

  const params = new URLSearchParams();
  for (const [name, value] of url.searchParams) if (name !== 'path' && name !== 'api_key') params.set(name, value);

  const headers = { Accept: 'application/json' };
  // Supports both a v3 API key and a v4 "read access token" (a long JWT).
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key; else params.set('api_key', key);

  try {
    const upstream = await fetch('https://api.themoviedb.org/3' + path + '?' + params.toString(), { headers });
    const body = await upstream.text();
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.status(upstream.status).send(body);
  } catch (error) {
    return res.status(502).json({ error: 'TMDB request failed.' });
  }
};
