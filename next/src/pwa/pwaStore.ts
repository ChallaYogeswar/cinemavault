/**
 * What the page needs to know about the installed-app machinery: is a new version waiting, and
 * can the browser install us. A tiny external store so React reads it with useSyncExternalStore.
 */
export interface PwaState {
  /** A new version has been downloaded and is waiting for the user to reload into it. */
  readonly updateReady: boolean;
  /** The browser offered an install prompt we are holding back until the user asks. */
  readonly canInstall: boolean;
  /** Running as an installed app (standalone window) or just installed. */
  readonly installed: boolean;
}

export interface PwaStore {
  getState(): PwaState;
  subscribe(listener: () => void): () => void;
  /** Ask the waiting worker to take over, then reload when it has. No-op if nothing is waiting. */
  applyUpdate(): void;
  /** Show the browser's install dialog. Resolves with what the user chose. */
  promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

/** The (non-standard, Chromium) install event. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed' }>;
}

export interface PwaEnvironment {
  readonly navigator: Pick<Navigator, 'serviceWorker'> & { standalone?: boolean };
  readonly window: Pick<Window, 'addEventListener' | 'removeEventListener' | 'matchMedia'>;
  readonly document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  readonly reload: () => void;
  readonly setInterval: (run: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

const INITIAL: PwaState = { updateReady: false, canInstall: false, installed: false };

export function createPwaStore(): PwaStore & {
  /** Wire the browser into the store. Returns a teardown. */
  start(env: PwaEnvironment, options: { readonly registerWorker: boolean }): () => void;
} {
  let state = INITIAL;
  const listeners = new Set<() => void>();
  let waiting: ServiceWorker | null = null;
  let installEvent: BeforeInstallPromptEvent | null = null;
  let reloadWhenControlled = false;
  let reload: () => void = () => undefined;

  const set = (patch: Partial<PwaState>) => {
    const next = { ...state, ...patch };
    if (
      next.updateReady === state.updateReady &&
      next.canInstall === state.canInstall &&
      next.installed === state.installed
    )
      return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    applyUpdate() {
      if (!waiting) return;
      reloadWhenControlled = true;
      waiting.postMessage({ type: 'SKIP_WAITING' });
    },
    async promptInstall() {
      const event = installEvent;
      if (!event) return 'unavailable';
      // The event is single-use whatever the user answers.
      installEvent = null;
      set({ canInstall: false });
      try {
        await event.prompt();
        const choice = await event.userChoice;
        return choice.outcome;
      } catch {
        return 'unavailable';
      }
    },
    start(env, options) {
      reload = env.reload;
      const cleanups: (() => void)[] = [];
      let stopped = false;

      const standalone =
        env.window.matchMedia('(display-mode: standalone)').matches ||
        env.navigator.standalone === true;
      if (standalone) set({ installed: true });

      const onBeforeInstall = (event: Event) => {
        event.preventDefault(); // we show our own button, from Settings
        installEvent = event as BeforeInstallPromptEvent;
        set({ canInstall: true });
      };
      const onInstalled = () => {
        installEvent = null;
        set({ canInstall: false, installed: true });
      };
      env.window.addEventListener('beforeinstallprompt', onBeforeInstall);
      env.window.addEventListener('appinstalled', onInstalled);
      cleanups.push(() => {
        env.window.removeEventListener('beforeinstallprompt', onBeforeInstall);
        env.window.removeEventListener('appinstalled', onInstalled);
      });

      const container = options.registerWorker ? env.navigator.serviceWorker : undefined;
      if (container) {
        // Only an explicit "Reload" press swaps versions. The first install also fires
        // controllerchange (the new worker claims the page) and must never reload anything.
        const onControllerChange = () => {
          if (reloadWhenControlled) {
            reloadWhenControlled = false;
            reload();
          }
        };
        container.addEventListener('controllerchange', onControllerChange);
        cleanups.push(() => {
          container.removeEventListener('controllerchange', onControllerChange);
        });

        const watch = (registration: ServiceWorkerRegistration) => {
          // Registration is asynchronous: if the store was stopped meanwhile, attach nothing.
          if (stopped) return;
          const markIfWaiting = () => {
            // "Waiting" with no controller is the first install: nothing to update from.
            if (registration.waiting && container.controller) {
              waiting = registration.waiting;
              set({ updateReady: true });
            }
          };
          markIfWaiting();

          const onStateChange = (event: Event) => {
            if ((event.target as ServiceWorker).state === 'installed') markIfWaiting();
          };
          let watched: ServiceWorker | null = null;
          const onUpdateFound = () => {
            watched?.removeEventListener('statechange', onStateChange);
            watched = registration.installing;
            watched?.addEventListener('statechange', onStateChange);
          };
          registration.addEventListener('updatefound', onUpdateFound);

          const check = () => {
            registration.update().catch(() => undefined); // offline or a bad deploy: try later
          };
          const onVisibility = () => {
            if (env.document.visibilityState === 'visible') check();
          };
          env.document.addEventListener('visibilitychange', onVisibility);
          const timer = env.setInterval(check, UPDATE_CHECK_INTERVAL_MS);

          cleanups.push(() => {
            registration.removeEventListener('updatefound', onUpdateFound);
            watched?.removeEventListener('statechange', onStateChange);
            env.document.removeEventListener('visibilitychange', onVisibility);
            env.clearInterval(timer);
          });
        };

        container
          .register('/sw.js', { scope: '/' })
          .then(watch)
          .catch((error: unknown) => {
            // The app works without a worker; only offline start-up is lost.
            console.warn('Service worker registration failed', error);
          });
      }

      return () => {
        stopped = true;
        for (const cleanup of cleanups.splice(0)) cleanup();
      };
    },
  };
}

/** The app-wide instance. Tests build their own with createPwaStore(). */
export const pwaStore = createPwaStore();
