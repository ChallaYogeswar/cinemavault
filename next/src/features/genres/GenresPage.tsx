import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, ErrorState, LoadingGrid } from '@/components/ui/states';
import { buttonClass } from '@/components/ui/buttonStyles';
import { summarizeGenres } from '@/domain/genres';
import { UNCATEGORIZED } from '@/domain/recommend';
import { useMoviesQuery } from '@/features/library/queries';

export function GenresPage() {
  const library = useMoviesQuery();
  const rows = useMemo(() => summarizeGenres(library.data ?? []), [library.data]);

  let body;
  if (library.isPending) body = <LoadingGrid count={6} />;
  else if (library.isError) {
    body = (
      <ErrorState
        title="Genres couldn’t load"
        message="Check your connection and try again."
        onRetry={() => {
          void library.refetch();
        }}
      />
    );
  } else if (rows.length === 0) {
    body = (
      <EmptyState title="No genres yet">
        Add titles with a genre and they will be grouped here.
      </EmptyState>
    );
  } else {
    body = (
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => (
          <li
            key={row.genre}
            className="border-line bg-surface flex flex-col rounded-3xl border p-5"
          >
            <h2 className="font-serif text-2xl font-semibold tracking-tight">{row.genre}</h2>
            <p className="text-muted mt-1 text-sm">
              {row.total} {row.total === 1 ? 'title' : 'titles'} · {row.unwatched} to watch
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              {row.genre !== UNCATEGORIZED ? (
                <Link
                  to={{ pathname: '/library', search: `?genre=${encodeURIComponent(row.genre)}` }}
                  className={buttonClass('secondary')}
                >
                  Browse
                </Link>
              ) : null}
              {row.unwatched > 0 ? (
                <Link
                  to={{ pathname: '/discover', search: `?genre=${encodeURIComponent(row.genre)}` }}
                  className={buttonClass('ghost')}
                >
                  Pick one to watch
                </Link>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section>
      <header className="mb-8">
        <p className="text-gold mb-3 font-mono text-[11px] uppercase tracking-[0.22em]">Genres</p>
        <h1 className="font-serif text-4xl font-semibold tracking-[-0.05em] sm:text-6xl">
          Every world has a story.
        </h1>
      </header>
      {body}
    </section>
  );
}
