/** Turning a library title into something TMDB can find, and choosing among what it returns. */

/** Removes "(Series)", "[TV]", "Season 2" and similar tags that the library adds but TMDB does not use. */
export function sanitizeTitle(raw: string): string {
  return raw
    .replace(/\s*[([]\s*(Series|Show|Mini-Series|Miniseries|TV|Anime)\s*[)\]]/gi, '')
    .replace(/\s+Season\s+\d+\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "#Alive" or "(500) Days of Summer" can miss on TMDB; the second attempt drops the leading symbols. */
export function bareTitle(clean: string): string | null {
  const bare = clean.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  return bare && bare !== clean ? bare : null;
}

/** Lower-case, accents and punctuation removed, "&" read as "and", a leading "the / a / an" dropped. */
export function normalizeTitle(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^(the|a|an) (?=.)/, '')
    .trim();
}

function bigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const padded = ` ${text} `;
  for (let i = 0; i < padded.length - 1; i += 1) {
    const pair = padded.slice(i, i + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/**
 * 0..1. 1 means the titles are the same once accents, punctuation and a leading article are
 * ignored; otherwise Sørensen–Dice over letter pairs, which tolerates a typo or a missing word
 * ("Interstellr" ≈ 0.86) and punishes a different title ("Heat" vs "Heat Wave" ≈ 0.67).
 */
export function titleSimilarity(a: string, b: string): number {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const left = bigrams(x);
  const right = bigrams(y);
  let shared = 0;
  let total = 0;
  for (const n of left.values()) total += n;
  for (const n of right.values()) total += n;
  for (const [pair, n] of left) shared += Math.min(n, right.get(pair) ?? 0);
  return (2 * shared) / total;
}

/** At or above this the titles count as the same title. */
export const STRONG_MATCH = 0.9;
/** At or above this a title is accepted ONLY when the release year also agrees. */
export const WEAK_MATCH = 0.75;

export interface Candidate {
  readonly media_type: string;
  readonly title?: string | null | undefined;
  readonly name?: string | null | undefined;
  readonly original_title?: string | null | undefined;
  readonly original_name?: string | null | undefined;
  readonly release_date?: string | null | undefined;
  readonly first_air_date?: string | null | undefined;
  readonly poster_path?: string | null | undefined;
}

export interface MatchTarget {
  /** The library title, already cleaned of tags. */
  readonly title: string;
  readonly year: number | null;
  readonly mediaType: 'movie' | 'tv';
}

export const releaseYearOf = (candidate: Candidate): number | null => {
  const year = Number((candidate.release_date ?? candidate.first_air_date ?? '').slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : null;
};

const similarityOf = (candidate: Candidate, title: string): number =>
  Math.max(
    ...[candidate.title, candidate.name, candidate.original_title, candidate.original_name].map(
      (name) => (name ? titleSimilarity(title, name) : 0),
    ),
  );

/**
 * The best result for a library entry, or null when nothing is convincing — a missing poster is
 * better than the wrong one. A result must carry the same title (≥ 0.9), or a close one (≥ 0.75)
 * released in the entry's year. Among acceptable results: the right year, then the right kind
 * (film or series), then one with a poster, then the closer title, then TMDB's own order (the sort is stable).
 * The library entry's year is a hint: a strong title match with another year is still accepted.
 */
export function chooseResult<T extends Candidate>(
  results: readonly T[],
  target: MatchTarget,
): T | null {
  const scored = results
    .map((candidate) => {
      const similarity = similarityOf(candidate, target.title);
      const sameYear = target.year !== null && releaseYearOf(candidate) === target.year;
      return { candidate, similarity, sameYear };
    })
    .filter((r) => r.similarity >= STRONG_MATCH || (r.similarity >= WEAK_MATCH && r.sameYear));
  const rank = (r: (typeof scored)[number]): (number | boolean)[] => [
    r.sameYear,
    r.candidate.media_type === target.mediaType,
    Boolean(r.candidate.poster_path),
    r.similarity,
  ];
  scored.sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    for (let i = 0; i < left.length; i += 1) {
      const l = Number(left[i]);
      const r = Number(right[i]);
      if (l !== r) return r - l;
    }
    return 0;
  });
  return scored[0]?.candidate ?? null;
}

/** Stable per-title key. Contains the title, so it is only ever stored per account. */
export function metadataKey(title: string, year: number | null, mediaType: string): string {
  return `tmdb:v2:${sanitizeTitle(title).toLowerCase()}|${year === null ? '' : String(year)}|${mediaType}`;
}

/** TMDB serves each poster at several widths; the grid needs the small one, the detail view the larger. */
export const posterUrl = (path: string, size: 'card' | 'detail'): string =>
  `https://image.tmdb.org/t/p/${size === 'card' ? 'w342' : 'w500'}${path}`;

export const youtubeWatchUrl = (key: string): string => `https://www.youtube.com/watch?v=${key}`;

export function youtubeSearchUrl(title: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${sanitizeTitle(title)} official trailer`)}`;
}
