import { useDeferredValue, useMemo, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { buttonClass } from '@/components/ui/buttonStyles';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingGrid } from '@/components/ui/states';
import { applyLibraryQuery, genreCounts } from '@/domain/library';
import type { Movie } from '@/domain/movie';
import { outboxStatus } from '@/domain/outbox';
import { useOutboxEntries } from '@/features/sync/useOutbox';
import { LibraryToolbar } from './LibraryToolbar';
import { MovieCard } from './MovieCard';
import { RepositoryError } from '@/data/repositories/repositoryError';
import { useMoviesQuery, useWriteAccess } from './queries';
import { useLibraryQuery } from './useLibraryQuery';

/** Rendering 3,000+ cards at once would stall a phone, so the grid grows in pages. */
export const PAGE_SIZE = 48;

function MovieGrid({ movies }: { readonly movies: readonly Movie[] }) {
  const [visible, setVisible] = useState(PAGE_SIZE);
  const entries = useOutboxEntries();
  const status = useMemo(() => outboxStatus(entries), [entries]);
  const shown = movies.slice(0, visible);
  const remaining = movies.length - shown.length;
  return (
    <>
      <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 sm:gap-x-4 md:grid-cols-4 lg:grid-cols-5">
        {shown.map((movie) => (
          <MovieCard
            key={movie.id}
            movie={movie}
            {...(status.attention.has(movie.id)
              ? { sync: 'attention' as const }
              : status.pending.has(movie.id)
                ? { sync: 'pending' as const }
                : {})}
          />
        ))}
      </div>
      {remaining > 0 ? (
        <div className="mt-8 flex justify-center">
          <Button
            variant="secondary"
            onClick={() => {
              setVisible((count) => count + PAGE_SIZE);
            }}
          >
            Show more ({remaining} remaining)
          </Button>
        </div>
      ) : null}
    </>
  );
}

function describeFailure(error: unknown): string {
  if (error instanceof RepositoryError) {
    switch (error.appError.code) {
      case 'network':
        return 'We couldn’t reach your library. Check your connection and try again.';
      case 'forbidden':
      case 'unauthenticated':
        return 'You don’t have access to this library. Sign in again to continue.';
      default:
        return 'Something went wrong while loading your library.';
    }
  }
  return 'Something went wrong while loading your library.';
}

export function LibraryPage() {
  const { search } = useLocation();
  const { query, update, clear } = useLibraryQuery();
  const library = useMoviesQuery();
  const canCreate = useWriteAccess().can('movie:create');
  // Offering "Add" next to a library that failed to load is confusing; Try again comes first.
  const showAdd = canCreate && !library.isError;

  const all = library.data;
  const deferred = useDeferredValue(query);
  const results = useMemo(() => (all ? applyLibraryQuery(all, deferred) : []), [all, deferred]);
  const genres = useMemo(() => (all ? genreCounts(all) : []), [all]);
  const total = all?.length ?? 0;

  // A filter change resets the grid to its first page; the key carries the whole query.
  const gridKey = JSON.stringify(deferred);

  let content;
  if (library.isPending) {
    content = <LoadingGrid />;
  } else if (library.isError) {
    content = (
      <ErrorState
        title="Your library didn’t load"
        message={describeFailure(library.error)}
        onRetry={() => {
          void library.refetch();
        }}
      />
    );
  } else if (total === 0) {
    content = (
      <EmptyState
        title="Your vault is empty"
        action={
          canCreate ? (
            <Link
              to={{ pathname: '/library/new', search }}
              state={{ overlay: true }}
              className={buttonClass('primary')}
            >
              Add your first title
            </Link>
          ) : undefined
        }
      >
        {canCreate
          ? 'Add a movie or series to start building your library.'
          : 'There’s nothing to browse yet. Check back once the owner adds some titles.'}
      </EmptyState>
    );
  } else if (results.length === 0) {
    content = (
      <EmptyState
        title="No titles match"
        action={
          <Button variant="secondary" onClick={clear}>
            Clear filters
          </Button>
        }
      >
        Try a different search, or remove a filter.
      </EmptyState>
    );
  } else {
    content = <MovieGrid key={gridKey} movies={results} />;
  }

  return (
    <section>
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-gold mb-3 font-mono text-[11px] uppercase tracking-[0.22em]">
            Library
          </p>
          <h1 className="font-serif text-4xl font-semibold tracking-[-0.05em] sm:text-6xl">
            Every title, one place.
          </h1>
        </div>
        {showAdd ? (
          <Link
            to={{ pathname: '/library/new', search }}
            state={{ overlay: true }}
            // A floating action button on phones (thumb reach), a normal button from `sm` up.
            className={buttonClass(
              'primary',
              'fixed bottom-5 right-4 z-30 shadow-2xl sm:static sm:shadow-none',
            )}
          >
            <span aria-hidden="true">＋</span> Add movie
          </Link>
        ) : null}
      </header>

      {!canCreate ? (
        <p
          role="note"
          className="border-line bg-surface-2 text-muted mb-6 rounded-2xl border px-4 py-3 text-sm"
        >
          You’re signed in as a viewer. You can browse everything, but only the owner can change the
          library.
        </p>
      ) : null}

      {library.isSuccess && total > 0 ? (
        <LibraryToolbar
          query={query}
          onChange={update}
          onClear={clear}
          genres={genres}
          shown={results.length}
          total={total}
        />
      ) : null}

      {content}
      <Outlet />
    </section>
  );
}
