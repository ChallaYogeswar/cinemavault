import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isChunkLoadError } from '@/app/chunkError';
import { RouteError } from '@/app/RouteError';

afterEach(() => {
  vi.restoreAllMocks();
});

function Boom(): never {
  throw new Error('secret internal detail: db password is hunter2');
}

const show = (element: React.ReactNode) => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  render(
    <RouterProvider
      router={createMemoryRouter(
        [
          { path: '/', element: <p>home</p> },
          { path: '/boom', element, errorElement: <RouteError /> },
        ],
        { initialEntries: ['/boom'] },
      )}
    />,
  );
};

describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://x/assets/Stats-1.js',
    'Importing a module script failed.',
    'error loading dynamically imported module',
    'Loading chunk 12 failed.',
  ])('recognizes: %s', (message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
  });

  it('does not mistake an ordinary error for one', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError('nope')).toBe(false);
  });
});

describe('the error screen', () => {
  it('replaces a crashing screen with a calm message, without leaking the error', () => {
    show(<Boom />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong on this page');
    expect(alert).toHaveTextContent('Your library is safe');
    expect(document.body.textContent).not.toContain('hunter2');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to home' })).toHaveAttribute('href', '/');
  });

  it('explains a part of the app that could not be downloaded', () => {
    function Missing(): never {
      throw new TypeError('Failed to fetch dynamically imported module: /assets/Stats-1.js');
    }
    show(<Missing />);
    expect(screen.getByRole('alert')).toHaveTextContent('This page couldn’t be loaded');
    expect(screen.getByRole('alert')).toHaveTextContent('offline');
  });

  it('reloads the page when asked', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    show(<Boom />);
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
