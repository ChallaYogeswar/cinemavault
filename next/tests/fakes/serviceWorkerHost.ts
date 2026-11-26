import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderServiceWorker, type ShellFile } from '../../vite-plugins/pwa';

const ORIGIN = 'https://cinemavault.test';
const enc = (text: string) => new TextEncoder().encode(text);

export const SHELL: readonly ShellFile[] = [
  { url: '/index.html', bytes: enc('<html>shell</html>') },
  { url: '/assets/app-1.js', bytes: enc('js') },
  { url: '/assets/app-1.css', bytes: enc('css') },
  { url: '/manifest.webmanifest', bytes: enc('{}') },
];

type Handler = (event: unknown) => void;

/** A fake Cache Storage keyed by cache name, then by URL path. */
class FakeCaches {
  readonly stores = new Map<string, Map<string, Response>>();
  readonly writes: string[] = [];

  open = (name: string) => {
    let store = this.stores.get(name);
    if (!store) {
      store = new Map();
      this.stores.set(name, store);
    }
    const target = store;
    return Promise.resolve({
      put: (request: string | Request, response: Response) => {
        const path = pathOf(request);
        this.writes.push(`${name}:${path}`);
        target.set(path, response);
        return Promise.resolve();
      },
    });
  };
  keys = () => Promise.resolve([...this.stores.keys()]);
  delete = (name: string) => Promise.resolve(this.stores.delete(name));
  match = (request: string | Request, options?: { cacheName?: string }) => {
    const path = pathOf(request);
    const names = options?.cacheName ? [options.cacheName] : [...this.stores.keys()];
    for (const name of names) {
      const hit = this.stores.get(name)?.get(path);
      if (hit) return Promise.resolve(hit.clone());
    }
    return Promise.resolve(undefined);
  };
}

/** In a worker, a relative URL resolves against the worker's own origin. */
class WorkerRequest extends Request {
  constructor(input: string | URL | Request, init?: RequestInit) {
    super(typeof input === 'string' ? new URL(input, ORIGIN).href : input, init);
  }
}

function pathOf(request: string | Request): string {
  return new URL(typeof request === 'string' ? request : request.url, ORIGIN).pathname;
}

export interface NetworkCall {
  readonly url: string;
  readonly cache: string;
}

export interface Host {
  readonly caches: FakeCaches;
  readonly network: NetworkCall[];
  online: boolean;
  /** What the "server" answers, by path; defaults to 200 with the path as the body. */
  respond: (path: string) => Response;
  skipWaitingCalls: number;
  claimCalls: number;
  install(): Promise<void>;
  activate(): Promise<void>;
  message(data: unknown): void;
  /** Dispatches a fetch. `handled` is false when the worker stayed out of it. */
  fetch(
    url: string,
    init?: { method?: string; mode?: RequestMode },
  ): Promise<{ handled: boolean; response?: Response }>;
}

export function startServiceWorker(
  shell: readonly ShellFile[] = SHELL,
  templatePath = 'pwa/sw.template.js',
): Host {
  const handlers = new Map<string, Handler>();
  const caches = new FakeCaches();
  const host: Host = {
    caches,
    network: [],
    online: true,
    respond: (path) => new Response(`network:${path}`, { status: 200 }),
    skipWaitingCalls: 0,
    claimCalls: 0,
    install: () => run('install'),
    activate: () => run('activate'),
    message: (data) => handlers.get('message')?.({ data }),
    async fetch(url, init = {}) {
      const request = new Request(new URL(url, ORIGIN), { method: init.method ?? 'GET' });
      // `mode` cannot be set to "navigate" through the constructor; the worker only reads it.
      Object.defineProperty(request, 'mode', { value: init.mode ?? 'cors' });
      let answer: Promise<Response> | undefined;
      handlers.get('fetch')?.({
        request,
        respondWith: (response: Promise<Response>) => {
          answer = response;
        },
      });
      return answer ? { handled: true, response: await answer } : { handled: false };
    },
  };

  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    skipWaiting: () => {
      host.skipWaitingCalls += 1;
      return Promise.resolve();
    },
    clients: {
      claim: () => {
        host.claimCalls += 1;
        return Promise.resolve();
      },
    },
  };
  const fetchImpl = (input: Request | string) => {
    const request = typeof input === 'string' ? new Request(new URL(input, ORIGIN)) : input;
    host.network.push({ url: request.url, cache: request.cache });
    if (!host.online) return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve(host.respond(new URL(request.url).pathname));
  };

  const source = renderServiceWorker(readFileSync(templatePath, 'utf8'), shell);
  vm.runInNewContext(source, {
    self,
    caches,
    fetch: fetchImpl,
    Request: WorkerRequest,
    Response,
    URL,
    Promise,
    Set,
    Error,
    TypeError,
  });

  function run(type: 'install' | 'activate'): Promise<void> {
    let pending: Promise<unknown> = Promise.resolve();
    handlers.get(type)?.({
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    return pending.then(() => undefined);
  }
  return host;
}
