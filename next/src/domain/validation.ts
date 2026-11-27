import { z } from 'zod';
import { MEDIA_TYPES, RATING_MAX, RATING_MIN, YEAR_MAX, YEAR_MIN } from './movie';

/** A real calendar date (YYYY-MM-DD): rejects 2026-02-31, 2026-99-99 and non-leap Feb 29. */
const isoDate = z.iso.date('Use a real calendar date like 2026-10-26');

/**
 * The database column is numeric(3,1): at most one decimal place. Anything finer would be rounded
 * by Postgres, so the saved value would differ from what the user entered. `toFixed(1)` round-trip
 * is used rather than `x * 10` because binary floats make the multiplication unreliable.
 */
export const hasAtMostOneDecimal = (value: number): boolean => Number(value.toFixed(1)) === value;

const rating = z
  .number({ error: 'Enter a rating from 0 to 5' })
  .min(RATING_MIN)
  .max(RATING_MAX, `Rating must be between ${String(RATING_MIN)} and ${String(RATING_MAX)}`)
  .refine(hasAtMostOneDecimal, 'Use at most one decimal place, like 4 or 4.5');
/**
 * A link the user typed is later rendered as an <a href>. Only http(s) is accepted so a
 * `javascript:` or `data:` URL can never be stored and clicked. Applied to WRITES only: legacy rows
 * that fail this are still readable (movieSchema) and are shown as plain text, not as a link.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

const isoTimestamp = z.iso.datetime({ offset: true });

const trimmedOrNull = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v === '' ? null : v));

/** Shared by forms (React Hook Form) and the repository layer. */
export const movieInputSchema = z
  .object({
    title: z
      .string()
      .transform((s) => s.trim().replace(/\s+/g, ' '))
      .pipe(z.string().min(1, 'Title is required').max(200, 'Title is too long')),
    mediaType: z.enum(MEDIA_TYPES),
    year: z
      .number({ error: 'Enter a year like 2023' })
      .int('Year must be a whole number')
      .min(YEAR_MIN, `Year must be ${String(YEAR_MIN)} or later`)
      .max(YEAR_MAX, `Year must be ${String(YEAR_MAX)} or earlier`)
      .nullable(),
    genre: trimmedOrNull(200),
    runtimeMinutes: z
      .number({ error: 'Enter the runtime in minutes' })
      .int('Runtime must be a whole number of minutes')
      .positive('Runtime must be positive')
      .max(10_000, 'Runtime is too long')
      .nullable(),
    watched: z.boolean(),
    watchedOn: isoDate.nullable(),
    userRating: rating.nullable(),
    verdict: trimmedOrNull(5_000),
    technicalNotes: trimmedOrNull(5_000),
    shotLink: trimmedOrNull(2_000).refine((v) => v === null || isHttpUrl(v), {
      error: 'Use a full link starting with http:// or https://',
    }),
  })
  // Mirrors DB constraint movies_watched_date_consistency: watched = true OR watched_on IS NULL.
  .refine((m) => m.watched || m.watchedOn === null, {
    path: ['watchedOn'],
    message: 'A watched date needs the title to be marked as watched',
  });

export type MovieInputValues = z.infer<typeof movieInputSchema>;

export const movieSchema = z.object({
  id: z.uuid(),
  ownerId: z.uuid(),
  title: z.string().min(1),
  normalizedTitle: z.string().min(1),
  mediaType: z.enum(MEDIA_TYPES),
  year: z.number().int().min(YEAR_MIN).max(YEAR_MAX).nullable(),
  genre: z.string().nullable(),
  runtimeMinutes: z.number().int().positive().nullable(),
  watched: z.boolean(),
  watchedOn: isoDate.nullable(),
  userRating: rating.nullable(),
  verdict: z.string().nullable(),
  technicalNotes: z.string().nullable(),
  shotLink: z.string().nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  deletedAt: isoTimestamp.nullable(),
});
