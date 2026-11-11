import { onlineManager } from '@tanstack/react-query';
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMovie } from '@/data/mock/fixtures';
import type { Movie } from '@/domain/movie';
import { createFakeAuth } from '../fakes/fakeAuthService';
import { createFakeProfiles } from '../fakes/fakeProfiles';
import { OWNER_ID, renderFullApp } from '../renderFullApp';

type Row = Parameters<typeof buildMovie>[1];
const thisYear = new Date().getFullYear();
const iso = (monthsBack: number) => {
  const d = new Date(new Date().getFullYear(), new Date().getMonth() - monthsBack, 10);
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-10`;
};

const title = (
  n: number,
  name: string,
  genre: string | null,
  watchedOn: string,
  rating: number | null = null,
  type: 'movie' | 'tv' = 'movie',
): Movie =>
  buildMovie(800 + n, [name, type, 2000 + n, genre, 120, rating, watchedOn, null] as Row, OWNER_ID);

let library: Movie[];

const boot = () =>
  renderFullApp({
    auth: createFakeAuth(
      [{ id: OWNER_ID, email: 'o@example.com', password: 'pw-owner-1' }],
      OWNER_ID,
    ),
    profiles: createFakeProfiles({ [OWNER_ID]: { role: 'owner' } }),
    path: '/stats',
    libraryFor: () => library,
  });

beforeEach(() => {
  onlineManager.setOnline(true);
  library = [
    title(1, 'Seen A', 'Drama', iso(0), 4),
    title(2, 'Seen B', 'Drama', iso(1), 5),
    title(3, 'Seen C', 'Comedy', iso(2), 3, 'tv'),
    title(4, 'Waiting Old', 'Drama', 'unwatched'),
    title(5, 'Waiting New', 'Comedy', 'unwatched'),
  ];
});
afterEach(() => {
  onlineManager.setOnline(true);
});

const tile = (label: string) => {
  const dt = screen.getByText(label, { selector: 'dt' });
  const box = dt.parentElement;
  if (!box) throw new Error('no tile');
  return within(box);
};

describe('the Statistics page', () => {
  it('shows totals, completion and the average rating from the library', async () => {
    boot();
    await screen.findByRole('heading', { name: 'Your taste, in numbers.' });
    await screen.findByText('Watched', { selector: 'dt' });
    expect(tile('In the vault').getByText('5')).toBeInTheDocument();
    expect(tile('In the vault').getByText('4 films · 1 series')).toBeInTheDocument();
    expect(tile('Watched').getByText('3')).toBeInTheDocument();
    expect(tile('Watched').getByText('60% of the vault')).toBeInTheDocument();
    expect(tile('Still to watch').getByText('2')).toBeInTheDocument();
    expect(tile('Average rating').getByText('4.0 / 5')).toBeInTheDocument();
    expect(tile('Average rating').getByText('from 3 ratings')).toBeInTheDocument();
  });

  it('lists the most watched genres, the yearly total and the backlog', async () => {
    boot();
    const genres = await screen.findByRole('heading', { name: 'Most watched genres' });
    const card = within(genres.closest('section') ?? document.body);
    expect(card.getByText('Drama')).toBeInTheDocument();
    expect(card.getByText('2 watched')).toBeInTheDocument();
    const years = within(
      screen.getByRole('heading', { name: 'Watched by year' }).closest('section') ?? document.body,
    );
    expect(years.getByText(String(thisYear))).toBeInTheDocument();
    const backlog = within(
      screen.getByRole('heading', { name: 'Watchlist backlog' }).closest('section') ??
        document.body,
    );
    expect(backlog.getByText(/2 titles waiting, about 4 h of viewing/)).toBeInTheDocument();
    expect(backlog.getByRole('link', { name: 'Pick something from the backlog' })).toHaveAttribute(
      'href',
      '/discover',
    );
    expect(backlog.getAllByRole('link', { name: /Waiting (Old|New)/ })).toHaveLength(2);
  });

  it('prints every figure as text, so no meaning depends on a bar', async () => {
    boot();
    const months = await screen.findByRole('heading', { name: 'Watched, last 12 months' });
    const items = within(months.closest('section') ?? document.body).getAllByRole('listitem');
    expect(items).toHaveLength(12);
    expect(items.map((li) => li.textContent).join('|')).toMatch(/1.*1.*1/);
  });

  it('says so, helpfully, when the library is empty', async () => {
    library = [];
    boot();
    expect(await screen.findByText('Nothing to count yet')).toBeInTheDocument();
  });
});
