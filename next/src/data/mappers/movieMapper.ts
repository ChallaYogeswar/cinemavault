import { z } from 'zod';
import { normalizeTitle } from '@/domain/identity';
import { MEDIA_TYPES, type Movie } from '@/domain/movie';
import { movieSchema, type MovieInputValues } from '@/domain/validation';

const numeric = z.union([
  z.number(),
  z
    .string()
    .regex(/^-?\d+(\.\d+)?$/)
    .transform(Number),
]);

/** Shape of a row in `public.movies`, as returned by PostgREST. */
export const movieRowSchema = z.object({
  id: z.uuid(),
  owner_id: z.uuid(),
  title: z.string(),
  normalized_title: z.string(),
  media_type: z.enum(MEDIA_TYPES),
  year: z.number().nullable(),
  genre: z.string().nullable(),
  runtime_minutes: z.number().nullable(),
  watched: z.boolean(),
  watched_on: z.string().nullable(),
  user_rating: numeric.nullable(),
  verdict: z.string().nullable(),
  technical_notes: z.string().nullable(),
  shot_link: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});

export type MovieRow = z.infer<typeof movieRowSchema>;

/**
 * Strict: a corrupt row throws instead of being silently coerced, so bad data is surfaced rather
 * than displayed or written back.
 */
export function rowToMovie(raw: unknown): Movie {
  const row = movieRowSchema.parse(raw);
  return movieSchema.parse({
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    normalizedTitle: row.normalized_title,
    mediaType: row.media_type,
    year: row.year,
    genre: row.genre,
    runtimeMinutes: row.runtime_minutes,
    watched: row.watched,
    watchedOn: row.watched_on,
    userRating: row.user_rating,
    verdict: row.verdict,
    technicalNotes: row.technical_notes,
    shotLink: row.shot_link,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    deletedAt: row.deleted_at === null ? null : toIso(row.deleted_at),
  });
}

/** Columns the app is allowed to write. Never includes id, owner, timestamps or tombstone. */
export const MOVIE_COLUMNS =
  'id, owner_id, title, normalized_title, media_type, year, genre, runtime_minutes, watched, watched_on, user_rating, verdict, technical_notes, shot_link, created_at, updated_at, deleted_at';

export function inputToColumns(input: MovieInputValues) {
  return {
    title: input.title,
    normalized_title: normalizeTitle(input.title),
    media_type: input.mediaType,
    year: input.year,
    genre: input.genre,
    runtime_minutes: input.runtimeMinutes,
    watched: input.watched,
    watched_on: input.watchedOn,
    user_rating: input.userRating,
    verdict: input.verdict,
    technical_notes: input.technicalNotes,
    shot_link: input.shotLink,
  };
}

export function movieToRow(movie: Movie): MovieRow {
  return {
    id: movie.id,
    owner_id: movie.ownerId,
    title: movie.title,
    normalized_title: movie.normalizedTitle,
    media_type: movie.mediaType,
    year: movie.year,
    genre: movie.genre,
    runtime_minutes: movie.runtimeMinutes,
    watched: movie.watched,
    watched_on: movie.watchedOn,
    user_rating: movie.userRating,
    verdict: movie.verdict,
    technical_notes: movie.technicalNotes,
    shot_link: movie.shotLink,
    created_at: movie.createdAt,
    updated_at: movie.updatedAt,
    deleted_at: movie.deletedAt,
  };
}

/**
 * Timestamps are passed through VERBATIM. `updated_at` doubles as the record's version token for
 * optimistic concurrency and is compared for equality in the database, and Postgres keeps
 * microseconds while a JavaScript Date keeps only milliseconds. Re-formatting through Date would
 * turn two distinct versions into one (or a real version into one that matches nothing), silently
 * breaking conflict detection. The value is only checked to be a real timestamp.
 */
function toIso(value: string): string {
  if (Number.isNaN(Date.parse(value))) throw new Error(`Invalid timestamp: ${value}`);
  return value;
}
