import { onlineManager } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeAuth, type FakeAuth } from '../fakes/fakeAuthService';
import { createFakeProfiles, type FakeProfiles } from '../fakes/fakeProfiles';
import { at } from '../helpers';
import { OWNER_ID, renderFullApp } from '../renderFullApp';

let auth: FakeAuth;
let profiles: FakeProfiles;
let saved: Blob[];

const boot = () => renderFullApp({ auth, profiles, path: '/settings' });

const readBlob = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      reject(new Error('read failed'));
    };
    reader.readAsText(blob);
  });

beforeEach(() => {
  onlineManager.setOnline(true);
  saved = [];
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (blob: Blob) => {
      saved.push(blob);
      return 'blob:test';
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: () => undefined,
  });
  // jsdom does not navigate on a download click
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  auth = createFakeAuth(
    [{ id: OWNER_ID, email: 'owner@example.com', password: 'pw-owner-1' }],
    OWNER_ID,
  );
  profiles = createFakeProfiles({ [OWNER_ID]: { role: 'owner' } });
});
afterEach(() => {
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
  vi.restoreAllMocks();
});

const csvFile = (text: string) => new File([text], 'movies.csv', { type: 'text/csv' });

describe('Backup and import card', () => {
  it('exports the library as a JSON backup and as a CSV', async () => {
    const { user } = boot();
    const json = await screen.findByRole('button', { name: /download backup/i });
    await waitFor(() => {
      expect(json).toBeEnabled();
    });
    await user.click(json);
    await user.click(screen.getByRole('button', { name: /download spreadsheet/i }));
    expect(saved).toHaveLength(2);
    const backup = JSON.parse(await readBlob(at(saved, 0))) as {
      count: number;
      movies: { title: string }[];
    };
    expect(backup.count).toBe(2);
    expect(backup.movies.map((m) => m.title).sort()).toEqual(['Shared Alpha', 'Shared Beta']);
    expect(await readBlob(at(saved, 1))).toContain('Shared Alpha');
    expect(await screen.findByText(/saved 2 titles to your downloads/i)).toBeInTheDocument();
  });

  it('previews a CSV, then adds only the new titles, and the library shows them', async () => {
    const { user, repos, router } = boot();
    const input = await screen.findByLabelText(/choose a backup/i);
    await waitFor(() => {
      expect(input).toBeEnabled();
    });
    await user.upload(
      input,
      csvFile(
        'title,year,type\nShared Alpha,2001,movie\nFresh One,2024,movie\nFresh One,2024,movie\n,2024,movie\nFresh Two,2025,tv\n',
      ),
    );
    const preview = await screen.findByText(/preview of movies\.csv/i);
    const box = preview.parentElement;
    if (!box) throw new Error('no preview box');
    expect(within(box).getByText('Will be added').nextElementSibling).toHaveTextContent('2');
    expect(within(box).getByText('Already in your library').nextElementSibling).toHaveTextContent(
      '1',
    );
    expect(within(box).getByText('Repeated in the file').nextElementSibling).toHaveTextContent('1');
    expect(within(box).getByText('Cannot be saved').nextElementSibling).toHaveTextContent('1');
    // nothing is saved before the person confirms
    expect(repos.get(OWNER_ID)?.snapshot()).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Import 2 new titles' }));
    expect(await screen.findByText(/import finished/i)).toBeInTheDocument();
    expect(screen.getByText(/2 added/)).toBeInTheDocument();
    expect(
      repos
        .get(OWNER_ID)
        ?.snapshot()
        .map((m) => m.title)
        .sort(),
    ).toEqual(['Fresh One', 'Fresh Two', 'Shared Alpha', 'Shared Beta']);
    await router.navigate('/library');
    expect(await screen.findByRole('link', { name: /Fresh Two/ })).toBeInTheDocument();
  });

  it('cannot import a file whose titles are all already in the library', async () => {
    const { user } = boot();
    const input = await screen.findByLabelText(/choose a backup/i);
    await waitFor(() => {
      expect(input).toBeEnabled();
    });
    await user.upload(input, csvFile('title,year\nshared alpha,2001\nSHARED BETA,2002\n'));
    expect(await screen.findByRole('button', { name: 'Import 0 new titles' })).toBeDisabled();
  });

  it('explains a file it cannot read instead of failing silently', async () => {
    const { user } = boot();
    const input = await screen.findByLabelText(/choose a backup/i);
    await waitFor(() => {
      expect(input).toBeEnabled();
    });
    await user.upload(input, csvFile('foo,bar\n1,2\n'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no title column/i);
  });

  it('a view-only account can export but is told it cannot import', async () => {
    profiles = createFakeProfiles({ [OWNER_ID]: { role: 'viewer' } });
    boot();
    expect(await screen.findByText(/view-only accounts can’t import titles/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/choose a backup/i)).toBeNull();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /download backup/i })).toBeEnabled();
    });
  });
});
