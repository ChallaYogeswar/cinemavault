import { describe, expect, it, vi } from 'vitest';
import {
  UPDATE_CHECK_INTERVAL_MS,
  createPwaStore,
  type BeforeInstallPromptEvent,
  type PwaEnvironment,
} from '@/pwa/pwaStore';

class FakeWorker extends EventTarget {
  state: ServiceWorkerState = 'installing';
  readonly messages: unknown[] = [];
  postMessage(message: unknown) {
    this.messages.push(message);
  }
}

class FakeRegistration extends EventTarget {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  updates = 0;
  failUpdate = false;
  update() {
    this.updates += 1;
    return this.failUpdate ? Promise.reject(new Error('offline')) : Promise.resolve();
  }
}

class FakeContainer extends EventTarget {
  controller: object | null;
  readonly registration = new FakeRegistration();
  registered: string[] = [];
  failRegister = false;
  constructor(controlled: boolean) {
    super();
    this.controller = controlled ? {} : null;
  }
  register(url: string) {
    this.registered.push(url);
    return this.failRegister
      ? Promise.reject(new Error('blocked'))
      : Promise.resolve(this.registration);
  }
}

function setup({ controlled = true, standalone = false } = {}) {
  const container = new FakeContainer(controlled);
  const windowEvents = new EventTarget();
  const documentEvents = new EventTarget();
  const document = Object.assign(documentEvents, { visibilityState: 'visible' as const });
  const reload = vi.fn();
  const timers: (() => void)[] = [];
  const intervals: number[] = [];
  const cleared: unknown[] = [];
  const env = {
    navigator: { serviceWorker: container as unknown as ServiceWorkerContainer },
    window: {
      addEventListener: windowEvents.addEventListener.bind(windowEvents),
      removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
      matchMedia: () => ({ matches: standalone }) as MediaQueryList,
    },
    document,
    reload,
    setInterval: (run: () => void, ms: number) => {
      timers.push(run);
      intervals.push(ms);
      return timers.length;
    },
    clearInterval: (handle: unknown) => {
      cleared.push(handle);
    },
  } as unknown as PwaEnvironment;
  const store = createPwaStore();
  const stop = store.start(env, { registerWorker: true });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    store,
    stop,
    container,
    reg: container.registration,
    windowEvents,
    document,
    reload,
    timers,
    intervals,
    cleared,
    flush,
    env,
  };
}

function installEvent(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as BeforeInstallPromptEvent;
  const prompt = vi.fn(() => Promise.resolve());
  Object.assign(event, { prompt, userChoice: Promise.resolve({ outcome }) });
  return { event, prompt };
}

describe('registration', () => {
  it('registers /sw.js at the root scope', async () => {
    const t = setup();
    await t.flush();
    expect(t.container.registered).toEqual(['/sw.js']);
  });

  it('does not register when told not to (development builds)', async () => {
    const t = setup();
    const container = new FakeContainer(true);
    const store = createPwaStore();
    store.start(
      { ...t.env, navigator: { serviceWorker: container as never } },
      { registerWorker: false },
    );
    await t.flush();
    expect(container.registered).toEqual([]);
  });

  it('survives a failed registration: the app simply has no offline start-up', async () => {
    const t = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const container = new FakeContainer(true);
    container.failRegister = true;
    const store = createPwaStore();
    store.start(
      { ...t.env, navigator: { serviceWorker: container as never } },
      { registerWorker: true },
    );
    await t.flush();
    expect(store.getState().updateReady).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

describe('updates', () => {
  it('first install is not an "update": nothing to offer, nothing reloads', async () => {
    const t = setup({ controlled: false });
    await t.flush();
    t.reg.waiting = new FakeWorker();
    t.reg.installing = t.reg.waiting;
    t.reg.dispatchEvent(new Event('updatefound'));
    t.reg.installing.state = 'installed';
    t.reg.installing.dispatchEvent(new Event('statechange'));
    expect(t.store.getState().updateReady).toBe(false);
    t.container.dispatchEvent(new Event('controllerchange')); // the new worker claiming the page
    expect(t.reload).not.toHaveBeenCalled();
  });

  it('offers a new version once it has finished installing', async () => {
    const t = setup();
    await t.flush();
    const worker = new FakeWorker();
    t.reg.installing = worker;
    t.reg.dispatchEvent(new Event('updatefound'));
    expect(t.store.getState().updateReady).toBe(false); // still downloading
    worker.state = 'installed';
    t.reg.waiting = worker;
    worker.dispatchEvent(new Event('statechange'));
    expect(t.store.getState().updateReady).toBe(true);
  });

  it('notices a version that was already waiting when the page opened', async () => {
    const t = setup();
    t.reg.waiting = new FakeWorker();
    await t.flush();
    const store = createPwaStore();
    store.start(t.env, { registerWorker: true });
    await t.flush();
    expect(store.getState().updateReady).toBe(true);
  });

  it('reloads only after the user asks and the new worker has taken over', async () => {
    const t = setup();
    await t.flush();
    const worker = new FakeWorker();
    t.reg.waiting = worker;
    t.reg.installing = worker;
    t.reg.dispatchEvent(new Event('updatefound'));
    worker.state = 'installed';
    worker.dispatchEvent(new Event('statechange'));

    t.container.dispatchEvent(new Event('controllerchange'));
    expect(t.reload).not.toHaveBeenCalled(); // nobody asked

    t.store.applyUpdate();
    expect(worker.messages).toEqual([{ type: 'SKIP_WAITING' }]);
    expect(t.reload).not.toHaveBeenCalled(); // not until the swap actually happens
    t.container.dispatchEvent(new Event('controllerchange'));
    expect(t.reload).toHaveBeenCalledTimes(1);
    t.container.dispatchEvent(new Event('controllerchange'));
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it('applyUpdate with nothing waiting does nothing', () => {
    const t = setup();
    t.store.applyUpdate();
    t.container.dispatchEvent(new Event('controllerchange'));
    expect(t.reload).not.toHaveBeenCalled();
  });

  it('checks for a new version when the app comes to the foreground and hourly, ignoring failures', async () => {
    const t = setup();
    await t.flush();
    t.document.dispatchEvent(new Event('visibilitychange'));
    expect(t.reg.updates).toBe(1);
    t.reg.failUpdate = true;
    t.timers[0]?.();
    await t.flush();
    expect(t.reg.updates).toBe(2);
    expect(t.intervals).toEqual([UPDATE_CHECK_INTERVAL_MS]);
  });

  it('stop() detaches EVERY listener and clears the hourly check', async () => {
    const t = setup();
    await t.flush();
    const worker = new FakeWorker();
    t.reg.installing = worker;
    t.reg.dispatchEvent(new Event('updatefound')); // a statechange listener is now attached too
    t.stop();

    expect(t.cleared).toEqual([1]); // the interval handed out by setInterval

    const updatesBefore = t.reg.updates;
    t.document.dispatchEvent(new Event('visibilitychange'));
    expect(t.reg.updates).toBe(updatesBefore); // foreground check is gone

    worker.state = 'installed';
    t.reg.waiting = worker;
    worker.dispatchEvent(new Event('statechange'));
    expect(t.store.getState().updateReady).toBe(false); // statechange listener is gone

    const second = new FakeWorker();
    t.reg.installing = second;
    t.reg.dispatchEvent(new Event('updatefound'));
    second.state = 'installed';
    second.dispatchEvent(new Event('statechange'));
    expect(t.store.getState().updateReady).toBe(false); // updatefound listener is gone

    t.container.dispatchEvent(new Event('controllerchange'));
    t.windowEvents.dispatchEvent(installEvent().event);
    expect(t.reload).not.toHaveBeenCalled();
    expect(t.store.getState().canInstall).toBe(false);
  });

  it('stop() while an update is being applied means the page is never reloaded afterwards', async () => {
    const t = setup();
    await t.flush();
    const worker = new FakeWorker();
    t.reg.installing = worker;
    t.reg.dispatchEvent(new Event('updatefound'));
    worker.state = 'installed';
    t.reg.waiting = worker;
    worker.dispatchEvent(new Event('statechange'));
    t.store.applyUpdate();
    t.stop();
    t.container.dispatchEvent(new Event('controllerchange'));
    expect(t.reload).not.toHaveBeenCalled();
  });

  it('stop() before the registration has finished attaches nothing afterwards', async () => {
    const t = setup();
    t.stop(); // register() has been called but its promise has not been handled yet
    await t.flush();
    t.document.dispatchEvent(new Event('visibilitychange'));
    expect(t.reg.updates).toBe(0);
    expect(t.intervals).toEqual([]);
  });

  it('stop() is safe to call twice', async () => {
    const t = setup();
    await t.flush();
    t.stop();
    expect(() => {
      t.stop();
    }).not.toThrow();
    expect(t.cleared).toHaveLength(1);
  });

  it('a second update found while the first is still installing does not leave two listeners', async () => {
    const t = setup();
    await t.flush();
    const first = new FakeWorker();
    t.reg.installing = first;
    t.reg.dispatchEvent(new Event('updatefound'));
    const second = new FakeWorker();
    t.reg.installing = second;
    t.reg.dispatchEvent(new Event('updatefound'));
    // The superseded worker finishing must not be mistaken for the current one.
    first.state = 'installed';
    t.reg.waiting = first; // would be offered if the old listener were still attached
    first.dispatchEvent(new Event('statechange'));
    expect(t.store.getState().updateReady).toBe(false);
  });
});

describe('installing as an app', () => {
  it('holds the browser prompt back until the user asks', () => {
    const t = setup();
    const { event, prompt } = installEvent();
    t.windowEvents.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(t.store.getState().canInstall).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('shows the dialog on request and reports the answer; the prompt is single-use', async () => {
    const t = setup();
    const { event, prompt } = installEvent('dismissed');
    t.windowEvents.dispatchEvent(event);
    await expect(t.store.promptInstall()).resolves.toBe('dismissed');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(t.store.getState().canInstall).toBe(false);
    await expect(t.store.promptInstall()).resolves.toBe('unavailable');
  });

  it('says "unavailable" when the browser never offered one', async () => {
    await expect(setup().store.promptInstall()).resolves.toBe('unavailable');
  });

  it('marks the app as installed after the browser says so, and when already running standalone', () => {
    const t = setup();
    t.windowEvents.dispatchEvent(installEvent().event);
    t.windowEvents.dispatchEvent(new Event('appinstalled'));
    expect(t.store.getState()).toMatchObject({ canInstall: false, installed: true });
    expect(setup({ standalone: true }).store.getState().installed).toBe(true);
  });

  it('notifies subscribers once per real change', () => {
    const t = setup();
    const listener = vi.fn();
    const off = t.store.subscribe(listener);
    t.windowEvents.dispatchEvent(installEvent().event);
    t.windowEvents.dispatchEvent(installEvent().event); // same state again
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    t.windowEvents.dispatchEvent(new Event('appinstalled'));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
