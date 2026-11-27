import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '@/app/ErrorBoundary';
import { resetErrorReporting, setErrorSink, type ErrorReport } from '@/app/errorReporter';
import { RouteError } from '@/app/RouteError';

function Boom(): never {
  throw new Error('render failed for yoge@example.com');
}

let seen: ErrorReport[];
beforeEach(() => {
  seen = [];
  resetErrorReporting();
  setErrorSink((r) => seen.push(r));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  setErrorSink(null);
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('shows a calm, reload-able message instead of a blank page, and reports the error scrubbed', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('CinemaVault hit a problem');
    expect(alert).toHaveTextContent('Your library is safe');
    expect(alert).not.toHaveTextContent('yoge@example.com');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ source: 'render', message: 'render failed for [email]' });
  });

  it('renders its children untouched when nothing fails', () => {
    render(
      <ErrorBoundary>
        <p>all well</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('all well')).toBeInTheDocument();
    expect(seen).toHaveLength(0);
  });
});

describe('RouteError reporting', () => {
  it('reports a failing screen through the hook', () => {
    render(
      <RouterProvider
        router={createMemoryRouter(
          [{ path: '/boom', element: <Boom />, errorElement: <RouteError /> }],
          { initialEntries: ['/boom'] },
        )}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong on this page');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ source: 'route', name: 'Error' });
  });
});
