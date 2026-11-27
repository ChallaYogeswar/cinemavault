import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, ErrorState, LoadingGrid } from '@/components/ui/states';
import { computeStats, type Stats } from '@/domain/stats';
import { useMoviesQuery } from '@/features/library/queries';
import { formatHours, monthLabel } from './format';

const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="border-line bg-surface rounded-3xl border p-5">
      <dt className="text-muted font-mono text-[11px] uppercase tracking-[0.18em]">{label}</dt>
      <dd className="mt-2 font-serif text-4xl font-semibold tracking-tight">{value}</dd>
      {note ? <dd className="text-muted mt-1 text-sm">{note}</dd> : null}
    </div>
  );
}

/** A horizontal bar; the figures are always printed as text, so the bar is decoration only. */
function Bar({
  label,
  value,
  max,
  text,
}: {
  label: string;
  value: number;
  max: number;
  text: string;
}) {
  const width = max > 0 ? Math.max(value > 0 ? 3 : 0, Math.round((value / max) * 100)) : 0;
  return (
    <li className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-3 text-sm">
      <span className="truncate">{label}</span>
      <span aria-hidden="true" className="bg-line/60 h-2 overflow-hidden rounded-full">
        <span
          className="bg-gold block h-full rounded-full"
          style={{ width: `${String(width)}%` }}
        />
      </span>
      <span className="text-muted tabular-nums">{text}</span>
    </li>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-line bg-surface rounded-3xl border p-5">
      <h2 className="font-serif text-xl font-semibold tracking-tight">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function StatsBody({ stats }: { stats: Stats }) {
  const { rating, backlog } = stats;
  const maxGenre = stats.genres[0]?.total ?? 0;
  const maxMonth = Math.max(0, ...stats.months.map((m) => m.count));
  const maxRating = Math.max(0, ...rating.buckets);
  const maxBacklog = backlog.byGenre[0]?.count ?? 0;

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="In the vault"
          value={String(stats.total)}
          note={`${plural(stats.films, 'film')} · ${plural(stats.series, 'series', 'series')}`}
        />
        <Tile
          label="Watched"
          value={String(stats.watched)}
          note={`${String(stats.completionPercent)}% of the vault`}
        />
        <Tile label="Still to watch" value={String(stats.unwatched)} />
        <Tile
          label="Average rating"
          value={rating.average === null ? '—' : `${rating.average.toFixed(1)} / 5`}
          note={rating.rated === 0 ? 'No ratings yet' : `from ${plural(rating.rated, 'rating')}`}
        />
      </dl>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Watched, last 12 months">
          <ul className="space-y-2">
            {stats.months.map((m) => (
              <Bar
                key={m.month}
                label={monthLabel(m.month)}
                value={m.count}
                max={maxMonth}
                text={String(m.count)}
              />
            ))}
          </ul>
          <p className="text-muted mt-4 text-sm">
            {stats.watchedThisYear === 0
              ? 'Nothing logged as watched this year yet.'
              : `${plural(stats.watchedThisYear, 'title')} watched this year.`}
            {stats.lastWatchedOn ? ` Last one on ${stats.lastWatchedOn}.` : ''}
          </p>
        </Card>

        <Card title="Watched by year">
          {stats.years.length === 0 ? (
            <p className="text-muted text-sm">
              Mark a title as watched with a date and it will show up here.
            </p>
          ) : (
            <ul className="space-y-2">
              {stats.years.map((y) => (
                <Bar
                  key={y.year}
                  label={String(y.year)}
                  value={y.count}
                  max={stats.years[0] ? Math.max(...stats.years.map((v) => v.count)) : 0}
                  text={String(y.count)}
                />
              ))}
            </ul>
          )}
          {stats.watchedMinutes > 0 ? (
            <p className="text-muted mt-4 text-sm">
              About {formatHours(stats.watchedMinutes)} of runtime across everything watched.
            </p>
          ) : null}
        </Card>

        <Card title="Most watched genres">
          {stats.mostWatchedGenres.length === 0 ? (
            <p className="text-muted text-sm">Nothing watched yet, so no favourites to show.</p>
          ) : (
            <ul className="space-y-2">
              {stats.mostWatchedGenres.map((g) => (
                <Bar
                  key={g.genre}
                  label={g.genre}
                  value={g.watched}
                  max={stats.mostWatchedGenres[0]?.watched ?? 0}
                  text={`${String(g.watched)} watched`}
                />
              ))}
            </ul>
          )}
        </Card>

        <Card title="Your ratings">
          {rating.rated === 0 ? (
            <p className="text-muted text-sm">Rate a title and the spread will appear here.</p>
          ) : (
            <ul className="space-y-2">
              {[5, 4, 3, 2, 1, 0].map((stars) => (
                <Bar
                  key={stars}
                  label={stars === 0 ? 'Under 1 star' : plural(stars, 'star')}
                  value={rating.buckets[stars] ?? 0}
                  max={maxRating}
                  text={String(rating.buckets[stars] ?? 0)}
                />
              ))}
            </ul>
          )}
        </Card>

        <Card title="Library by genre">
          {stats.genres.length === 0 ? (
            <p className="text-muted text-sm">No genres yet.</p>
          ) : (
            <ul className="space-y-2">
              {stats.genres.slice(0, 10).map((g) => (
                <Bar
                  key={g.genre}
                  label={g.genre}
                  value={g.total}
                  max={maxGenre}
                  text={`${String(g.watched)}/${String(g.total)}`}
                />
              ))}
            </ul>
          )}
          {stats.genres.length > 10 ? (
            <p className="text-muted mt-3 text-sm">
              <Link to="/genres" className="underline">
                See all {stats.genres.length} genres
              </Link>
            </p>
          ) : null}
        </Card>

        <Card title="Watchlist backlog">
          {backlog.count === 0 ? (
            <p className="text-muted text-sm">Nothing waiting. The backlog is clear.</p>
          ) : (
            <>
              <p className="text-sm">
                {plural(backlog.count, 'title')} waiting
                {backlog.knownMinutes > 0
                  ? `, about ${formatHours(backlog.knownMinutes)} of viewing`
                  : ''}
                .
                {backlog.unknownRuntime > 0
                  ? ` ${plural(backlog.unknownRuntime, 'title')} with no runtime recorded.`
                  : ''}
              </p>
              <ul className="mt-4 space-y-2">
                {backlog.byGenre.map((g) => (
                  <Bar
                    key={g.genre}
                    label={g.genre}
                    value={g.count}
                    max={maxBacklog}
                    text={String(g.count)}
                  />
                ))}
              </ul>
              <h3 className="text-muted mt-5 font-mono text-[11px] uppercase tracking-[0.18em]">
                Waiting the longest
              </h3>
              <ul className="mt-2 space-y-1 text-sm">
                {backlog.longestWaiting.map((m) => (
                  <li key={m.id}>
                    <Link to={`/library/${m.id}`} className="underline-offset-2 hover:underline">
                      {m.title}
                    </Link>
                    <span className="text-muted"> · added {m.createdAt.slice(0, 10)}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-4">
                <Link
                  to="/discover"
                  className="text-gold text-sm underline-offset-2 hover:underline"
                >
                  Pick something from the backlog
                </Link>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

export function StatsPage() {
  const library = useMoviesQuery();
  const stats = useMemo(
    () => (library.data ? computeStats(library.data, new Date()) : null),
    [library.data],
  );

  let body;
  if (library.isPending) body = <LoadingGrid count={4} />;
  else if (library.isError || !stats) {
    body = (
      <ErrorState
        title="Statistics couldn’t load"
        message="Check your connection and try again."
        onRetry={() => {
          void library.refetch();
        }}
      />
    );
  } else if (stats.total === 0) {
    body = (
      <EmptyState title="Nothing to count yet">
        Add a few titles and mark some as watched. Your numbers will build up here.
      </EmptyState>
    );
  } else body = <StatsBody stats={stats} />;

  return (
    <section>
      <header className="mb-8">
        <p className="text-gold mb-3 font-mono text-[11px] uppercase tracking-[0.22em]">Stats</p>
        <h1 className="font-serif text-4xl font-semibold tracking-[-0.05em] sm:text-6xl">
          Your taste, in numbers.
        </h1>
      </header>
      {body}
    </section>
  );
}
