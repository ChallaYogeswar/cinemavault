import { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMovieRepository } from '@/app/repository';
import { useSession } from '@/app/session';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import type { Movie } from '@/domain/movie';
import { FIELD_LABELS, changedFields, movieToInput } from '@/domain/movieInput';
import { can } from '@/domain/permissions';
import { isSessionChanged, type AppError } from '@/domain/result';
import { movieSchema, type MovieInputValues } from '@/domain/validation';
import { MovieForm } from './MovieForm';
import { OverlayLoading, OverlayMessage } from './OverlayMessage';
import { useMoviesQuery, useUpdateMovie } from './queries';
import { useCloseOverlay } from './useCloseOverlay';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';

type Remote =
  | { readonly kind: 'changed'; readonly movie: Movie; readonly changedAgain: boolean }
  | { readonly kind: 'deleted' };

type Inspection =
  | { readonly kind: 'changed'; readonly movie: Movie }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'failed'; readonly error: AppError };

const names = (fields: readonly (keyof MovieInputValues)[]): string =>
  fields.length === 0 ? 'nothing' : fields.map((field) => FIELD_LABELS[field]).join(', ');

function EditForm({ latest }: { readonly latest: Movie }) {
  const repository = useMovieRepository();
  // Reads made on behalf of the session that opened this form are discarded if it has ended.
  const { isCurrent } = useSession();
  const close = useCloseOverlay();
  const toast = useToast();
  const update = useUpdateMovie();
  const dirty = useRef(false);

  // The version the user STARTED from. Deliberately not the live cache: if a background refresh
  // delivered a newer version, saving must still be rejected as stale instead of overwriting it.
  const [base, setBase] = useState(latest);
  const [initial, setInitial] = useState(() => movieToInput(latest));
  const [formKey, setFormKey] = useState(0);
  const [error, setError] = useState<AppError | null>(null);
  const [attempt, setAttempt] = useState<MovieInputValues | null>(null);
  const [remote, setRemote] = useState<Remote | null>(null);
  const [checking, setChecking] = useState(false);

  useUnsavedChangesGuard(dirty);

  /**
   * Fetches the stored version and validates it with the full record schema. Anything that is not
   * a verified, current record is reported as such: a failed lookup is NOT the same as "deleted".
   */
  const inspectLatest = async (): Promise<Inspection> => {
    const fresh = await repository.get(base.id);
    if (!fresh.ok) {
      return fresh.error.code === 'not_found'
        ? { kind: 'deleted' }
        : { kind: 'failed', error: fresh.error };
    }
    if (!movieSchema.safeParse(fresh.value).success) {
      return {
        kind: 'failed',
        error: {
          code: 'unknown',
          message: 'We couldn’t verify the latest version, so nothing was overwritten.',
        },
      };
    }
    return { kind: 'changed', movie: fresh.value };
  };

  const save = async (values: MovieInputValues, expectedUpdatedAt: string) => {
    setError(null);
    setRemote(null);
    setAttempt(values);
    const result = await update.mutateAsync({ id: base.id, input: values, expectedUpdatedAt });
    if (isSessionChanged(result)) return;
    if (result.ok) {
      dirty.current = false;
      toast.show(
        'success',
        result.queued
          ? `Changes to “${result.value.title}” are saved on this device and will sync when you’re back online.`
          : `Saved changes to “${result.value.title}”.`,
      );
      close();
      return;
    }
    if (result.error.code === 'conflict' && result.error.reason === 'stale_version') {
      const seen = await inspectLatest();
      if (!isCurrent()) return;
      if (seen.kind === 'failed') setError(seen.error);
      else if (seen.kind === 'deleted') setRemote(seen);
      else setRemote({ kind: 'changed', movie: seen.movie, changedAgain: false });
      return;
    }
    setError(result.error);
    if (result.error.code === 'not_found') setRemote({ kind: 'deleted' });
  };

  /**
   * Overwrite is only ever applied to the EXACT version the user was shown. It re-fetches first;
   * if the title changed again since the banner appeared, nothing is saved and the banner is
   * refreshed so the new differences can be reviewed. The repository still version-checks the
   * write itself, which closes the remaining gap between this read and the update.
   */
  const overwrite = async (shown: Movie) => {
    if (!attempt) return;
    setChecking(true);
    try {
      const seen = await inspectLatest();
      if (!isCurrent()) return;
      if (seen.kind === 'failed') {
        setError(seen.error);
      } else if (seen.kind === 'deleted') {
        setRemote(seen);
      } else if (seen.movie.updatedAt !== shown.updatedAt) {
        setError(null);
        setRemote({ kind: 'changed', movie: seen.movie, changedAgain: true });
      } else {
        await save(attempt, shown.updatedAt);
      }
    } finally {
      setChecking(false);
    }
  };

  const loadLatest = (movie: Movie) => {
    setBase(movie);
    setInitial(movieToInput(movie));
    setFormKey((key) => key + 1); // remount the form so every field resets to the latest values
    setError(null);
    setRemote(null);
    setAttempt(null);
  };

  const conflictBanner = remote ? (
    <div
      role="alert"
      className="border-gold/40 bg-gold/5 space-y-3 rounded-2xl border px-4 py-3 text-sm"
    >
      {remote.kind === 'deleted' ? (
        <p>This title was deleted somewhere else, so your changes can’t be saved.</p>
      ) : (
        <>
          <p>This title was changed somewhere else since you opened it. Nothing was overwritten.</p>
          {remote.changedAgain ? (
            <p className="font-semibold">
              It changed again while you were deciding. Review the differences before overwriting.
            </p>
          ) : null}
          <p className="text-muted">
            Changed elsewhere:{' '}
            {names(changedFields(movieToInput(base), movieToInput(remote.movie)))}. Your edits:{' '}
            {attempt ? names(changedFields(movieToInput(base), attempt)) : 'nothing'}.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              variant="secondary"
              disabled={checking}
              onClick={() => {
                loadLatest(remote.movie);
              }}
            >
              Discard mine, load latest
            </Button>
            <Button
              variant="primary"
              disabled={attempt === null || update.isPending || checking}
              onClick={() => {
                void overwrite(remote.movie);
              }}
            >
              Keep mine, overwrite
            </Button>
          </div>
        </>
      )}
    </div>
  ) : null;

  return (
    <Dialog title={`Edit “${base.title}”`} eyebrow="Edit details" size="lg" onClose={close}>
      <MovieForm
        key={formKey}
        initial={initial}
        submitLabel="Save changes"
        submitting={update.isPending}
        serverError={error}
        dirtyRef={dirty}
        banner={conflictBanner}
        onCancel={close}
        onSubmit={(values) => {
          void save(values, base.updatedAt);
        }}
      />
    </Dialog>
  );
}

export function EditMovieDialog() {
  const { id } = useParams();
  const session = useSession();
  const close = useCloseOverlay();
  const library = useMoviesQuery();
  // Remember the title once it has been found. If a refresh later reports it deleted elsewhere, the
  // form must stay (with its explanation) instead of vanishing along with what the user typed.
  const current = library.data?.find((candidate) => candidate.id === id);
  const [opened, setOpened] = useState<Movie | null>(null);
  if (current && opened?.id !== current.id) setOpened(current);
  const movie = current ?? opened;

  if (!can(session.role, 'movie:update')) {
    return (
      <OverlayMessage
        title="View-only account"
        message="Your account can browse the library but not change it. Only the owner can edit titles."
        onClose={close}
      />
    );
  }
  if (library.isPending) return <OverlayLoading onClose={close} />;
  if (!movie) {
    return (
      <OverlayMessage
        title="Title not found"
        message="This title isn’t in your library. It may have been deleted."
        onClose={close}
      />
    );
  }
  return <EditForm key={movie.id} latest={movie} />;
}
