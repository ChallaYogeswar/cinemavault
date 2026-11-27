import { describe, expect, it } from 'vitest';
import { SHELL, startServiceWorker, type Host } from '../fakes/serviceWorkerHost';

const shellCacheNames = (host: Host) => [...host.caches.stores.keys()];
const entries = (host: Host) => {
  const [name] = shellCacheNames(host);
  return name ? [...(host.caches.stores.get(name)?.keys() ?? [])].sort() : [];
};
const SHELL_PATHS = SHELL.map((f) => f.url).sort();

async function installed(): Promise<Host> {
  const host = startServiceWorker();
  await host.install();
  await host.activate();
  return host;
}

describe('install', () => {
  it('precaches exactly the app shell, bypassing the HTTP cache', async () => {
    const host = startServiceWorker();
    await host.install();
    expect(entries(host)).toEqual(SHELL_PATHS);
    expect(host.network.every((call) => call.cache === 'reload')).toBe(true);
  });

  it('fails the install when any shell file cannot be fetched, so the old worker stays', async () => {
    const host = startServiceWorker();
    host.respond = (path) =>
      path === '/assets/app-1.js'
        ? new Response('gone', { status: 404 })
        : new Response(path, { status: 200 });
    await expect(host.install()).rejects.toThrow(/Precache failed for \/assets\/app-1\.js/);
  });

  it('fails the install while offline', async () => {
    const host = startServiceWorker();
    host.online = false;
    await expect(host.install()).rejects.toThrow();
  });

  it('fails the install on a redirected answer (it would pin a login page as the shell)', async () => {
    const host = startServiceWorker();
    host.respond = (path) => {
      const response = new Response(path, { status: 200 });
      Object.defineProperty(response, 'redirected', { value: path === '/index.html' });
      return response;
    };
    await expect(host.install()).rejects.toThrow(/Precache failed for \/index\.html/);
  });

  it('does not take over a running page by itself', async () => {
    const host = startServiceWorker();
    await host.install();
    expect(host.skipWaitingCalls).toBe(0);
  });

  it('takes over only when the page asks', async () => {
    const host = startServiceWorker();
    await host.install();
    host.message({ type: 'SOMETHING_ELSE' });
    host.message(undefined);
    expect(host.skipWaitingCalls).toBe(0);
    host.message({ type: 'SKIP_WAITING' });
    expect(host.skipWaitingCalls).toBe(1);
  });
});

describe('activate', () => {
  it('removes shells from older versions only, and claims open pages', async () => {
    const host = startServiceWorker();
    host.caches.stores.set('cv-shell-oldversion', new Map());
    host.caches.stores.set('someone-elses-cache', new Map());
    await host.install();
    await host.activate();
    const names = shellCacheNames(host);
    expect(names).not.toContain('cv-shell-oldversion');
    expect(names).toContain('someone-elses-cache');
    expect(names.filter((n) => n.startsWith('cv-shell-'))).toHaveLength(1);
    expect(host.claimCalls).toBe(1);
  });
});

describe('requests the worker must stay out of', () => {
  it.each([
    ['a write', '/assets/app-1.js', { method: 'POST' }],
    ['a delete', '/rest/v1/movies', { method: 'DELETE' }],
    ['a server route', '/api/tmdb/search?query=x', {}],
    ['Supabase', 'https://abc.supabase.co/rest/v1/movies?select=*', {}],
    ['Supabase auth', 'https://abc.supabase.co/auth/v1/token?grant_type=refresh_token', {}],
    ['Google Fonts', 'https://fonts.googleapis.com/css2?family=Manrope', {}],
    ['an unknown same-origin file', '/some/other/file.json', {}],
  ])('%s', async (_label, url, init) => {
    const host = await installed();
    const before = host.network.length;
    expect((await host.fetch(url, init)).handled).toBe(false);
    expect(host.network).toHaveLength(before);
  });
});

describe('same file names on other origins, and server routes', () => {
  it('a cross-origin copy of a shell file name is not served from our shell', async () => {
    const host = await installed();
    host.online = false;
    const result = await host.fetch('https://other.test/assets/app-1.js');
    expect(result.handled).toBe(false);
  });

  it('a cross-origin page navigation is not ours', async () => {
    const host = await installed();
    host.online = false;
    expect((await host.fetch('https://other.test/', { mode: 'navigate' })).handled).toBe(false);
  });

  it('a navigation to a server route is never answered with the app shell', async () => {
    const host = await installed();
    host.online = false;
    expect((await host.fetch('/api/report', { mode: 'navigate' })).handled).toBe(false);
  });
});

describe('opening the app (navigation)', () => {
  it('goes to the network first, so a new deploy is seen at once', async () => {
    const host = await installed();
    const result = await host.fetch('/', { mode: 'navigate' });
    expect(result.handled).toBe(true);
    expect(await result.response?.text()).toBe('network:/');
  });

  it('serves the saved shell for any route when the network is down', async () => {
    const host = await installed();
    host.online = false;
    for (const path of ['/', '/settings', '/movie/123', '/sign-in']) {
      const result = await host.fetch(path, { mode: 'navigate' });
      expect(await result.response?.text()).toBe('network:/index.html');
    }
  });

  it('uses its own saved shell, never another cache’s file of the same name', async () => {
    const host = startServiceWorker();
    host.caches.stores.set(
      'someone-elses-cache',
      new Map([['/index.html', new Response('foreign page')]]),
    );
    await host.install();
    await host.activate();
    host.online = false;
    const result = await host.fetch('/', { mode: 'navigate' });
    expect(await result.response?.text()).toBe('network:/index.html');
  });

  it('shows the server’s own error rather than hiding it behind the saved shell', async () => {
    const host = await installed();
    host.respond = () => new Response('maintenance', { status: 503 });
    const result = await host.fetch('/', { mode: 'navigate' });
    expect(result.response?.status).toBe(503);
  });

  it('never stores what the network returned — not even an auth redirect with a code', async () => {
    const host = await installed();
    const writesAfterInstall = host.caches.writes.length;
    await host.fetch('/auth/callback?code=SECRET_CODE&state=xyz', { mode: 'navigate' });
    await host.fetch('/', { mode: 'navigate' });
    expect(host.caches.writes).toHaveLength(writesAfterInstall);
    for (const store of host.caches.stores.values()) {
      for (const key of store.keys()) expect(key).not.toContain('SECRET_CODE');
    }
    expect(entries(host)).toEqual(SHELL_PATHS);
  });

  it('fails cleanly (a network error, not a blank page) if nothing was ever saved', async () => {
    const host = startServiceWorker(); // installed nothing
    host.online = false;
    const result = await host.fetch('/', { mode: 'navigate' });
    expect(result.response?.type).toBe('error');
  });
});

describe('the app’s own files', () => {
  it('are served from the saved shell with no network at all', async () => {
    const host = await installed();
    const before = host.network.length;
    host.online = false;
    const result = await host.fetch('/assets/app-1.js');
    expect(result.handled).toBe(true);
    expect(await result.response?.text()).toBe('network:/assets/app-1.js');
    expect(host.network).toHaveLength(before);
  });

  it('are ignored regardless of a query string on the same path', async () => {
    const host = await installed();
    host.online = false;
    const result = await host.fetch('/assets/app-1.css?v=2');
    expect(result.handled).toBe(true);
  });

  it('never leak into a different version’s shell', async () => {
    const a = await installed();
    const b = startServiceWorker([
      ...SHELL.filter((f) => f.url !== '/assets/app-1.js'),
      { url: '/assets/app-2.js', bytes: new TextEncoder().encode('js2') },
    ]);
    await b.install();
    expect(entries(a)).not.toEqual(entries(b));
    expect(entries(b)).toContain('/assets/app-2.js');
  });
});
