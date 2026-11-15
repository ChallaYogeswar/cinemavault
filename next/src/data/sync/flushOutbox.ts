import type { OutboxStore } from '@/data/local/outboxStore';
import type { MovieRepository } from '@/data/repositories/movieRepository';
import { holdsValues, type AttentionReason, type OutboxEntry } from '@/domain/outbox';
import type { AppError } from '@/domain/result';

/**
 * Sends the changes made offline, one title at a time, in the order they were made.
 *
 * What makes this safe to run again and again (it will be: on reconnect, on returning to the app,
 * on a timer, and after a reply that never arrived):
 *  - a create carries the id chosen when it was queued, so a repeat can never add a second copy;
 *    if the server already has that id, the earlier attempt had in fact succeeded;
 *  - an edit or delete carries the version the person last saw, so the server refuses it (instead of
 *    overwriting) if the title changed in the meantime. That is never settled by guessing: the
 *    change is kept and flagged for the person to decide;
 *  - a delete of something already gone is a success, not an error;
 *  - only a connection problem stops the run; a change the server refuses never blocks the others.
 *
 * It never throws and never touches anything but the outbox and the repository it is given.
 */
export interface FlushOutcome {
  /** Changes the server accepted (and that were removed from the outbox). */
  readonly applied: number;
  /** Changes that now wait for the person. */
  readonly needAttention: number;
  /** Why the run stopped early, if it did. The remaining changes stay queued. */
  readonly stoppedBy: 'offline' | 'signed_out' | null;
}

interface Options {
  readonly repository: MovieRepository;
  readonly store: OutboxStore;
  readonly userId: string;
  /** False from the instant the account changes or signs out; nothing more is sent after that. */
  readonly isCurrent: () => boolean;
}

type Step =
  | { readonly kind: 'accepted'; readonly updatedAt: string | null }
  | { readonly kind: 'attention'; readonly reason: AttentionReason; readonly message: string }
  | { readonly kind: 'stop'; readonly by: 'offline' | 'signed_out' };

const attention = (reason: AttentionReason, message: string): Step => ({
  kind: 'attention',
  reason,
  message,
});

/** What a refusal means for a change that was queued. */
function refusal(entry: OutboxEntry, error: AppError): Step {
  switch (error.code) {
    case 'network':
    case 'unknown':
      return { kind: 'stop', by: 'offline' };
    case 'unauthenticated':
    case 'session_changed':
      return { kind: 'stop', by: 'signed_out' };
    case 'forbidden':
      return attention(
        'refused',
        'Your account is not allowed to make this change, so it was not saved. Your version is kept here.',
      );
    case 'validation':
      return attention('invalid', 'The server could not accept these values. Edit and try again.');
    case 'not_found':
      return attention(
        'gone',
        `“${entry.title}” was deleted somewhere else, so your change could not be applied.`,
      );
    case 'conflict':
      return error.reason === 'duplicate_identity'
        ? attention(
            'duplicate',
            `“${entry.title}” could not be saved: another title with the same name, type and year already exists.`,
          )
        : attention('changed', `“${entry.title}” was changed somewhere else after you edited it.`);
  }
}

async function send(entry: OutboxEntry, repository: MovieRepository): Promise<Step> {
  switch (entry.kind) {
    case 'create': {
      if (entry.input === null) return attention('invalid', 'Nothing to save.');
      const result = await repository.create(entry.input, { id: entry.movieId });
      if (result.ok) return { kind: 'accepted', updatedAt: result.value.updatedAt };
      if (result.error.code !== 'conflict') return refusal(entry, result.error);
      // Refused as a duplicate. If the title with OUR id is there, an earlier attempt of this very
      // change succeeded and only its reply was lost: that is success, not a duplicate.
      const existing = await repository.get(entry.movieId);
      if (existing.ok) return { kind: 'accepted', updatedAt: existing.value.updatedAt };
      if (existing.error.code === 'not_found') {
        return attention(
          'duplicate',
          `“${entry.title}” could not be added: the same title already exists, or this one was removed elsewhere.`,
        );
      }
      return refusal(entry, existing.error);
    }
    case 'update': {
      if (entry.input === null || entry.baseUpdatedAt === null) {
        return attention('invalid', 'Nothing to save.');
      }
      const result = await repository.update(entry.movieId, entry.input, entry.baseUpdatedAt);
      if (result.ok) return { kind: 'accepted', updatedAt: result.value.updatedAt };
      if (result.error.code === 'conflict' && result.error.reason === 'stale_version') {
        // Changed since we looked. If it now holds exactly our values, our own earlier attempt
        // landed and only its reply was lost: nothing to decide.
        const current = await repository.get(entry.movieId);
        if (current.ok && holdsValues(current.value, entry.input)) {
          return { kind: 'accepted', updatedAt: current.value.updatedAt };
        }
      }
      return refusal(entry, result.error);
    }
    case 'delete': {
      if (entry.baseUpdatedAt === null) return attention('invalid', 'Nothing to delete.');
      const result = await repository.remove(entry.movieId, entry.baseUpdatedAt);
      if (result.ok) return { kind: 'accepted', updatedAt: null };
      // Already deleted elsewhere: the person wanted it gone, and it is.
      if (result.error.code === 'not_found') return { kind: 'accepted', updatedAt: null };
      return refusal(entry, result.error);
    }
  }
}

export async function flushOutbox(options: Options): Promise<FlushOutcome> {
  const { repository, store, userId, isCurrent } = options;
  let applied = 0;
  let needAttention = 0;
  const entries = (await store.list(userId)).filter((entry) => entry.state === 'pending');

  for (const entry of entries) {
    if (!isCurrent()) return { applied, needAttention, stoppedBy: 'signed_out' };
    let step: Step;
    try {
      step = await send(entry, repository);
    } catch {
      step = { kind: 'stop', by: 'offline' }; // a repository must not throw; if it does, try again later
    }
    // The account may have changed while the request was out: what came back is not applied.
    if (!isCurrent()) return { applied, needAttention, stoppedBy: 'signed_out' };

    if (step.kind === 'stop') return { applied, needAttention, stoppedBy: step.by };
    if (step.kind === 'accepted') {
      await store.settle(userId, entry.movieId, entry.rev, { updatedAt: step.updatedAt });
      applied += 1;
    } else {
      await store.needsAttention(userId, entry.movieId, entry.rev, step.reason, step.message);
      needAttention += 1;
    }
  }
  return { applied, needAttention, stoppedBy: null };
}

/**
 * Wraps `flushOutbox` so that two requests to flush at once become one run followed by (at most)
 * one more: a flush that is already sending never gets a second sender racing it.
 */
export function createOutboxSync(
  options: Options & { readonly onFinished?: (o: FlushOutcome) => void },
) {
  const pending: { running: Promise<FlushOutcome> | null; again: boolean } = {
    running: null,
    again: false,
  };

  /** Read through a function: another call may set the flag during an `await`. */
  const askedAgain = (): boolean => pending.again;

  const run = async (): Promise<FlushOutcome> => {
    let total: FlushOutcome = { applied: 0, needAttention: 0, stoppedBy: null };
    do {
      pending.again = false;
      const outcome = await flushOutbox(options);
      total = {
        applied: total.applied + outcome.applied,
        needAttention: total.needAttention + outcome.needAttention,
        stoppedBy: outcome.stoppedBy,
      };
      // Another request arrived while sending: run once more, unless the connection just failed.
    } while (askedAgain() && total.stoppedBy === null);
    return total;
  };

  return {
    flush(): Promise<FlushOutcome> {
      if (pending.running) {
        pending.again = true;
        return pending.running;
      }
      const current = run().finally(() => {
        pending.running = null;
      });
      pending.running = current;
      void current.then((outcome) => options.onFinished?.(outcome));
      return current;
    },
  };
}
