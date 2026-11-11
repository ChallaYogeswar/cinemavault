import { Link } from 'react-router-dom';
import { buttonClass } from '@/components/ui/buttonStyles';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingGrid } from '@/components/ui/states';
import { SNOOZE_DAYS } from '@/data/local/deviceData';
import { splitGenres } from '@/domain/library';
import type { KindFilter, Pick } from '@/domain/recommend';
import { MEDIA_LABEL } from '@/features/library/format';
import { Poster } from '@/features/posters/Poster';
import { TrailerLink } from '@/features/posters/TitleArtwork';
import { useMovieMetadata } from '@/features/posters/useMovieMetadata';
import { useDiscover, type Discover } from './useDiscover';

function PickCard({
  pick,
  facts,
  onAnother,
  onHide,
}: {
  readonly pick: Pick;
  readonly facts: readonly string[];
  readonly onAnother: () => void;
  readonly onHide: () => void;
}) {
  const { movie } = pick;
  const metadata = useMovieMetadata(movie);
  const eyebrow = [MEDIA_LABEL[movie.mediaType], movie.year === null ? null : String(movie.year)]
    .filter(Boolean)
    .join(' · ');
  const genres = splitGenres(movie.genre);
  return (
    <article
      aria-label="Suggested title"
      className="border-line bg-surface grid gap-6 rounded-[28px] border p-5 sm:grid-cols-[minmax(0,13rem)_1fr] sm:p-8"
    >
      <Poster movie={movie} size="detail" className="mx-auto w-44 sm:w-full" />
      <div className="flex min-w-0 flex-col">
        <p className="text-gold font-mono text-[11px] uppercase tracking-[0.2em]">{eyebrow}</p>
        <h2 className="mt-2 font-serif text-3xl font-semibold leading-tight tracking-tight sm:text-5xl">
          {movie.title}
        </h2>
        {genres.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {genres.map((g) => (
              <li
                key={g}
                className="border-line bg-surface-2 rounded-full border px-2.5 py-0.5 text-xs"
              >
                {g}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-muted mt-4 text-sm">{pick.reason}</p>
        {facts.length > 0 ? (
          <ul
            aria-label="Why this one"
            className="text-muted mt-1 list-disc space-y-0.5 pl-5 text-sm"
          >
            {facts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        ) : null}
        {metadata?.overview ? (
          <p className="mt-3 line-clamp-5 text-sm leading-relaxed">{metadata.overview}</p>
        ) : null}
        <div className="mt-4 text-sm">
          <TrailerLink movie={movie} />
        </div>
        <div className="mt-auto flex flex-col gap-2 pt-6 sm:flex-row">
          <Button variant="primary" onClick={onAnother}>
            Pick another
          </Button>
          <Link
            to={{ pathname: `/library/${movie.id}` }}
            state={{ overlay: true }}
            className={buttonClass('secondary')}
          >
            Open details
          </Link>
          <Button
            variant="ghost"
            title={`Hides this title from suggestions for ${String(SNOOZE_DAYS)} days`}
            onClick={onHide}
          >
            Not now
          </Button>
        </div>
      </div>
    </article>
  );
}

const KIND_OPTIONS: readonly {
  readonly value: KindFilter;
  readonly label: string;
  readonly key: 'all' | 'movie' | 'tv';
}[] = [
  { value: null, label: 'Everything', key: 'all' },
  { value: 'movie', label: 'Films', key: 'movie' },
  { value: 'tv', label: 'Series', key: 'tv' },
];

const chipClass = (active: boolean) =>
  `min-h-11 rounded-full border px-4 text-sm transition-colors ${
    active
      ? 'border-gold bg-gold text-bg font-semibold'
      : 'border-line bg-surface-2 text-muted hover:text-text'
  }`;

function KindChips({ discover }: { readonly discover: Discover }) {
  const { kind, kindCounts, chooseKind } = discover;
  return (
    <section aria-labelledby="discover-kind" className="mt-10">
      <h2 id="discover-kind" className="text-dim font-mono text-[10px] uppercase tracking-[0.16em]">
        Type
      </h2>
      <ul className="mt-3 flex flex-wrap gap-2">
        {KIND_OPTIONS.map((option) => (
          <li key={option.key}>
            <button
              type="button"
              aria-pressed={kind === option.value}
              className={chipClass(kind === option.value)}
              onClick={() => {
                chooseKind(option.value);
              }}
            >
              {option.label} <span className="text-xs opacity-70">{kindCounts[option.key]}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function GenreChips({ discover }: { readonly discover: Discover }) {
  const { genres, genre, choose } = discover;
  if (genres.length === 0) return null;
  const chip = chipClass;
  return (
    <section aria-labelledby="discover-genres" className="mt-10">
      <h2
        id="discover-genres"
        className="text-dim font-mono text-[10px] uppercase tracking-[0.16em]"
      >
        Draw from
      </h2>
      <ul className="mt-3 flex flex-wrap gap-2">
        <li>
          <button
            type="button"
            aria-pressed={genre === null}
            className={chip(genre === null)}
            onClick={() => {
              choose(null);
            }}
          >
            Anything
          </button>
        </li>
        {genres.map((row) => (
          <li key={row.genre}>
            <button
              type="button"
              aria-pressed={genre?.toLowerCase() === row.genre.toLowerCase()}
              className={chip(genre?.toLowerCase() === row.genre.toLowerCase())}
              onClick={() => {
                choose(row.genre);
              }}
            >
              {row.genre} <span className="text-xs opacity-70">{row.count}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DiscoverPage() {
  const discover = useDiscover();
  const {
    library,
    pick,
    pickGone,
    facts,
    eligibleCount,
    availableCount,
    kind,
    hiddenCount,
    recent,
    pickAnother,
    hide,
    chooseKind,
    showHidden,
  } = discover;

  let body;
  if (library.isPending) {
    body = <LoadingGrid count={2} />;
  } else if (library.isError) {
    body = (
      <ErrorState
        title="Discover couldn’t load your library"
        message="Check your connection and try again."
        onRetry={() => {
          void library.refetch();
        }}
      />
    );
  } else if (library.data.length === 0) {
    body = (
      <EmptyState title="Nothing to discover yet">
        Add a few titles to your library and Discover will suggest what to watch next.
      </EmptyState>
    );
  } else if (eligibleCount === 0) {
    body = (
      <EmptyState title="You’ve watched everything">
        Every title in your library is marked as watched. Add something new to get suggestions.
      </EmptyState>
    );
  } else if (pick) {
    body = (
      <PickCard
        pick={pick}
        facts={facts}
        onAnother={pickAnother}
        onHide={() => {
          hide(pick.movie.id);
        }}
      />
    );
  } else if (availableCount === 0) {
    const noun = kind === 'tv' ? 'series' : 'films';
    body =
      hiddenCount > 0 ? (
        <EmptyState
          title="Everything that fits is hidden for now"
          action={
            <Button variant="primary" onClick={showHidden}>
              Show hidden titles
            </Button>
          }
        >
          {hiddenCount === 1 ? 'One title is' : `${String(hiddenCount)} titles are`} hidden for{' '}
          {SNOOZE_DAYS} days after you chose “Not now”.
          {kind === null ? '' : ` You can also try a different type.`}
        </EmptyState>
      ) : (
        <EmptyState
          title={`No unwatched ${noun} to suggest`}
          action={
            <Button
              variant="primary"
              onClick={() => {
                chooseKind(null);
              }}
            >
              Show everything
            </Button>
          }
        >
          Everything you have of this type is marked as watched.
        </EmptyState>
      );
  } else if (pickGone) {
    body = (
      <EmptyState
        title="That title just changed"
        action={
          <Button variant="primary" onClick={pickAnother}>
            Pick another
          </Button>
        }
      >
        It was watched or removed while you were here.
      </EmptyState>
    );
  } else {
    body = <LoadingGrid count={2} />;
  }

  return (
    <section>
      <header className="mb-8">
        <p className="text-gold mb-3 font-mono text-[11px] uppercase tracking-[0.22em]">Discover</p>
        <h1 className="font-serif text-4xl font-semibold tracking-[-0.05em] sm:text-6xl">
          Tonight’s pick.
        </h1>
      </header>
      {body}
      {library.isSuccess && eligibleCount > 0 ? <KindChips discover={discover} /> : null}
      {library.isSuccess && availableCount > 0 ? <GenreChips discover={discover} /> : null}
      {library.isSuccess && availableCount > 0 && hiddenCount > 0 ? (
        <p role="status" className="text-muted mt-8 text-sm">
          {hiddenCount === 1 ? '1 title is' : `${String(hiddenCount)} titles are`} hidden for{' '}
          {SNOOZE_DAYS} days.{' '}
          <button
            type="button"
            className="text-gold underline underline-offset-2"
            onClick={showHidden}
          >
            Show {hiddenCount === 1 ? 'it' : 'them'} again
          </button>
        </p>
      ) : null}
      {recent.length > 0 ? (
        <section aria-labelledby="discover-recent" className="mt-10">
          <h2
            id="discover-recent"
            className="text-dim font-mono text-[10px] uppercase tracking-[0.16em]"
          >
            Suggested lately
          </h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {recent.map((movie) => (
              <li key={movie.id}>
                <Link
                  to={{ pathname: `/library/${movie.id}` }}
                  state={{ overlay: true }}
                  className="border-line bg-surface-2 hover:bg-surface-3 inline-flex min-h-11 items-center rounded-full border px-4 text-sm"
                >
                  {movie.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
