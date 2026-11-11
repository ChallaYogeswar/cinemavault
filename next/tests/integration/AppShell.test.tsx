import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../renderApp';

const renderAt = (path: string) => renderApp({ path });

describe('app shell', () => {
  it('renders the brand, primary navigation and home content', () => {
    renderAt('/');
    expect(screen.getByRole('link', { name: 'CinemaVault' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: /primary/i });
    for (const label of ['Home', 'Library', 'Genres', 'Discover', 'Stats']) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/your cinema/i);
  });

  it('navigates between sections', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await user.click(screen.getByRole('link', { name: 'Library' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: /every title/i }),
    ).toBeInTheDocument();
  });

  it('marks the active section for assistive tech', async () => {
    renderAt('/stats');
    expect(await screen.findByRole('link', { name: 'Stats' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('offers a skip link and a main landmark', () => {
    renderAt('/');
    expect(screen.getByRole('link', { name: /skip to content/i })).toHaveAttribute(
      'href',
      '#main-content',
    );
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  });

  it('the skip link moves focus to main without adding a history entry', async () => {
    const user = userEvent.setup();
    renderAt('/');
    const before = window.history.length;
    await user.click(screen.getByRole('link', { name: /skip to content/i }));
    expect(screen.getByRole('main')).toHaveFocus();
    expect(window.history.length).toBe(before);
    expect(window.location.hash).toBe('');
  });

  it('shows a not-found page for unknown routes', () => {
    renderAt('/nope');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/isn.t in the vault/i);
  });

  it('settings says plainly that this build is running on sample data', async () => {
    renderAt('/settings');
    await screen.findByRole('heading', { level: 2, name: 'Data' });
    expect(screen.getByRole('status')).toHaveTextContent(/running on sample data/i);
  });
});
