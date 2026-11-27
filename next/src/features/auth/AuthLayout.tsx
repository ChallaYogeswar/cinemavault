import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function AuthLayout({
  title,
  intro,
  children,
  footer,
}: {
  readonly title: string;
  readonly intro?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}) {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <Link to="/" className="mb-8 block text-center font-extrabold tracking-tight">
          CinemaVault
        </Link>
        <div className="border-line bg-surface/70 rounded-[28px] border p-6 sm:p-8">
          <h1 className="font-serif text-3xl font-semibold tracking-tight">{title}</h1>
          {intro ? <p className="text-muted mt-2 text-sm leading-relaxed">{intro}</p> : null}
          <div className="mt-6">{children}</div>
        </div>
        {footer ? <div className="text-muted mt-6 text-center text-sm">{footer}</div> : null}
      </div>
    </main>
  );
}
