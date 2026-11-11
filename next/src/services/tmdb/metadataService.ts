import { z } from 'zod';
import type { MetadataStore } from '@/data/local/deviceData';
import {
  TmdbError,
  type SearchItem,
  type TmdbClient,
  type TmdbFailure,
  type Video,
} from './tmdbClient';
import { bareTitle, chooseResult, metadataKey, releaseYearOf, sanitizeTitle } from './title';

/** What the app keeps about a title. Paths, not URLs: the image host and size are chosen at render time. */
export interface MovieMetadata {
  readonly tmdbId: number;
  readonly mediaType: 'movie' | 'tv';
  readonly posterPath: string | null;
  readonly backdropPath: string | null;
  readonly voteAverage: number | null;
  readonly overview: string;
  /** What TMDB calls it, so a wrong match can be seen for what it is. */
  readonly matchedTitle: string;
  readonly matchedYear: number | null;
}

export type Lookup =
  | { readonly kind: 'found'; readonly metadata: MovieMetadata }
  | { readonly kind: 'none' } // TMDB has nothing for this title
  | { readonly kind: 'unavailable'; readonly failure: TmdbFailure }; // could not ask; try again later

export interface LookupTarget {
  readonly title: string;
  readonly year: number | null;
  readonly mediaType: 'movie' | 'tv';
}

export interface MetadataService {
  /**
   * `signal` only ends THIS caller's wait. The request itself is shared by everyone asking for the
   * same title and is never cancelled by one of them leaving (a card scrolling away must not take
   * the answer from the detail view that is still open).
   */
  lookup(userId: string, target: LookupTarget, signal?: AbortSignal): Promise<Lookup>;
  /** A YouTube video id for the title's trailer or teaser, or null. Looked up on demand, never in bulk. */
  trailerKey(userId: string, target: LookupTarget, signal?: AbortSignal): Promise<string | null>;
  /**
   * Forgets this account's saved lookups. A request already on its way when this is called does
   * not save its answer afterwards, so "clear" cannot be undone by a straggler.
   */
  clear(userId: string): Promise<void>;
}

const DAY_MS = 86_400_000;
export const FOUND_TTL_MS = 30 * DAY_MS;
export const NONE_TTL_MS = 7 * DAY_MS;
export const MAX_PARALLEL = 4;
export const NOT_CONFIGURED_PAUSE_MS = 5 * 60_000;
export const RATE_LIMIT_PAUSE_MS = 30_000;

const Stored = z.union([
  z.object({
    kind: z.literal('found'),
    tmdbId: z.number().int().positive(),
    mediaType: z.enum(['movie', 'tv']),
    posterPath: z
      .string()
      .regex(/^\/[\w.-]+$/)
      .nullable(),
    backdropPath: z
      .string()
      .regex(/^\/[\w.-]+$/)
      .nullable(),
    voteAverage: z.number().nullable(),
    overview: z.string(),
    matchedTitle: z.string(),
    matchedYear: z.number().int().nullable(),
  }),
  z.object({ kind: z.literal('none') }),
]);
const StoredTrailer = z.object({
  key: z
    .string()
    .regex(/^[\w-]{6,20}$/)
    .nullable(),
});

export interface MetadataServiceOptions {
  readonly client: TmdbClient;
  readonly store: MetadataStore;
  readonly now?: () => Date;
}

/** Trailer first, teaser second, any YouTube video last. */
export function pickTrailer(videos: readonly Video[]): string | null {
  const youtube = videos.filter((v) => v.site === 'YouTube');
  return (
    (
      youtube.find((v) => v.type === 'Trailer') ??
      youtube.find((v) => v.type === 'Teaser') ??
      youtube[0]
    )?.key ?? null
  );
}

function toMetadata(item: SearchItem): MovieMetadata {
  return {
    tmdbId: item.id,
    mediaType: item.media_type === 'tv' ? 'tv' : 'movie',
    posterPath: item.poster_path ?? null,
    backdropPath: item.backdrop_path ?? null,
    voteAverage: item.vote_average ? Math.round(item.vote_average * 10) / 10 : null,
    overview: item.overview ?? '',
    matchedTitle: item.title ?? item.name ?? item.original_title ?? item.original_name ?? '',
    matchedYear: releaseYearOf(item),
  };
}

export function createMetadataService(options: MetadataServiceOptions): MetadataService {
  const { client, store } = options;
  const now = options.now ?? (() => new Date());

  // At most MAX_PARALLEL requests at once, so a screen of 48 posters is a steady trickle.
  let running = 0;
  const waiting: (() => void)[] = [];
  async function limited<T>(task: () => Promise<T>): Promise<T> {
    if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await task();
    } finally {
      running--;
      waiting.shift()?.();
    }
  }

  // When the service says "not set up" or "busy", everyone stops asking for a while.
  let pausedUntil = 0;
  let pausedFor: TmdbFailure = 'unavailable';
  const inflight = new Map<string, Promise<Lookup>>();
  const trailers = new Map<string, Promise<string | null>>();
  // Bumped by `clear`; a lookup only saves its answer if the epoch is still the one it started in.
  const epochs = new Map<string, number>();
  const epochOf = (userId: string) => epochs.get(userId) ?? 0;

  async function cached(userId: string, key: string, ttl: number): Promise<unknown> {
    const hit = await store.get(userId, key);
    if (!hit) return undefined;
    const age = now().getTime() - Date.parse(hit.savedAt);
    // A timestamp in the future is as suspect as an old one.
    return Number.isFinite(age) && age >= 0 && age < ttl ? hit.value : undefined;
  }

  async function search(clean: string, target: LookupTarget): Promise<Lookup> {
    const match = { title: clean, year: target.year, mediaType: target.mediaType };
    let chosen = chooseResult(await client.search(clean), match);
    if (!chosen) {
      // Nothing convincing: once more without leading symbols ("#Alive" → "Alive").
      const bare = bareTitle(clean);
      if (bare) chosen = chooseResult(await client.search(bare), match);
    }
    return chosen ? { kind: 'found', metadata: toMetadata(chosen) } : { kind: 'none' };
  }

  function failureOf(error: unknown): TmdbFailure {
    if (error instanceof TmdbError) return error.failure;
    throw error; // not ours (an abort): the caller decides
  }

  async function lookupOnce(userId: string, target: LookupTarget): Promise<Lookup> {
    const clean = sanitizeTitle(target.title);
    if (!clean) return { kind: 'none' };
    const key = metadataKey(clean, target.year, target.mediaType);
    const epoch = epochOf(userId);

    const stored = Stored.safeParse(await cached(userId, key, FOUND_TTL_MS));
    if (stored.success) {
      if (stored.data.kind === 'none') {
        // A "nothing found" answer is trusted for less time than a poster.
        const fresh = await cached(userId, key, NONE_TTL_MS);
        if (fresh !== undefined) return { kind: 'none' };
      } else {
        const { kind: _kind, ...metadata } = stored.data;
        return { kind: 'found', metadata };
      }
    }

    if (now().getTime() < pausedUntil) return { kind: 'unavailable', failure: pausedFor };
    let result: Lookup;
    try {
      result = await limited(() => search(clean, target));
    } catch (error) {
      const failure = failureOf(error);
      if (failure === 'not_configured' || failure === 'rate_limited') {
        pausedFor = failure;
        pausedUntil =
          now().getTime() +
          (failure === 'rate_limited' ? RATE_LIMIT_PAUSE_MS : NOT_CONFIGURED_PAUSE_MS);
      }
      return { kind: 'unavailable', failure };
    }
    if (epochOf(userId) === epoch) {
      await store.put(
        userId,
        key,
        result.kind === 'found' ? { kind: 'found', ...result.metadata } : { kind: 'none' },
        now(),
      );
    }
    return result;
  }

  async function findTrailer(userId: string, target: LookupTarget): Promise<string | null> {
    const found = await service.lookup(userId, target);
    if (found.kind !== 'found') return null;
    const { tmdbId, mediaType } = found.metadata;
    const epoch = epochOf(userId);
    const key = `tmdb:v1:trailer:${mediaType}:${String(tmdbId)}`;
    const stored = StoredTrailer.safeParse(await cached(userId, key, FOUND_TTL_MS));
    if (stored.success) return stored.data.key;
    if (now().getTime() < pausedUntil) return null;
    try {
      const videos = await limited(() => client.videos(mediaType, tmdbId));
      const trailer = pickTrailer(videos);
      if (epochOf(userId) === epoch) await store.put(userId, key, { key: trailer }, now());
      return trailer;
    } catch (error) {
      failureOf(error);
      return null;
    }
  }

  const service: MetadataService = {
    lookup(userId, target, signal) {
      // The same title asked for twice at once (two cards, a card and the detail view) is one
      // request, shared by everyone waiting for it.
      const key = `${userId}\u0000${metadataKey(target.title, target.year, target.mediaType)}`;
      let shared = inflight.get(key);
      if (!shared) {
        shared = lookupOnce(userId, target).finally(() => inflight.delete(key));
        inflight.set(key, shared);
      }
      return waitFor(shared, signal);
    },

    trailerKey(userId, target, signal) {
      const flight = `${userId}\u0000${metadataKey(target.title, target.year, target.mediaType)}`;
      let shared = trailers.get(flight);
      if (!shared) {
        shared = findTrailer(userId, target).finally(() => trailers.delete(flight));
        trailers.set(flight, shared);
      }
      return waitFor(shared, signal);
    },

    async clear(userId) {
      epochs.set(userId, epochOf(userId) + 1);
      pausedUntil = 0; // a fresh start also means asking again
      await store.clear(userId);
    },
  };
  return service;
}

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');

/** Waits for a shared promise, but only as long as this caller still wants the answer. */
function waitFor<T>(shared: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return shared;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    shared.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
