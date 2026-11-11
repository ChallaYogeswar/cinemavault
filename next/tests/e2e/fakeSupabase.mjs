// A tiny stand-in for the parts of Supabase the app talks to (GoTrue password sign-in, token
// refresh, sign-out, and PostgREST `profiles` / `movies` reads). Used ONLY by the browser E2E:
// it has no database and no relation to any real project.
import { randomUUID } from 'node:crypto';
import http from 'node:http';

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function makeJwt(userId, email, expiresAt) {
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({
    sub: userId,
    email,
    role: 'authenticated',
    aud: 'authenticated',
    exp: expiresAt,
    iat: expiresAt - 3600,
  });
  return `${header}.${payload}.fake-signature`;
}

export function movieRow(ownerId, title, patch = {}) {
  const stamp = '2026-10-01T10:00:00.123456+00:00';
  return {
    id: randomUUID(),
    owner_id: ownerId,
    title,
    normalized_title: title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim(),
    media_type: 'movie',
    year: 2020,
    genre: 'Drama',
    runtime_minutes: 100,
    watched: true,
    watched_on: '2026-09-01',
    user_rating: 4,
    verdict: null,
    technical_notes: null,
    shot_link: null,
    created_at: stamp,
    updated_at: stamp,
    deleted_at: null,
    ...patch,
  };
}

export function createFakeSupabase() {
  const users = new Map(); // email -> { id, email, password, role, movies: [] }
  const refreshTokens = new Map(); // token -> userId
  const revoked = new Set();
  const log = [];
  let down = false;
  let counter = 0;

  const addUser = (email, password, titles = []) => {
    const id = randomUUID();
    const user = { id, email, password, role: 'owner', movies: [] };
    user.movies = titles.map((title) => movieRow(id, title));
    users.set(email, user);
    return user;
  };
  const byId = (id) => [...users.values()].find((u) => u.id === id);

  const session = (user) => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const refresh = `rt-${user.id.slice(0, 8)}-${(counter += 1)}`;
    refreshTokens.set(refresh, user.id);
    return {
      access_token: makeJwt(user.id, user.email, expiresAt),
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: expiresAt,
      refresh_token: refresh,
      user: {
        id: user.id,
        aud: 'authenticated',
        role: 'authenticated',
        email: user.email,
        email_confirmed_at: '2026-01-01T00:00:00Z',
        app_metadata: { provider: 'email' },
        user_metadata: {},
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    };
  };

  const userFromAuthHeader = (req) => {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) return null;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      return byId(payload.sub) ?? null;
    } catch {
      return null;
    }
  };

  const server = http.createServer((req, res) => {
    if (down) {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url, 'http://fake');
    const origin = req.headers.origin ?? '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] ?? 'authorization,apikey,content-type',
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    log.push(`${req.method} ${url.pathname}`);
    const json = (status, body, extra = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
      res.end(JSON.stringify(body));
    };

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};

      if (url.pathname === '/auth/v1/token') {
        const grant = url.searchParams.get('grant_type');
        if (grant === 'password') {
          const user = users.get(payload.email);
          if (!user || user.password !== payload.password) {
            return json(400, {
              code: 400,
              error_code: 'invalid_credentials',
              msg: 'Invalid login credentials',
            });
          }
          return json(200, session(user));
        }
        if (grant === 'refresh_token') {
          const userId = refreshTokens.get(payload.refresh_token);
          const user = userId ? byId(userId) : null;
          if (!user || revoked.has(payload.refresh_token)) {
            return json(400, {
              code: 400,
              error_code: 'refresh_token_not_found',
              msg: 'Invalid Refresh Token: Refresh Token Not Found',
            });
          }
          return json(200, session(user));
        }
      }
      if (url.pathname === '/auth/v1/user') {
        const user = userFromAuthHeader(req);
        if (!user) return json(401, { code: 401, msg: 'invalid JWT' });
        return json(200, session(user).user);
      }
      if (url.pathname === '/auth/v1/logout') {
        res.writeHead(204).end();
        return;
      }
      if (url.pathname === '/rest/v1/profiles') {
        const user = userFromAuthHeader(req);
        if (!user) return json(401, { message: 'JWT expired' });
        const wantsObject = (req.headers.accept ?? '').includes('pgrst.object');
        if (wantsObject) return json(200, { role: user.role });
        return json(200, [{ role: user.role }]);
      }
      if (url.pathname === '/rest/v1/movies' && req.method === 'GET') {
        const user = userFromAuthHeader(req);
        if (!user) return json(401, { message: 'JWT expired' });
        const gt = /^gt\.(.+)$/.exec(url.searchParams.get('id') ?? '')?.[1];
        const limit = Number(url.searchParams.get('limit') ?? 1000);
        const rows = user.movies
          .filter((m) => m.deleted_at === null && (gt === undefined || m.id > gt))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, limit);
        return json(200, rows);
      }
      json(404, { message: `fake supabase: no route for ${req.method} ${url.pathname}` });
    });
  });

  return {
    server,
    log,
    addUser,
    users,
    /** Refresh tokens of this user stop working, as if the session was revoked elsewhere. */
    revokeSessions(email) {
      const user = users.get(email);
      for (const [token, id] of refreshTokens) if (id === user.id) revoked.add(token);
    },
    setDown(value) {
      down = value;
    },
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      }),
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
