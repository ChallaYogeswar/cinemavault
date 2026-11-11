import type { MediaType } from './movie';

/**
 * MUST stay byte-for-byte compatible with the existing app's `normalizeTitle`
 * (src/storage/movieRepository.js). `normalized_title` is stored in production and is part of the
 * database uniqueness index, so any behavioural change here would mint new identities for
 * existing records. `tests/unit/identity.test.ts` pins the behaviour with parity vectors.
 */
export function normalizeTitle(title: string | null | undefined): string {
  return (title ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\(series\)|\(show\)|\(tv\)/gi, '')
    .replace(/\s+season\s+\d+$/i, '')
    .trim();
}

export interface IdentityFields {
  readonly normalizedTitle: string;
  readonly mediaType: MediaType;
  readonly year: number | null;
}

/**
 * Documented duplicate rule (application level):
 *   two LIVE movies owned by the same user are duplicates iff normalizedTitle, mediaType and year
 *   are all equal, where a missing year equals another missing year.
 *
 * Note: the database unique index `movies_owner_identity_idx (owner_id, normalized_title,
 * media_type, year)` treats NULL years as distinct, so it does NOT stop two year-less duplicates.
 * Until a migration adds `NULLS NOT DISTINCT`, this function is the only guard for year-less
 * titles. See docs/migration-plan.md, finding F2.
 */
export function isSameIdentity(a: IdentityFields, b: IdentityFields): boolean {
  return (
    comparableTitle(a.normalizedTitle) === comparableTitle(b.normalizedTitle) &&
    a.mediaType === b.mediaType &&
    a.year === b.year
  );
}

/**
 * Production holds TWO spellings of `normalized_title`: rows imported from the original master
 * list have punctuation replaced by spaces ("the pope s exorcist", "mr mrs mahi", "barfi"), while
 * titles created in the app keep it ("the pope's exorcist"). About a third of the library is in
 * the first form (finding F9). Comparing stored values with `===` would let a true duplicate of an
 * imported title through, so duplicate checks compare this canonical form instead: lower-case,
 * accent-free letters and digits separated by single spaces. It is only ever used to COMPARE, never stored.
 */
export function comparableTitle(normalized: string): string {
  return normalized
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '') // the import also folded accents: "Léon" is stored as "leon"
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function identityKey(f: IdentityFields): string {
  return `${f.mediaType}|${f.normalizedTitle}|${f.year === null ? '' : String(f.year)}`;
}
