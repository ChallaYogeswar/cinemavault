import type { MediaType } from '@/domain/movie';
import { isHttpUrl } from '@/domain/validation';

export const MEDIA_LABEL: Record<MediaType, string> = { movie: 'Movie', tv: 'TV series' };

const RATING_WORDS: Record<number, string> = {
  0: 'No stars',
  1: 'Skip it',
  2: 'Weak',
  3: 'Decent',
  4: 'Great',
  5: 'Masterpiece',
};

/** 4 -> "4", 4.5 -> "4.5". Never shows a trailing ".0". */
export function formatRating(value: number): string {
  return String(Number(value.toFixed(1)));
}

export function ratingWord(value: number | null): string {
  if (value === null) return 'Not rated';
  return RATING_WORDS[Math.round(value)] ?? '';
}

/** "2026-10-20" -> "20 Oct 2026". Parsed and formatted in UTC so the day never shifts by timezone. */
export function formatWatchedOn(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Up to two letters for the poster placeholder: "#Manhole" -> "M", "The Dark Knight" -> "TD". */
export function posterInitials(title: string): string {
  const words = title.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
}

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** Stable, muted gradient per title so a library of placeholders still looks varied. */
export function posterBackground(title: string): string {
  const h = hash(title.toLowerCase());
  const hueA = h % 360;
  const hueB = (hueA + 40 + ((h >>> 9) % 60)) % 360;
  return `linear-gradient(155deg, hsl(${String(hueA)} 34% 26%), hsl(${String(hueB)} 30% 9%))`;
}

/**
 * Only http(s) links are ever rendered as <a>. Older rows were not validated on write, so a stored
 * `javascript:` value must degrade to plain text instead of becoming a clickable link.
 */
export function safeHttpUrl(value: string | null): string | null {
  return value !== null && isHttpUrl(value) ? value : null;
}

/** 132 -> "2 h 12 min", 45 -> "45 min". */
export function formatRuntime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${String(rest)} min`;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}

/**
 * How long ago something happened, for a person: "just now", "5 minutes ago", "3 hours ago",
 * "2 days ago". Future or unparsable times read as "just now"/"at an unknown time", never a
 * negative number.
 */
export function describeAge(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'at an unknown time';
  const minutes = Math.floor((now.getTime() - then) / 60_000);
  if (minutes < 1) return 'just now';
  const plural = (n: number, unit: string) => `${String(n)} ${unit}${n === 1 ? '' : 's'} ago`;
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');
  return plural(Math.floor(hours / 24), 'day');
}
