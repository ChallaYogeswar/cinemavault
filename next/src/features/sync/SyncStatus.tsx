import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { moviesKey, outboxKey } from '@/app/privateKey';
import { useMovieRepository } from '@/app/repository';
import { useRuntime } from '@/app/runtime';
import { useSession } from '@/app/session';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import type { OutboxEntry } from '@/domain/outbox';
import { useSync } from './syncContext';
import { useOutboxEntries } from './useOutbox';

const KIND_LABEL: Record<OutboxEntry['kind'], string> = {
  create: 'Add',
  update: 'Edit',
  delete: 'Delete',
};

/** What "keep mine" does, in the person's words. */
const KEEP_LABEL: Record<OutboxEntry['kind'], string> = {
  create: 'Try adding again',
  update: 'Keep my version',
  delete: 'Delete anyway',
};

const DISCARD_LABEL: Record<OutboxEntry['kind'], string> = {
  create: 'Discard',
  update: 'Use the other version',
  delete: 'Keep the title',
};

function ReviewDialog({ onClose }: { readonly onClose: () => void }) {
  const { outbox } = useRuntime();
  const repository = useMovieRepository();
  const { userId, isCurrent } = useSession();
  const queryClient = useQueryClient();
  const sync = useSync();
  const entries = useOutboxEntries().filter((entry) => entry.state === 'attention');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = async () => {
    if (!outbox || !isCurrent()) return;
    queryClient.setQueryData(outboxKey(userId), await outbox.list(userId));
    void queryClient.invalidateQueries({ queryKey: moviesKey(userId) });
  };

  const discard = async (entry: OutboxEntry) => {
    if (!outbox) return;
    setBusy(entry.movieId);
    setProblem(null);
    await outbox.discard(userId, entry.movieId);
    await refresh();
    setBusy(null);
  };

  /**
   * Keep what the person did, on purpose: re-based onto the version the server holds RIGHT NOW, so
   * it replaces the other change knowingly. Needs the server, because the version must be current.
   */
  const keepMine = async (entry: OutboxEntry) => {
    if (!outbox) return;
    setBusy(entry.movieId);
    setProblem(null);
    let base: string | null = null;
    if (entry.kind !== 'create') {
      const current = await repository.get(entry.movieId);
      if (!isCurrent()) return;
      if (!current.ok) {
        setProblem(
          current.error.code === 'not_found'
            ? `“${entry.title}” no longer exists, so your version can’t replace it. Discard it instead.`
            : 'Couldn’t reach the server. Try again when you’re online.',
        );
        setBusy(null);
        return;
      }
      base = current.value.updatedAt;
    }
    const kept = await outbox.keepMine(userId, entry.movieId, base);
    if (!kept) setProblem('That change could not be kept. Nothing was lost; try again.');
    await refresh();
    sync.requestFlush();
    setBusy(null);
  };

  return (
    <Dialog title="Sync issues" eyebrow="Needs your decision" size="lg" onClose={onClose}>
      {entries.length === 0 ? (
        <p className="text-muted text-sm">Nothing needs a decision.</p>
      ) : (
        <ul className="space-y-4">
          {entries.map((entry) => (
            <li key={entry.movieId} className="border-line rounded-2xl border p-4">
              <p className="font-semibold">
                {KIND_LABEL[entry.kind]}: {entry.title}
              </p>
              <p className="text-muted mt-1 text-sm">
                {entry.message ?? 'This change was not saved.'}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {entry.reason === 'gone' || entry.reason === 'refused' ? null : (
                  <Button
                    variant="primary"
                    disabled={busy !== null}
                    onClick={() => {
                      void keepMine(entry);
                    }}
                  >
                    {KEEP_LABEL[entry.kind]}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => {
                    void discard(entry);
                  }}
                >
                  {DISCARD_LABEL[entry.kind]}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {problem ? (
        <p role="alert" className="text-danger mt-4 text-sm">
          {problem}
        </p>
      ) : null}
    </Dialog>
  );
}

/**
 * Says, on every screen, that changes made on this device have not reached the server yet, and
 * opens the screen where the ones that need a decision are settled. Silent when nothing is waiting.
 */
export function SyncStatus() {
  const entries = useOutboxEntries();
  const sync = useSync();
  const [reviewing, setReviewing] = useState(false);
  const waiting = entries.filter((entry) => entry.state === 'pending').length;
  const attention = entries.length - waiting;
  if (entries.length === 0) return null;

  return (
    <>
      {waiting > 0 ? (
        <div
          role="status"
          className="bg-gold/15 text-gold flex flex-wrap items-center justify-center gap-3 px-4 py-2 text-center text-sm"
        >
          <span>
            {waiting === 1
              ? '1 change is saved on this device and waiting to sync.'
              : `${String(waiting)} changes are saved on this device and waiting to sync.`}
          </span>
          <Button variant="secondary" onClick={sync.requestFlush}>
            Sync now
          </Button>
        </div>
      ) : null}
      {attention > 0 ? (
        <div
          role="alert"
          className="bg-danger/10 flex flex-wrap items-center justify-center gap-3 px-4 py-2 text-center text-sm"
        >
          <span>
            {attention === 1
              ? '1 change needs your decision.'
              : `${String(attention)} changes need your decision.`}
          </span>
          <Button
            variant="secondary"
            onClick={() => {
              setReviewing(true);
            }}
          >
            Review
          </Button>
        </div>
      ) : null}
      {reviewing ? (
        <ReviewDialog
          onClose={() => {
            setReviewing(false);
          }}
        />
      ) : null}
    </>
  );
}
