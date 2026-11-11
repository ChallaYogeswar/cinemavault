import type { ReactNode } from 'react';
import { Button } from './Button';

/** Skeleton grid shown while the library loads; same grid as the real one so nothing jumps. */
export function LoadingGrid({ count = 10 }: { readonly count?: number }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading your library…</span>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} aria-hidden="true">
            <div className="bg-surface-2 aspect-[2/3] animate-pulse rounded-2xl" />
            <div className="bg-surface-2 mt-3 h-3.5 w-4/5 animate-pulse rounded" />
            <div className="bg-surface-2 mt-2 h-3 w-1/2 animate-pulse rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

interface EmptyProps {
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}

export function EmptyState({ title, children, action }: EmptyProps) {
  return (
    <div className="border-line rounded-[28px] border border-dashed px-6 py-14 text-center sm:py-20">
      <p aria-hidden="true" className="text-gold mb-4 font-serif text-5xl leading-none">
        ◌
      </p>
      <h2 className="font-serif text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h2>
      {children ? (
        <p className="text-muted mx-auto mt-3 max-w-md text-sm leading-relaxed sm:text-base">
          {children}
        </p>
      ) : null}
      {action ? <div className="mt-6 flex justify-center">{action}</div> : null}
    </div>
  );
}

interface ErrorProps {
  readonly title: string;
  readonly message: string;
  readonly onRetry?: () => void;
}

export function ErrorState({ title, message, onRetry }: ErrorProps) {
  return (
    <div
      role="alert"
      className="border-danger/40 bg-danger/5 rounded-[28px] border px-6 py-12 text-center sm:py-16"
    >
      <h2 className="font-serif text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h2>
      <p className="text-muted mx-auto mt-3 max-w-md text-sm leading-relaxed sm:text-base">
        {message}
      </p>
      {onRetry ? (
        <div className="mt-6 flex justify-center">
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
