import { isSameIdentity, normalizeTitle } from '@/domain/identity';
import type { Movie } from '@/domain/movie';
import { movieInputSchema, type MovieInputValues } from '@/domain/validation';
import { z } from 'zod';

/**
 * Changes made while the server could not be reached, kept on this device until they can be sent.
 *
 * THE INVARIANT THAT KEEPS THIS SAFE: there is at most ONE entry per title (the store is keyed by
 * the title's id). Making a second change to the same title does not queue a second operation; it
 * is folded into the first by `coalesce`, so replay never has two operations racing each other and
 * "what will be sent" is always one small, inspectable record.
 *
 * Nothing in here talks to a network or a database: these are the rules, in one pure place.
 */
export type OutboxKind = 'create' | 'update' | 'delete';

/** Why a change was not accepted by the server and now needs the person to decide. */
export type AttentionReason =
  /** The title was changed somewhere else after it was opened here. */
  | 'changed'
  /** The title was deleted somewhere else. */
  | 'gone'
  /** Another title with the same name, type and year exists. */
  | 'duplicate'
  /** The server refused the change (for example the account is now view-only). */
  | 'refused'
  /** The server could not accept the values. */
  | 'invalid';

export interface OutboxEntry {
  /** The title's id. For a create it is chosen HERE, so replaying the create can never add a second copy. */
  readonly movieId: string;
  readonly kind: OutboxKind;
  /** Bumped on every change to the entry; lets a send that finishes late tell whether the entry moved on. */
  readonly rev: number;
  /** The version (`updatedAt`) the person was looking at. Null for a create. */
  readonly baseUpdatedAt: string | null;
  /** The values to save. Null for a delete. */
  readonly input: MovieInputValues | null;
  /** For lists and messages (for a delete, the title as it was). */
  readonly title: string;
  readonly queuedAt: string;
  readonly state: 'pending' | 'attention';
  readonly reason?: AttentionReason;
  readonly message?: string;
}

export type QueueOp =
  | { readonly kind: 'create'; readonly movieId: string; readonly input: MovieInputValues }
  | {
      readonly kind: 'update';
      readonly movieId: string;
      readonly input: MovieInputValues;
      readonly baseUpdatedAt: string;
    }
  | {
      readonly kind: 'delete';
      readonly movieId: string;
      readonly baseUpdatedAt: string;
      readonly title: string;
    };

export type Coalesced =
  | { readonly action: 'put'; readonly entry: OutboxEntry }
  | { readonly action: 'drop' }
  /** The title already has a change waiting for a decision, or was already deleted here. */
  | { readonly action: 'blocked'; readonly reason: 'needs_attention' | 'deleted' };

/**
 * Folds a new change into whatever is already queued for the same title.
 *  - create then edit        → still ONE create, with the newest values
 *  - create then delete      → nothing: it never reached the server, so there is nothing to undo
 *  - edit then edit          → ONE edit, with the newest values and the OLDEST base version
 *                              (the version the person first saw is what the server must still have)
 *  - edit then delete        → ONE delete, same base
 *  - anything on a title that waits for a decision, or that is already queued for deletion → refused
 */
export function coalesce(existing: OutboxEntry | undefined, op: QueueOp, now: Date): Coalesced {
  const queuedAt = now.toISOString();
  if (!existing) {
    switch (op.kind) {
      case 'create':
        return {
          action: 'put',
          entry: {
            movieId: op.movieId,
            kind: 'create',
            rev: 1,
            baseUpdatedAt: null,
            input: op.input,
            title: op.input.title,
            queuedAt,
            state: 'pending',
          },
        };
      case 'update':
        return {
          action: 'put',
          entry: {
            movieId: op.movieId,
            kind: 'update',
            rev: 1,
            baseUpdatedAt: op.baseUpdatedAt,
            input: op.input,
            title: op.input.title,
            queuedAt,
            state: 'pending',
          },
        };
      case 'delete':
        return {
          action: 'put',
          entry: {
            movieId: op.movieId,
            kind: 'delete',
            rev: 1,
            baseUpdatedAt: op.baseUpdatedAt,
            input: null,
            title: op.title,
            queuedAt,
            state: 'pending',
          },
        };
    }
  }

  if (existing.state === 'attention') return { action: 'blocked', reason: 'needs_attention' };
  if (existing.kind === 'delete') return { action: 'blocked', reason: 'deleted' };

  if (existing.kind === 'create') {
    if (op.kind === 'delete') return { action: 'drop' };
    if (op.kind === 'create') return { action: 'blocked', reason: 'needs_attention' };
    return {
      action: 'put',
      entry: { ...existing, rev: existing.rev + 1, input: op.input, title: op.input.title },
    };
  }

  // existing.kind === 'update'
  if (op.kind === 'update') {
    return {
      action: 'put',
      entry: { ...existing, rev: existing.rev + 1, input: op.input, title: op.input.title },
    };
  }
  if (op.kind === 'delete') {
    return {
      action: 'put',
      entry: {
        ...existing,
        kind: 'delete',
        rev: existing.rev + 1,
        input: null,
        title: op.title,
      },
    };
  }
  return { action: 'blocked', reason: 'needs_attention' };
}

/** A title as the person would see it if the server had already accepted a create. */
export function movieFromInput(
  input: MovieInputValues,
  movieId: string,
  ownerId: string,
  at: string,
): Movie {
  return {
    ...input,
    id: movieId,
    ownerId,
    normalizedTitle: normalizeTitle(input.title),
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
}

/** `movie` with the values of a queued edit on top. `updatedAt` stays the SERVER's version. */
function withInput(movie: Movie, input: MovieInputValues): Movie {
  return {
    ...movie,
    ...input,
    normalizedTitle:
      input.title === movie.title ? movie.normalizedTitle : normalizeTitle(input.title),
  };
}

/**
 * The library as THIS device should show it: the server's (or saved) list with the waiting changes
 * laid over it. Pure, and safe to apply twice:
 *  - a create whose id is already in the list (the server accepted it a moment ago) changes nothing;
 *  - an edit lands on whatever version is in the list;
 *  - a delete of a title that is already gone changes nothing.
 * Only changes that are still waiting their turn are laid over the list. A change that needs a
 * decision is NOT shown as done (the server's version stays visible, flagged), except a create:
 * there is no server version to show, and hiding it would make it look lost.
 */
export function applyOutbox(
  movies: readonly Movie[],
  entries: readonly OutboxEntry[],
  ownerId: string,
): readonly Movie[] {
  if (entries.length === 0) return movies;
  const byId = new Map(entries.map((entry) => [entry.movieId, entry]));
  let changed = false;
  const result: Movie[] = [];
  const seen = new Set<string>();
  for (const movie of movies) {
    seen.add(movie.id);
    const entry = byId.get(movie.id);
    // A create whose id is already in the list was accepted a moment ago: the server's copy wins.
    if (entry?.state !== 'pending' || entry.kind === 'create') {
      result.push(movie);
    } else if (entry.kind === 'delete') {
      changed = true;
    } else if (entry.input) {
      changed = true;
      result.push(withInput(movie, entry.input));
    } else {
      result.push(movie);
    }
  }
  for (const entry of entries) {
    if (entry.kind !== 'create' || entry.input === null || seen.has(entry.movieId)) continue;
    changed = true;
    result.push(movieFromInput(entry.input, entry.movieId, ownerId, entry.queuedAt));
  }
  return changed ? result : movies;
}

/** Ids of titles whose change is waiting, and of those that need a decision. */
export function outboxStatus(entries: readonly OutboxEntry[]): {
  readonly pending: ReadonlySet<string>;
  readonly attention: ReadonlySet<string>;
} {
  return {
    pending: new Set(entries.filter((e) => e.state === 'pending').map((e) => e.movieId)),
    attention: new Set(entries.filter((e) => e.state === 'attention').map((e) => e.movieId)),
  };
}

/**
 * The first title in `library` that `input` would duplicate (same name, type and year), ignoring
 * `ignoreId`. The server makes the final call; this only avoids queueing a change that is
 * certain to be refused.
 */
export function findDuplicateIn(
  library: readonly Movie[],
  input: MovieInputValues,
  ignoreId: string | null,
): Movie | undefined {
  const candidate = {
    normalizedTitle: normalizeTitle(input.title),
    mediaType: input.mediaType,
    year: input.year,
  };
  return library.find((movie) => movie.id !== ignoreId && isSameIdentity(movie, candidate));
}

/**
 * True when `movie` already holds exactly the values of `input`. Used when an edit is refused as
 * "changed elsewhere": if the server's copy is identical to what we were about to send, the earlier
 * attempt had in fact succeeded and only its reply was lost, so there is nothing to decide.
 */
export function holdsValues(movie: Movie, input: MovieInputValues): boolean {
  return (
    movie.title === input.title &&
    movie.mediaType === input.mediaType &&
    movie.year === input.year &&
    movie.genre === input.genre &&
    movie.runtimeMinutes === input.runtimeMinutes &&
    movie.watched === input.watched &&
    movie.watchedOn === input.watchedOn &&
    movie.userRating === input.userRating &&
    movie.verdict === input.verdict &&
    movie.technicalNotes === input.technicalNotes &&
    movie.shotLink === input.shotLink
  );
}

const reasons = ['changed', 'gone', 'duplicate', 'refused', 'invalid'] as const;

/** Shape check for entries read back from the device. A row that fails is ignored, never "repaired". */
export const outboxEntrySchema = z
  .object({
    movieId: z.uuid(),
    kind: z.enum(['create', 'update', 'delete']),
    rev: z.number().int().min(1),
    baseUpdatedAt: z.string().nullable(),
    input: movieInputSchema.nullable(),
    title: z.string(),
    queuedAt: z.string(),
    state: z.enum(['pending', 'attention']),
    reason: z.enum(reasons).optional(),
    message: z.string().optional(),
  })
  // A create has values and no base; an edit has both; a delete has a base and no values.
  .refine(
    (e) =>
      (e.kind === 'create' && e.input !== null && e.baseUpdatedAt === null) ||
      (e.kind === 'update' && e.input !== null && e.baseUpdatedAt !== null) ||
      (e.kind === 'delete' && e.input === null && e.baseUpdatedAt !== null),
    'inconsistent entry',
  );

/** A validated row as an entry (optional fields are only present when they have a value). */
export function toEntry(row: z.infer<typeof outboxEntrySchema>): OutboxEntry {
  return {
    movieId: row.movieId,
    kind: row.kind,
    rev: row.rev,
    baseUpdatedAt: row.baseUpdatedAt,
    input: row.input,
    title: row.title,
    queuedAt: row.queuedAt,
    state: row.state,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.message ? { message: row.message } : {}),
  };
}
