import { useEffect, useMemo, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { moviesKey, outboxKey } from '@/app/privateKey';
import { useMovieRepository } from '@/app/repository';
import { useRuntime } from '@/app/runtime';
import { useSession } from '@/app/session';
import { createOutboxSync } from '@/data/sync/flushOutbox';
import { SyncContext, type SyncControls } from './syncContext';
import { useOutboxEntries } from './useOutbox';

/** While changes are waiting, try again this often (a reconnect or a return to the app tries at once). */
const RETRY_MS = 30_000;

/**
 * Sends the changes made offline whenever it might work: when the app opens, when the connection
 * comes back, when the person returns to the tab, after a change is queued, and on a timer while
 * anything is still waiting. Bound to the account it started under; once that account is gone it
 * sends nothing and applies nothing.
 */
export function SyncProvider({ children }: { readonly children: ReactNode }) {
  const { outbox } = useRuntime();
  const repository = useMovieRepository();
  const { userId, isCurrent } = useSession();
  const queryClient = useQueryClient();
  const entries = useOutboxEntries();
  const waiting = entries.some((entry) => entry.state === 'pending');

  const sync = useMemo(() => {
    if (!outbox) return null;
    return createOutboxSync({
      repository,
      store: outbox,
      userId,
      isCurrent,
      onFinished: (outcome) => {
        if (!isCurrent()) return;
        // Refresh the library FIRST, then the waiting list: dropping a change from the list before
        // the library has caught up would make the title blink out and back.
        const changed = outcome.applied > 0 || outcome.needAttention > 0;
        void (
          changed
            ? queryClient.invalidateQueries({ queryKey: moviesKey(userId) })
            : Promise.resolve()
        ).finally(() => {
          if (isCurrent()) void queryClient.invalidateQueries({ queryKey: outboxKey(userId) });
        });
      },
    });
  }, [outbox, repository, userId, isCurrent, queryClient]);

  const controls = useMemo<SyncControls>(
    () => ({
      requestFlush: () => {
        if (sync && navigator.onLine) void sync.flush();
      },
    }),
    [sync],
  );

  useEffect(() => {
    if (!sync) return undefined;
    const run = () => {
      controls.requestFlush();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    run();
    window.addEventListener('online', run);
    document.addEventListener('visibilitychange', onVisible);
    const timer = waiting ? setInterval(run, RETRY_MS) : undefined;
    return () => {
      window.removeEventListener('online', run);
      document.removeEventListener('visibilitychange', onVisible);
      if (timer !== undefined) clearInterval(timer);
    };
  }, [sync, controls, waiting]);

  return <SyncContext value={controls}>{children}</SyncContext>;
}
