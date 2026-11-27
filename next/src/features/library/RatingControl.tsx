import { RATING_MAX } from '@/domain/movie';
import { formatRating, ratingWord } from './format';

interface Props {
  readonly value: number | null;
  /** Omit for a read-only display (viewers, cards). */
  readonly onChange?: (next: number | null) => void;
  readonly disabled?: boolean;
  /** Visible label text is the caller's job; this names the group for assistive tech. */
  readonly label?: string;
}

const STARS = Array.from({ length: RATING_MAX }, (_, i) => i + 1);

type Fill = 'full' | 'half' | 'empty';

function fillFor(value: number | null, star: number): Fill {
  if (value === null) return 'empty';
  if (value >= star) return 'full';
  if (value >= star - 0.5) return 'half';
  return 'empty';
}

function Star({ fill }: { readonly fill: Fill }) {
  const base = 'text-[28px] leading-none transition-colors duration-150';
  if (fill === 'half') {
    return (
      <span
        aria-hidden="true"
        className={`${base} bg-clip-text text-transparent`}
        style={{
          backgroundImage: 'linear-gradient(90deg, var(--color-gold) 50%, var(--color-dim) 50%)',
        }}
      >
        ★
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={`${base} ${fill === 'full' ? 'text-gold' : 'text-dim'}`}>
      ★
    </span>
  );
}

/**
 * Whole-star rating (1–5) that can be CLEARED: pressing the star that is already selected, or the
 * "Clear rating" button, sets the rating back to null. Existing half-point values (the database
 * allows one decimal) are displayed correctly and replaced when a whole star is chosen.
 */
export function RatingControl({ value, onChange, disabled = false, label = 'Rating' }: Props) {
  const summary =
    value === null
      ? 'Not rated'
      : `${formatRating(value)} / ${String(RATING_MAX)} · ${ratingWord(value)}`;

  if (!onChange) {
    return (
      <div className="flex items-center gap-3">
        <div
          role="img"
          aria-label={
            value === null
              ? 'Not rated'
              : `Rated ${formatRating(value)} out of ${String(RATING_MAX)}`
          }
          className="flex"
        >
          {STARS.map((star) => (
            <Star key={star} fill={fillFor(value, star)} />
          ))}
        </div>
        <span className="text-muted text-sm">{summary}</span>
      </div>
    );
  }

  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex">
        {STARS.map((star) => {
          const selected = value === star;
          return (
            <button
              key={star}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              aria-label={`Rate ${String(star)} out of ${String(RATING_MAX)}`}
              onClick={() => {
                onChange(selected ? null : star);
              }}
              className="grid size-11 place-items-center rounded-full transition-transform hover:scale-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Star fill={fillFor(value, star)} />
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3">
        <span className="text-muted text-sm" aria-live="polite">
          {summary}
        </span>
        {value !== null ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onChange(null);
            }}
            className="text-muted hover:text-text min-h-11 rounded-full px-2 text-sm underline underline-offset-4 disabled:opacity-50"
          >
            Clear rating
          </button>
        ) : null}
      </div>
    </div>
  );
}
