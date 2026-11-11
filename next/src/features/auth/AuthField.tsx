const inputClass =
  'bg-surface-2 border-line text-text placeholder:text-dim min-h-11 w-full rounded-2xl border px-3.5 text-sm outline-none focus-visible:border-gold aria-[invalid=true]:border-danger';

interface Props {
  readonly id: string;
  readonly label: string;
  readonly type: 'email' | 'password' | 'text';
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly error: string | undefined;
  readonly autoComplete: string;
  readonly hint?: string;
}

export function AuthField({ id, label, type, value, onChange, error, autoComplete, hint }: Props) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-semibold">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={inputClass}
      />
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

export function FormError({ message }: { readonly message: string | null }) {
  return message ? (
    <p role="alert" className="border-danger/40 bg-danger/5 rounded-2xl border px-4 py-3 text-sm">
      {message}
    </p>
  ) : null;
}
