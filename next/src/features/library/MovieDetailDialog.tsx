import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { buttonClass } from '@/components/ui/buttonStyles';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { splitGenres } from '@/domain/library';
import type { Movie } from '@/domain/movie';
import { movieToInput } from '@/domain/movieInput';
import { isSessionChanged } from '@/domain/result';
import { TitleArtwork } from '@/features/posters/TitleArtwork';
import { MEDIA_LABEL, formatRuntime, formatWatchedOn, safeHttpUrl } from './format';
import { OverlayLoading, OverlayMessage } from './OverlayMessage';
import { RatingControl } from './RatingControl';
import { useMoviesQuery, useRemoveMovie, useUpdateMovie, useWriteAccess } from './queries';
import { useCloseOverlay } from './useCloseOverlay';

function Fact({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-dim font-mono text-[10px] uppercase tracking-[0.16em]">{label}</dt>
      <dd className="mt-1 text-sm leading-relaxed">{children}</dd>
    </div>
  );
}

function Detail({ movie }: { readonly movie: Movie }) {
  const { search } = useLocation();
  const close = useCloseOverlay();
  const toast = useToast();
  const update = useUpdateMovie();
  const remove = useRemoveMovie();
  const [confirming, setConfirming] = useState(false);

  // Entry points only: a form that is already open is never taken away mid-edit (EditMovieDialog).
  const access = useWriteAccess();
  const canEdit = access.can('movie:update');
  const canDelete = access.can('movie:delete');
  const genres = splitGenres(movie.genre);
  const link = safeHttpUrl(movie.shotLink);

  const rate = async (next: number | null) => {
    const result = await update.mutateAsync({
      id: movie.id,
      input: { ...movieToInput(movie), userRating: next },
      expectedUpdatedAt: movie.updatedAt,
    });
    if (isSessionChanged(result)) return;
    if (!result.ok) {
      toast.show(
        'error',
        result.error.code === 'conflict'
          ? 'This title changed somewhere else, so the rating wasn’t saved. It has been refreshed.'
          : result.error.message,
      );
    }
  };

  const confirmDelete = async () => {
    const result = await remove.mutateAsync({ id: movie.id, expectedUpdatedAt: movie.updatedAt });
    if (isSessionChanged(result)) return;
    if (result.ok) {
      toast.show('success', `Deleted “${movie.title}”.`);
      close();
    } else {
      toast.show('error', result.error.message);
      setConfirming(false);
    }
  };

  const eyebrow = [MEDIA_LABEL[movie.mediaType], movie.year === null ? null : String(movie.year)]
    .filter(Boolean)
    .join(' · ');

  return (
    <Dialog title={movie.title} eyebrow={eyebrow} size="lg" onClose={close}>
      <div className="space-y-6">
        <TitleArtwork movie={movie} />
        <RatingControl
          value={movie.userRating}
          disabled={update.isPending}
          {...(canEdit
            ? {
                onChange: (next: number | null) => {
                  void rate(next);
                },
              }
            : {})}
        />

        <dl className="grid gap-5 sm:grid-cols-2">
          <Fact label="Status">
            {movie.watched
              ? movie.watchedOn
                ? `Watched on ${formatWatchedOn(movie.watchedOn)}`
                : 'Watched'
              : 'On the to-watch list'}
          </Fact>
          {movie.runtimeMinutes !== null ? (
            <Fact label="Runtime">{formatRuntime(movie.runtimeMinutes)}</Fact>
          ) : null}
          {genres.length > 0 ? (
            <Fact label="Genre">
              <ul className="flex flex-wrap gap-1.5">
                {genres.map((genre) => (
                  <li
                    key={genre}
                    className="border-line bg-surface-2 rounded-full border px-2.5 py-0.5 text-xs"
                  >
                    {genre}
                  </li>
                ))}
              </ul>
            </Fact>
          ) : null}
          {movie.verdict ? (
            <div className="sm:col-span-2">
              <Fact label="Verdict">
                <span className="whitespace-pre-line">{movie.verdict}</span>
              </Fact>
            </div>
          ) : null}
          {movie.technicalNotes ? (
            <div className="sm:col-span-2">
              <Fact label="Technical notes">
                <span className="whitespace-pre-line">{movie.technicalNotes}</span>
              </Fact>
            </div>
          ) : null}
          {movie.shotLink ? (
            <div className="sm:col-span-2">
              <Fact label="Screenshot">
                {link ? (
                  <a
                    href={link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-gold break-all underline underline-offset-4"
                  >
                    {link}
                  </a>
                ) : (
                  <span className="break-all">{movie.shotLink}</span>
                )}
              </Fact>
            </div>
          ) : null}
        </dl>

        {canEdit || canDelete ? (
          confirming ? (
            <div
              role="alertdialog"
              aria-label="Confirm delete"
              className="border-danger/40 bg-danger/5 rounded-2xl border p-4"
            >
              <p className="text-sm">
                Delete <strong>{movie.title}</strong>? It will disappear from your library on every
                device. You can add it again later.
              </p>
              <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  variant="ghost"
                  disabled={remove.isPending}
                  onClick={() => {
                    setConfirming(false);
                  }}
                >
                  Keep it
                </Button>
                <Button
                  variant="danger"
                  disabled={remove.isPending}
                  onClick={() => {
                    void confirmDelete();
                  }}
                >
                  {remove.isPending ? 'Deleting…' : 'Delete title'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              {canDelete ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setConfirming(true);
                  }}
                >
                  Delete
                </Button>
              ) : null}
              {canEdit ? (
                <Link
                  to={{ pathname: `/library/${movie.id}/edit`, search }}
                  state={{ overlay: true }}
                  className={buttonClass('primary')}
                >
                  Edit details
                </Link>
              ) : null}
            </div>
          )
        ) : null}
      </div>
    </Dialog>
  );
}

export function MovieDetailDialog() {
  const { id } = useParams();
  const close = useCloseOverlay();
  const library = useMoviesQuery();

  if (library.isPending) return <OverlayLoading onClose={close} />;
  const movie = library.data?.find((candidate) => candidate.id === id);
  if (!movie) {
    return (
      <OverlayMessage
        title="Title not found"
        message="This title isn’t in your library. It may have been deleted."
        onClose={close}
      />
    );
  }
  return <Detail movie={movie} />;
}
