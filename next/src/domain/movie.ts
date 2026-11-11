/**
 * Canonical movie model. Field names and limits mirror the production Postgres schema
 * (supabase/migrations: initial schema + `align_movie_rating_scale`). Pure types: no browser or
 * Supabase dependency.
 */
export const MEDIA_TYPES = ['movie', 'tv'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/** DB: `year smallint check (year between 1888 and 2100)`. */
export const YEAR_MIN = 1888;
export const YEAR_MAX = 2100;

/** DB (after align_movie_rating_scale): `user_rating numeric(3,1) check (0..5)`. */
export const RATING_MIN = 0;
export const RATING_MAX = 5;

export interface Movie {
  /** Stable across devices: generated once (UUID) and never reused. */
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  /** Derived from `title` by `normalizeTitle`; part of the duplicate-identity rule. */
  readonly normalizedTitle: string;
  readonly mediaType: MediaType;
  readonly year: number | null;
  readonly genre: string | null;
  readonly runtimeMinutes: number | null;
  readonly watched: boolean;
  /** ISO calendar date (YYYY-MM-DD); only meaningful when `watched` is true. */
  readonly watchedOn: string | null;
  readonly userRating: number | null;
  readonly verdict: string | null;
  readonly technicalNotes: string | null;
  readonly shotLink: string | null;
  /** ISO-8601 timestamps. `deletedAt` set means soft-deleted (tombstone; must propagate on sync). */
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

/** Fields a user may edit; everything else is system-managed. */
export type MovieInput = Pick<
  Movie,
  | 'title'
  | 'mediaType'
  | 'year'
  | 'genre'
  | 'runtimeMinutes'
  | 'watched'
  | 'watchedOn'
  | 'userRating'
  | 'verdict'
  | 'technicalNotes'
  | 'shotLink'
>;

export interface MovieMetadata {
  readonly movieId: string;
  readonly tmdbId: number | null;
  readonly tmdbMediaType: MediaType | null;
  readonly posterUrl: string | null;
  readonly backdropUrl: string | null;
  readonly overview: string | null;
  readonly cachedAt: string;
}
