import { useEffect, type RefObject, type ReactNode } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { MEDIA_TYPES } from '@/domain/movie';
import type { AppError } from '@/domain/result';
import { movieInputSchema, type MovieInputValues } from '@/domain/validation';
import { MEDIA_LABEL } from './format';
import { RatingControl } from './RatingControl';

type FormInput = z.input<typeof movieInputSchema>;

const inputClass =
  'scroll-mt-20 bg-surface-2 border-line text-text placeholder:text-dim min-h-11 w-full rounded-2xl border px-3.5 text-sm outline-none focus-visible:border-gold aria-[invalid=true]:border-danger';

interface FieldProps {
  readonly id: string;
  readonly label: string;
  readonly error: string | undefined;
  readonly hint?: string;
  readonly children: (a11y: {
    id: string;
    'aria-invalid': boolean;
    'aria-describedby': string | undefined;
  }) => ReactNode;
}

function Field({ id, label, error, hint, children }: FieldProps) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-semibold">
        {label}
      </label>
      {children({ id, 'aria-invalid': Boolean(error), 'aria-describedby': describedBy })}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-danger mt-1.5 text-xs">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-dim mt-1.5 text-xs">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const toNumberOrNull = (raw: unknown): number | null =>
  raw === '' || raw === null || raw === undefined ? null : Number(raw);
const toStringOrNull = (raw: unknown): string | null =>
  typeof raw === 'string' && raw !== '' ? raw : null;

interface Props {
  readonly initial: MovieInputValues;
  readonly submitLabel: string;
  readonly submitting: boolean;
  /** Error from the last save attempt. A duplicate title is shown on the title field. */
  readonly serverError: AppError | null;
  readonly onSubmit: (values: MovieInputValues) => void;
  readonly onCancel: () => void;
  /** Lets the parent ask "are there unsaved edits?" before closing the dialog. */
  readonly dirtyRef: RefObject<boolean>;
  /** Extra content above the buttons, e.g. the edit-conflict panel. */
  readonly banner?: ReactNode;
}

export function MovieForm({
  initial,
  submitLabel,
  submitting,
  serverError,
  onSubmit,
  onCancel,
  dirtyRef,
  banner,
}: Props) {
  const {
    register,
    control,
    handleSubmit,
    setValue,
    setError,
    formState: { errors, isDirty },
  } = useForm<FormInput, unknown, MovieInputValues>({
    resolver: zodResolver(movieInputSchema),
    defaultValues: initial,
  });

  useEffect(() => {
    dirtyRef.current = isDirty;
  }, [dirtyRef, isDirty]);

  useEffect(() => {
    if (serverError?.code === 'conflict' && serverError.reason === 'duplicate_identity') {
      setError('title', { type: 'server', message: serverError.message }, { shouldFocus: true });
    }
  }, [serverError, setError]);

  const watched = useWatch({ control, name: 'watched' });
  const showBanner =
    serverError !== null &&
    !(serverError.code === 'conflict' && serverError.reason === 'duplicate_identity') &&
    !(serverError.code === 'conflict' && serverError.reason === 'stale_version');

  return (
    <form
      noValidate
      onSubmit={(event) => {
        void handleSubmit(onSubmit)(event);
      }}
      className="space-y-4"
    >
      <Field id="title" label="Title" error={errors.title?.message}>
        {(a11y) => (
          <input
            {...a11y}
            {...register('title')}
            type="text"
            autoComplete="off"
            maxLength={200}
            className={inputClass}
          />
        )}
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field id="mediaType" label="Type" error={errors.mediaType?.message}>
          {(a11y) => (
            <select {...a11y} {...register('mediaType')} className={inputClass}>
              {MEDIA_TYPES.map((type) => (
                <option key={type} value={type}>
                  {MEDIA_LABEL[type]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="year" label="Year" error={errors.year?.message}>
          {(a11y) => (
            <input
              {...a11y}
              {...register('year', { setValueAs: toNumberOrNull })}
              type="number"
              inputMode="numeric"
              placeholder="2023"
              className={inputClass}
            />
          )}
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field id="genre" label="Genre" error={errors.genre?.message} hint="Comma-separated">
          {(a11y) => (
            <input
              {...a11y}
              {...register('genre', { setValueAs: toStringOrNull })}
              type="text"
              placeholder="Thriller, Drama"
              className={inputClass}
            />
          )}
        </Field>
        <Field id="runtimeMinutes" label="Runtime (min)" error={errors.runtimeMinutes?.message}>
          {(a11y) => (
            <input
              {...a11y}
              {...register('runtimeMinutes', { setValueAs: toNumberOrNull })}
              type="number"
              inputMode="numeric"
              placeholder="120"
              className={inputClass}
            />
          )}
        </Field>
      </div>

      <div className="border-line rounded-2xl border p-3.5">
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-semibold">
          <input
            type="checkbox"
            className="accent-gold size-5"
            {...register('watched', {
              onChange: (event: { target: { checked: boolean } }) => {
                if (!event.target.checked) setValue('watchedOn', null, { shouldDirty: true });
              },
            })}
          />
          I’ve watched this
        </label>
        {watched ? (
          <div className="mt-3">
            <Field id="watchedOn" label="Watched on" error={errors.watchedOn?.message}>
              {(a11y) => (
                <input
                  {...a11y}
                  {...register('watchedOn', { setValueAs: toStringOrNull })}
                  type="date"
                  className={inputClass}
                />
              )}
            </Field>
          </div>
        ) : null}
      </div>

      <div>
        <p className="mb-1 text-[13px] font-semibold" id="rating-label">
          Your rating
        </p>
        <Controller
          control={control}
          name="userRating"
          render={({ field }) => (
            <RatingControl
              label="Your rating"
              value={field.value}
              onChange={(next) => {
                field.onChange(next);
              }}
            />
          )}
        />
        {errors.userRating ? (
          <p role="alert" className="text-danger mt-1.5 text-xs">
            {errors.userRating.message}
          </p>
        ) : null}
      </div>

      <Field id="verdict" label="Your verdict" error={errors.verdict?.message}>
        {(a11y) => (
          <textarea
            {...a11y}
            {...register('verdict', { setValueAs: toStringOrNull })}
            rows={3}
            placeholder="One line you’ll thank yourself for later."
            className={`${inputClass} py-3`}
          />
        )}
      </Field>

      <Field id="technicalNotes" label="Technical notes" error={errors.technicalNotes?.message}>
        {(a11y) => (
          <textarea
            {...a11y}
            {...register('technicalNotes', { setValueAs: toStringOrNull })}
            rows={2}
            className={`${inputClass} py-3`}
          />
        )}
      </Field>

      <Field id="shotLink" label="Screenshot link" error={errors.shotLink?.message}>
        {(a11y) => (
          <input
            {...a11y}
            {...register('shotLink', { setValueAs: toStringOrNull })}
            type="url"
            inputMode="url"
            placeholder="https://…"
            className={inputClass}
          />
        )}
      </Field>

      {banner}
      {showBanner ? (
        <p
          role="alert"
          className="border-danger/40 bg-danger/5 rounded-2xl border px-4 py-3 text-sm"
        >
          {serverError.message}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
