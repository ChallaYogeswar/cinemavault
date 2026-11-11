import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { privateKey } from '@/app/privateKey';
import { useRuntime } from '@/app/runtime';
import { useSession } from '@/app/session';
import { Button } from '@/components/ui/Button';
import { HISTORY_LIMIT } from '@/data/local/deviceData';
import { card } from './cardStyle';

/**
 * What this device keeps for this account besides the saved copy of the library: what Discover
 * showed lately and the poster and trailer lookups. Both can be cleared at any time; the library
 * itself is never touched here.
 */
export function DeviceDataCard() {
  const { history, metadata, snoozes } = useRuntime();
  const { userId, isCurrent } = useSession();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'history' | 'lookups' | 'hidden' | null>(null);

  const recent = useQuery({
    queryKey: privateKey(userId, 'history'),
    enabled: history !== null,
    staleTime: Infinity,
    queryFn: async () => (history ? history.recent(userId, HISTORY_LIMIT) : []),
  });

  const hiddenIds = useQuery({
    queryKey: privateKey(userId, 'snoozed'),
    enabled: snoozes !== null,
    staleTime: Infinity,
    queryFn: async () => (snoozes ? snoozes.active(userId, new Date()) : []),
  });

  if (!history && !metadata && !snoozes) return null;

  const run = async (which: 'history' | 'lookups' | 'hidden') => {
    setNotice(null);
    setBusy(which);
    if (which === 'hidden') {
      await snoozes?.clear(userId);
      if (!isCurrent()) return;
      queryClient.setQueryData(privateKey(userId, 'snoozed'), []);
      setNotice('Hidden titles are back in your suggestions.');
    } else if (which === 'history') {
      await history?.clear(userId);
      if (!isCurrent()) return;
      queryClient.setQueryData(privateKey(userId, 'history'), []);
      setNotice('Suggestion history cleared.');
    } else {
      await metadata?.clear(userId);
      if (!isCurrent()) return;
      queryClient.removeQueries({ queryKey: privateKey(userId, 'metadata') });
      queryClient.removeQueries({ queryKey: privateKey(userId, 'trailer') });
      setNotice('Saved posters and trailers cleared. They will be looked up again when needed.');
    }
    setBusy(null);
  };

  const count = recent.data?.length ?? 0;
  return (
    <div className={card}>
      <h2 className="font-serif text-2xl">On this device</h2>
      <p className="text-muted mt-2 text-sm">
        Your library is saved here so it opens offline. These extras are only conveniences and are
        removed when you sign out.
      </p>
      {history ? (
        <div className="mt-4">
          <p className="text-sm">
            Suggestion history:{' '}
            <b>
              {recent.isPending ? '…' : `${String(count)} ${count === 1 ? 'entry' : 'entries'}`}
            </b>
          </p>
          <p className="text-dim mt-1 text-xs">
            Discover uses it to avoid repeating itself. Clearing it makes suggestions start fresh.
          </p>
          <Button
            className="mt-2"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => {
              void run('history');
            }}
          >
            {busy === 'history' ? 'Clearing…' : 'Clear suggestion history'}
          </Button>
        </div>
      ) : null}
      {snoozes ? (
        <div className="mt-5">
          <p className="text-sm">
            Hidden from Discover:{' '}
            <b>{hiddenIds.isPending ? '…' : `${String(hiddenIds.data?.length ?? 0)} titles`}</b>
          </p>
          <p className="text-dim mt-1 text-xs">
            Titles you chose “Not now” for come back by themselves after a week.
          </p>
          <Button
            className="mt-2"
            variant="secondary"
            disabled={busy !== null || (hiddenIds.data?.length ?? 0) === 0}
            onClick={() => {
              void run('hidden');
            }}
          >
            {busy === 'hidden' ? 'Restoring…' : 'Show hidden titles again'}
          </Button>
        </div>
      ) : null}
      {metadata ? (
        <div className="mt-5">
          <p className="text-dim text-xs">
            Posters and trailer links found for your titles. Clearing them makes the app look them
            up again.
          </p>
          <Button
            className="mt-2"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => {
              void run('lookups');
            }}
          >
            {busy === 'lookups' ? 'Clearing…' : 'Clear saved posters and trailers'}
          </Button>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="text-muted mt-4 text-sm">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
