import type { AttentionReason, OutboxEntry, QueueOp } from '@/domain/outbox';
import type { Role } from '@/domain/permissions';

/**
 * Changes waiting to be sent, kept per account in the SAME database as the saved library, so they
 * are wiped with it on sign-out and an account switch cannot carry them over. Unlike the saved
 * library this is NOT a disposable cache: it holds the only copy of what the person typed, which is
 * why every method reports failure instead of pretending, and why `enqueue` must say plainly when
 * nothing was kept.
 */
export type EnqueueResult =
  | { readonly ok: true; readonly entry: OutboxEntry | null }
  | { readonly ok: false; readonly reason: 'blocked_needs_attention' | 'blocked_deleted' }
  /** The browser refused to store it (disk full, private window, wiped account). Nothing was kept. */
  | { readonly ok: false; readonly reason: 'unavailable' };

/** What the server answered for a change that was accepted. */
export interface AcceptedVersion {
  /** The record's `updated_at` after the change; null when the change removed it. */
  readonly updatedAt: string | null;
}

export interface OutboxStore {
  /** Every entry of THIS account, oldest first. Rows that fail validation are skipped, never deleted. Never throws. */
  list(userId: string): Promise<readonly OutboxEntry[]>;
  /** Folds `op` into the title's entry (see `coalesce`) in one transaction. Never throws. */
  enqueue(userId: string, op: QueueOp, now: Date): Promise<EnqueueResult>;
  /**
   * The server accepted the entry as it was at `rev`. If the person changed the title again while
   * it was being sent (`rev` moved on), the newer change stays and is re-based onto what the server
   * now holds; otherwise the entry is removed. Never throws.
   */
  settle(userId: string, movieId: string, rev: number, accepted: AcceptedVersion): Promise<void>;
  /** The server did not accept the entry at `rev`; it now waits for the person. Ignored if the entry moved on. */
  needsAttention(
    userId: string,
    movieId: string,
    rev: number,
    reason: AttentionReason,
    message: string,
  ): Promise<void>;
  /** The person chose to keep their change: send it again, against this version of the server's record. */
  keepMine(userId: string, movieId: string, baseUpdatedAt: string | null): Promise<boolean>;
  /** The person chose the server's version: forget the change. */
  discard(userId: string, movieId: string): Promise<void>;
}

/**
 * The access level this device last confirmed with the server. Lets an owner who is offline keep
 * working. It is a UI convenience only: the server (row-level security) checks every change when
 * it is sent, and a change it refuses is kept for the person to review, not lost.
 */
export interface StoredRole {
  readonly role: Role;
  /** ISO-8601, from this device's clock. */
  readonly savedAt: string;
}

export interface RoleStore {
  get(userId: string): Promise<StoredRole | null>;
  put(userId: string, role: Role, at: Date): Promise<void>;
}

/** A confirmed role older than this is not used offline. */
export const MAX_ROLE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
