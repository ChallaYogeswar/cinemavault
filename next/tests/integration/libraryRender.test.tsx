import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateMovies } from '@/data/mock/fixtures';
import { PAGE_SIZE } from '@/features/library/LibraryPage';
import { renderApp } from '../renderApp';

// Every card draws its poster through this hook, so a card's render count is observable here.
const renders = vi.hoisted(() => new Map<string, number>());
vi.mock('@/features/posters/useMovieMetadata', () => ({
  useMovieMetadata: (movie: { title: string }) => {
    renders.set(movie.title, (renders.get(movie.title) ?? 0) + 1);
    return null;
  },
  useTrailerKey: () => null,
}));

beforeEach(() => {
  renders.clear();
});

describe('library rendering with many titles', () => {
  it('showing another page does not redraw the cards already on screen', async () => {
    const { user } = renderApp({ repository: { seed: generateMovies(PAGE_SIZE * 3) } });
    await screen.findByRole('button', { name: /show more/i });
    const firstPage = [...renders.keys()];
    expect(firstPage).toHaveLength(PAGE_SIZE);
    const before = new Map(renders);

    await user.click(screen.getByRole('button', { name: /show more/i }));
    await screen.findByText(/Show more \(\d+ remaining\)/);

    expect(renders.size).toBe(PAGE_SIZE * 2); // the new page was drawn…
    for (const title of firstPage) {
      expect(renders.get(title), title).toBe(before.get(title)); // …and the old one was not
    }
  });
});
