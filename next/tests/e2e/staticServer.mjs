// Serves a built `dist` folder the way the production host does: real files first, then the SPA
// fallback to index.html, and `sw.js` / `index.html` never cached by the HTTP cache.
import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join, normalize } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// `api(req, res, url)` stands in for the host's serverless functions (`/api/*`), if given.
// `options.headers` are sent on every file, as the host's `vercel.json` headers would be.
export function createStaticServer(initialRoot, api, options = {}) {
  const extraHeaders = options.headers ?? {};
  let root = initialRoot;
  let down = false;
  const server = http.createServer((req, res) => {
    if (down) {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url, 'http://static');
    if (api && url.pathname.startsWith('/api/')) {
      api(req, res, url);
      return;
    }
    let file = normalize(join(root, decodeURIComponent(url.pathname)));
    const isFile = file.startsWith(root) && existsSync(file) && statSync(file).isFile();
    if (!isFile) file = join(root, 'index.html');
    const noStore =
      file.endsWith('sw.js') || file.endsWith('index.html') || file.endsWith('.webmanifest');
    res.writeHead(200, {
      ...extraHeaders,
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': noStore ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(readFileSync(file));
  });
  return {
    setRoot(next) {
      root = next;
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
