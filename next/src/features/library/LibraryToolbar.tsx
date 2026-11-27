import { useId, useState, type ReactNode } from 'react';
import {
  RATING_FILTERS,
  SORT_KEYS,
  STATUS_FILTERS,
  TYPE_FILTERS,
  hasActiveFilters,
  type LibraryQuery,
  type RatingFilter,
  type SortKey,
  type StatusFilter,
  type TypeFilter,
} from '@/domain/library';
import { Button } from '@/components/ui/Button';

const TYPE_LABEL: Record<TypeFilter, string> = {
  all: 'All types',
  movie: 'Movies',
  tv: 'TV series',
};
const STATUS_LABEL: Record<StatusFilter, string> = {
  all: 'All',
  watched: 'Watched',
  unwatched: 'To watch',
};
const RATING_LABEL: Record<RatingFilter, string> = {
  any: 'Any rating',
  unrated: 'Not rated',
  min3: '3 stars & up',
  min4: '4 stars & up',
  min5: '5 stars',
};
const SORT_LABEL: Record<SortKey, string> = {
  added: 'Recently added',
  title: 'Title A–Z',
  year: 'Newest release',
  rating: 'Highest rated',
};

const controlClass =
  'bg-surface-2 border-line text-text min-h-11 w-full rounded-2xl border px-3 text-sm outline-none focus-visible:border-gold';

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="text-dim mb-1 block font-mono text-[10px] uppercase tracking-[0.16em]">
        {label}
      </span>
      {children}
    </label>
  );
}

function countActive(query: LibraryQuery): number {
  return [
    query.type !== 'all',
    query.status !== 'all',
    query.rating !== 'any',
    query.genre !== '',
  ].filter(Boolean).length;
}

interface Props {
  readonly query: LibraryQuery;
  readonly onChange: (patch: Partial<LibraryQuery>) => void;
  readonly onClear: () => void;
  readonly genres: readonly { genre: string; count: number }[];
  readonly shown: number;
  readonly total: number;
}

/**
 * Search is always visible. On phones the four filters collapse behind a "Filters" button (with a
 * count of what is active); from `md` up they sit in one row.
 */
export function LibraryToolbar({ query, onChange, onClear, genres, shown, total }: Props) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const active = countActive(query);

  return (
    <div className="mb-6 space-y-3" role="search" aria-label="Search and filter your library">
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <label htmlFor="library-search" className="sr-only">
            Search library
          </label>
          <input
            id="library-search"
            type="search"
            value={query.search}
            onChange={(event) => {
              onChange({ search: event.target.value });
            }}
            placeholder="Search title, year, genre…"
            autoComplete="off"
            spellCheck={false}
            className={`${controlClass} pl-4 pr-3`}
          />
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => {
            setOpen((current) => !current);
          }}
          className="border-line bg-surface-2 hover:bg-surface-3 min-h-11 shrink-0 rounded-2xl border px-4 text-sm font-semibold md:hidden"
        >
          Filters{active > 0 ? ` (${String(active)})` : ''}
        </button>
      </div>

      <div
        id={panelId}
        className={`${open ? 'grid' : 'hidden'} grid-cols-2 gap-3 md:grid md:grid-cols-5`}
      >
        <Field label="Type">
          <select
            className={controlClass}
            value={query.type}
            onChange={(event) => {
              onChange({ type: event.target.value as TypeFilter });
            }}
          >
            {TYPE_FILTERS.map((value) => (
              <option key={value} value={value}>
                {TYPE_LABEL[value]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select
            className={controlClass}
            value={query.status}
            onChange={(event) => {
              onChange({ status: event.target.value as StatusFilter });
            }}
          >
            {STATUS_FILTERS.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABEL[value]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Rating">
          <select
            className={controlClass}
            value={query.rating}
            onChange={(event) => {
              onChange({ rating: event.target.value as RatingFilter });
            }}
          >
            {RATING_FILTERS.map((value) => (
              <option key={value} value={value}>
                {RATING_LABEL[value]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Genre">
          <select
            className={controlClass}
            value={query.genre}
            onChange={(event) => {
              onChange({ genre: event.target.value });
            }}
          >
            <option value="">All genres</option>
            {genres.map(({ genre, count }) => (
              <option key={genre} value={genre}>
                {genre} ({count})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sort by">
          <select
            className={controlClass}
            value={query.sort}
            onChange={(event) => {
              onChange({ sort: event.target.value as SortKey });
            }}
          >
            {SORT_KEYS.map((value) => (
              <option key={value} value={value}>
                {SORT_LABEL[value]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="text-muted flex min-h-6 items-center justify-between gap-3 text-xs">
        <p role="status" aria-live="polite">
          {hasActiveFilters(query)
            ? `${String(shown)} of ${String(total)} titles`
            : `${String(total)} ${total === 1 ? 'title' : 'titles'}`}
        </p>
        {hasActiveFilters(query) ? (
          <Button variant="ghost" className="!min-h-9 !px-3 text-xs" onClick={onClear}>
            Clear filters
          </Button>
        ) : null}
      </div>
    </div>
  );
}
