import { useQuery } from '@tanstack/react-query';
import { outboxKey } from '@/app/privateKey';
import { useRuntime } from '@/app/runtime';
import { useSession } from '@/app/session';
import type { OutboxEntry } from '@/domain/outbox';

const NONE: readonly OutboxEntry[] = [];

/**
 * The changes made on this device that the server has not accepted yet (empty on sample data).
 * Read from the device once and kept in step by whoever changes it (queueing, the sync run, the
 * review screen), so every screen sees the same list.
 */
export function useOutboxEntries(): readonly OutboxEntry[] {
  const { outbox } = useRuntime();
  const { userId } = useSession();
  const query = useQuery({
    queryKey: outboxKey(userId),
    enabled: outbox !== null,
    staleTime: Infinity,
    queryFn: async (): Promise<readonly OutboxEntry[]> => (outbox ? outbox.list(userId) : NONE),
  });
  return query.data ?? NONE;
}
