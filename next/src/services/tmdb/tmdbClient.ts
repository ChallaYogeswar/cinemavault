import { z } from 'zod';

/** What went wrong, in terms the UI can act on. */
export type TmdbFailure =
  | 'signed_out' // the app's own sign-in is missing or expired
  | 'not_configured' // the server has no TMDB key (or no proxy is deployed)
  | 'rate_limited'
  | 'unavailable'; // network down, TMDB down, bad answer

export class TmdbError extends Error {
  readonly failure: TmdbFailure;
  constructor(failure: TmdbFailure, message: string) {
    super(message);
    this.name = 'TmdbError';
    this.failure = failure;
  }
}

const SearchItem = z.object({
  id: z.number().int().positive(),
  media_type: z.string(),
  title: z.string().nullish(),
  name: z.string().nullish(),
  original_title: z.string().nullish(),
  original_name: z.string().nullish(),
  release_date: z.string().nullish(),
  first_air_date: z.string().nullish(),
  poster_path: z
    .string()
    .regex(/^\/[\w.-]+$/)
    .nullish(),
  backdrop_path: z
    .string()
    .regex(/^\/[\w.-]+$/)
    .nullish(),
  vote_average: z.number().nullish(),
  overview: z.string().nullish(),
});
export type SearchItem = z.infer<typeof SearchItem>;
const SearchAnswer = z.object({ results: z.array(z.unknown()) });

const Video = z.object({
  site: z.string(),
  type: z.string(),
  key: z.string().regex(/^[\w-]{6,20}$/),
});
export type Video = z.infer<typeof Video>;
const VideosAnswer = z.object({ results: z.array(z.unknown()) });

export interface TmdbClient {
  /** Movie and TV matches only; anything else TMDB returns (people) is dropped. */
  search(query: string, signal?: AbortSignal): Promise<SearchItem[]>;
  videos(mediaType: 'movie' | 'tv', id: number, signal?: AbortSignal): Promise<Video[]>;
}

export interface TmdbClientOptions {
  /** The signed-in user's access token, or null when signed out. */
  readonly getToken: () => Promise<string | null>;
  readonly fetch?: typeof fetch;
  /** Where the proxy lives. */
  readonly endpoint?: string;
}

const REQUEST_TIMEOUT_MS = 10_000;

/** Keeps the entries that parse and drops the rest: one odd row must not lose the whole answer. */
function parseEach<T>(schema: z.ZodType<T>, items: readonly unknown[]): T[] {
  const kept: T[] = [];
  for (const item of items) {
    const parsed = schema.safeParse(item);
    if (parsed.success) kept.push(parsed.data);
  }
  return kept;
}

export function createTmdbClient(options: TmdbClientOptions): TmdbClient {
  const doFetch = options.fetch ?? ((...args) => fetch(...args));
  const endpoint = options.endpoint ?? '/api/tmdb';

  async function call(
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const token = await options.getToken();
    if (!token) throw new TmdbError('signed_out', 'Not signed in.');
    const url = `${endpoint}?${new URLSearchParams({ path, ...params }).toString()}`;
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let reply: Response;
    try {
      reply = await doFetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error; // the caller gave up: not a failure of TMDB
      throw new TmdbError('unavailable', 'Could not reach the poster service.');
    }
    if (reply.status === 401) throw new TmdbError('signed_out', 'Sign-in expired.');
    // A missing proxy (404/405, or a static host answering with HTML) and a missing key (501) look the same to the user.
    if (reply.status === 404 && !(reply.headers.get('Content-Type') ?? '').includes('json')) {
      throw new TmdbError('not_configured', 'The poster service is not deployed.');
    }
    if (reply.status === 405 || reply.status === 501) {
      throw new TmdbError('not_configured', 'The poster service is not set up.');
    }
    if (reply.status === 429) throw new TmdbError('rate_limited', 'The poster service is busy.');
    if (!reply.ok) throw new TmdbError('unavailable', 'The poster service had a problem.');
    try {
      return (await reply.json()) as unknown;
    } catch {
      throw new TmdbError('unavailable', 'The poster service sent something unreadable.');
    }
  }

  return {
    async search(query, signal) {
      const answer = SearchAnswer.safeParse(await call('/search/multi', { query }, signal));
      if (!answer.success) throw new TmdbError('unavailable', 'Unexpected poster service answer.');
      return parseEach(SearchItem, answer.data.results).filter(
        (r) => r.media_type === 'movie' || r.media_type === 'tv',
      );
    },
    async videos(mediaType, id, signal) {
      const answer = VideosAnswer.safeParse(
        await call(`/${mediaType}/${String(id)}/videos`, {}, signal),
      );
      if (!answer.success) throw new TmdbError('unavailable', 'Unexpected poster service answer.');
      return parseEach(Video, answer.data.results);
    },
  };
}
