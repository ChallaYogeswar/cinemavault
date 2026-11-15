import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActiveUserStore } from '@/app/activeUser';
import { RepositoryContext } from '@/app/repository';
import { RuntimeContext, type Runtime } from '@/app/runtime';
import { SessionProvider } from '@/app/SessionProvider';
import { createDexieDeviceStore } from '@/data/local/dexieLibraryCache';
import type { OutboxStore } from '@/data/local/outboxStore';
import { MOCK_OWNER_ID, createSeedMovies, fixtureId } from '@/data/mock/fixtures';
import { createMockMovieRepository } from '@/data/mock/mockMovieRepository';
import type { MovieRepository } from '@/data/repositories/movieRepository';
import type { Movie } from '@/domain/movie';
import { EMPTY_MOVIE_INPUT } from '@/domain/movieInput';
import type { Role } from '@/domain/permissions';
import type { Result } from '@/domain/result';
import { SyncProvider } from '@/features/sync/SyncProvider';
import { useQueueing } from '@/features/sync/useQueueing';

/**
 * The sync layer on its own: WHEN waiting changes are sent, and the rules for queueing one,
 * without the rest of the application around it.
 */
const USER = MOCK_OWNER_ID;
const OTHER = fixtureId(0xb0b);
const input = (title: string) => ({ ...EMPTY_MOVIE_INPUT, title, year: 2024 });

let factory: IDBFactory;
let device: ReturnType<typeof createDexieDeviceStore>;
let server: ReturnType<typeof createMockMovieRepository>;
let sends: number;
let down: boolean;

const repository = (): MovieRepository => ({
  ...server,
  create: (value, options) => {
    sends += 1;
    return down
      ? Promise.resolve({ ok: false, error: { code: 'network', message: 'offline' } } as const)
      : server.create(value, options);
  },
});

interface Captured {
  current: ReturnType<typeof useQueueing> | null;
}
function Probe({
  intoRef,
}: {
  readonly intoRef: { current: ReturnType<typeof useQueueing> | null };
}) {
  const queueing = useQueueing();
  useEffect(() => {
    intoRef.current = queueing;
  }, [intoRef, queueing]);
  return null;
}

const mount = (options: { role?: Role; outbox?: OutboxStore; captured?: Captured } = {}) => {
  const store = createActiveUserStore(USER);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const runtime: Runtime = {
    kind: 'supabase',
    repositoryFor: () => repository(),
    libraryCache: device.library,
    history: null,
    snoozes: null,
    metadata: null,
    profiles: null,
    outbox: options.outbox ?? device.outbox,
    roles: device.roles,
  };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RuntimeContext value={runtime}>
        <SessionProvider store={store} role={options.role ?? 'owner'}>
          <RepositoryContext value={repository()}>
            <SyncProvider>
              <Probe intoRef={options.captured ?? { current: null }} />
            </SyncProvider>
          </RepositoryContext>
        </SessionProvider>
      </RuntimeContext>
    </QueryClientProvider>,
  );
  return { ...view, store, queryClient };
};

const waiting = (id: string, title: string) =>
  device.outbox.enqueue(USER, { kind: 'create', movieId: id, input: input(title) }, new Date());
const titles = () => server.snapshot().map((m: Movie) => m.title);

beforeEach(() => {
  factory = new IDBFactory();
  device = createDexieDeviceStore({ indexedDB: factory, IDBKeyRange });
  server = createMockMovieRepository({ seed: createSeedMovies(USER) });
  sends = 0;
  down = false;
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('when waiting changes are sent', () => {
  it('as soon as the app opens', async () => {
    await waiting(fixtureId(901), 'Waiting At Start');
    mount();
    await waitFor(() => {
      expect(titles()).toContain('Waiting At Start');
    });
  });

  it('when the connection returns (the browser’s online event), not before', async () => {
    down = true;
    await waiting(fixtureId(901), 'Waits For Online');
    mount();
    await waitFor(() => {
      expect(sends).toBeGreaterThan(0);
    });
    const tried = sends;
    expect(titles()).not.toContain('Waits For Online');
    down = false;
    expect(sends).toBe(tried); // nothing is sent on its own just because the server is back
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => {
      expect(titles()).toContain('Waits For Online');
    });
  });

  it('when the person returns to the tab', async () => {
    down = true;
    await waiting(fixtureId(901), 'Waits For Tab');
    mount();
    await waitFor(() => {
      expect(sends).toBeGreaterThan(0);
    });
    down = false;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => {
      expect(titles()).toContain('Waits For Tab');
    });
  });

  it('on a timer while something is still waiting', async () => {
    down = true;
    await waiting(fixtureId(901), 'Waits For Timer');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    await vi.waitFor(() => {
      expect(sends).toBeGreaterThan(0);
    });
    down = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    await vi.waitFor(() => {
      expect(titles()).toContain('Waits For Timer');
    });
  });

  it('not while the browser says it is offline (nothing to gain, battery to lose)', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await waiting(fixtureId(901), 'Offline Now');
    mount();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sends).toBe(0);
  });

  it('never after the account that queued it is gone', async () => {
    down = true;
    await waiting(fixtureId(901), 'Belongs To Earlier Account');
    const { store } = mount();
    await waitFor(() => {
      expect(sends).toBeGreaterThan(0);
    });
    act(() => {
      store.set(OTHER);
    });
    down = false;
    const before = sends;
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(titles()).not.toContain('Belongs To Earlier Account');
    expect(sends).toBe(before);
  });
});

describe('queueing a change', () => {
  const ID = fixtureId(950);

  it('a view-only account can never queue anything', async () => {
    const captured: Captured = { current: null };
    mount({ role: 'viewer', captured });
    const q = captured.current;
    if (!q) throw new Error('probe');
    for (const result of [
      await q.create(ID, input('Nope')),
      await q.update(ID, input('Nope'), 'v1'),
      await q.remove(ID, 'v1'),
    ] as Result<unknown>[]) {
      expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    }
    expect(await device.outbox.list(USER)).toEqual([]);
  });

  it('invalid values are refused before anything is kept', async () => {
    const captured: Captured = { current: null };
    mount({ captured });
    const result = await captured.current?.create(ID, { ...input(''), title: '' });
    expect(result).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await device.outbox.list(USER)).toEqual([]);
  });

  it('says plainly that NOTHING was saved when the device could not keep the change', async () => {
    const broken: OutboxStore = {
      ...device.outbox,
      enqueue: () => Promise.resolve({ ok: false, reason: 'unavailable' }),
    };
    const captured: Captured = { current: null };
    mount({ outbox: broken, captured });
    const result = await captured.current?.create(ID, input('Cannot Keep'));
    expect(result).toMatchObject({ ok: false, error: { code: 'network' } });
    expect(result?.ok === false && result.error.message).toMatch(/nothing was saved/i);
  });

  it('a change to a title that waits for a decision is refused with a pointer to the review screen', async () => {
    const queued = await device.outbox.enqueue(
      USER,
      { kind: 'update', movieId: ID, input: input('A'), baseUpdatedAt: 'v1' },
      new Date(),
    );
    if (!queued.ok || !queued.entry) throw new Error('queued');
    await device.outbox.needsAttention(USER, ID, queued.entry.rev, 'changed', 'm');
    const captured: Captured = { current: null };
    mount({ captured });
    const result = await captured.current?.update(ID, input('B'), 'v1');
    expect(result).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(result?.ok === false && result.error.message).toMatch(/sync issues/i);
  });

  it('a successful queue reports itself as queued, with the values the person will see', async () => {
    down = true;
    const captured: Captured = { current: null };
    mount({ captured });
    const result = await captured.current?.create(ID, input('Queued Title'));
    expect(result).toMatchObject({
      ok: true,
      queued: true,
      value: { id: ID, title: 'Queued Title' },
    });
  });
});
