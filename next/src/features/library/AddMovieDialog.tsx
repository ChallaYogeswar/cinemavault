import { useRef, useState } from 'react';
import { useSession } from '@/app/session';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { EMPTY_MOVIE_INPUT } from '@/domain/movieInput';
import { can } from '@/domain/permissions';
import { isSessionChanged, type AppError } from '@/domain/result';
import type { MovieInputValues } from '@/domain/validation';
import { MovieForm } from './MovieForm';
import { OverlayMessage } from './OverlayMessage';
import { useCreateMovie } from './queries';
import { useCloseOverlay } from './useCloseOverlay';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';

export function AddMovieDialog() {
  const session = useSession();
  const close = useCloseOverlay();
  const toast = useToast();
  const create = useCreateMovie();
  const dirty = useRef(false);
  const [error, setError] = useState<AppError | null>(null);

  useUnsavedChangesGuard(dirty); // every way out of this dialog is guarded, not just the buttons

  if (!can(session.role, 'movie:create')) {
    return (
      <OverlayMessage
        title="View-only account"
        message="Your account can browse the library but not change it. Only the owner can add titles."
        onClose={close}
      />
    );
  }

  const submit = async (values: MovieInputValues) => {
    setError(null);
    const result = await create.mutateAsync(values);
    if (isSessionChanged(result)) return; // belongs to a previous account: show/do nothing
    if (result.ok) {
      dirty.current = false;
      toast.show(
        'success',
        result.queued
          ? `“${result.value.title}” is saved on this device and will sync when you’re back online.`
          : `Added “${result.value.title}”.`,
      );
      close();
    } else {
      setError(result.error);
    }
  };

  return (
    <Dialog title="Add a title" eyebrow="New" size="lg" onClose={close}>
      <MovieForm
        initial={EMPTY_MOVIE_INPUT}
        submitLabel="Add to library"
        submitting={create.isPending}
        serverError={error}
        dirtyRef={dirty}
        onCancel={close}
        onSubmit={(values) => {
          void submit(values);
        }}
      />
    </Dialog>
  );
}
