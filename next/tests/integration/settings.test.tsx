import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { onlineManager } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDexieDeviceStore, type DeviceStore } from '@/data/local/dexieLibraryCache';
import type { HistoryEntry } from '@/domain/recommend';
import { createMetadataService, type MetadataService } from '@/services/tmdb/metadataService';
import type { TmdbClient } from '@/services/tmdb/tmdbClient';
import { createFakeAuth, type FakeAuth } from '../fakes/fakeAuthService';
import { createFakeProfiles, networkFailure, type FakeProfiles } from '../fakes/fakeProfiles';
import { OWNER_ID, renderFullApp } from '../renderFullApp';

let auth: FakeAuth;
let profiles: FakeProfiles;
let device: DeviceStore;
let metadata: MetadataService;

const entry = (n: number): HistoryEntry => ({
  movieId: `m-${String(n)}`,
  genres: ['Drama'],
  result: 'recommended',
  at: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(),
});

const boot = (withDevice = true) =>
  renderFullApp({
    auth,
    profiles,
    path: '/settings',
    ...(withDevice
      ? { device: { history: device.history, metadata, snoozes: device.snoozes } }
      : {}),
  });

beforeEach(() => {
  onlineManager.setOnline(true);
  auth = createFakeAuth(
    [{ id: OWNER_ID, email: 'owner@example.com', password: 'pw-owner-1' }],
    OWNER_ID,
  );
  profiles = createFakeProfiles({ [OWNER_ID]: { role: 'owner' } });
  device = createDexieDeviceStore({ indexedDB: new IDBFactory(), IDBKeyRange });
  const client: TmdbClient = {
    search: vi.fn(() => Promise.resolve([])),
    videos: vi.fn(() => Promise.resolve([])),
  };
  metadata = createMetadataService({ client, store: device.metadata });
});
afterEach(() => {
  onlineManager.setOnline(true);
});

const field = (name: string) => screen.findByLabelText(name);

describe('profile', () => {
  it('shows the saved display name and saves a new one', async () => {
    profiles.names.set(OWNER_ID, 'Yogi');
    const { user } = boot();
    const input = await field('Display name');
    await waitFor(() => {
      expect(input).toHaveValue('Yogi');
    });
    await user.clear(input);
    await user.type(input, '  Yogeswar   C  ');
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('Name saved.')).toBeInTheDocument();
    expect(profiles.updates).toEqual([{ userId: OWNER_ID, name: 'Yogeswar C' }]);
    expect(input).toHaveValue('Yogeswar C');
  });

  it('removes the name when the field is emptied', async () => {
    profiles.names.set(OWNER_ID, 'Yogi');
    const { user } = boot();
    const input = await field('Display name');
    await waitFor(() => {
      expect(input).toHaveValue('Yogi');
    });
    await user.clear(input);
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('Name removed.')).toBeInTheDocument();
    expect(profiles.updates).toEqual([{ userId: OWNER_ID, name: null }]);
  });

  it('refuses an invalid name without calling the server', async () => {
    const { user } = boot();
    const input = await field('Display name');
    await user.type(input, 'x'.repeat(41));
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('40 characters');
    expect(profiles.updates).toEqual([]);
  });

  it('says so when the server cannot save it, and keeps what was typed', async () => {
    const { user } = boot();
    const input = await field('Display name');
    await user.type(input, 'Yogi');
    profiles.failNextUpdate(networkFailure);
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    expect(input).toHaveValue('Yogi');
    expect(profiles.names.has(OWNER_ID)).toBe(false);
  });
});

describe('password', () => {
  it('rejects a short or mismatched password before asking the server', async () => {
    const { user } = boot();
    await user.type(await field('New password'), 'short');
    await user.type(screen.getByLabelText('Confirm new password'), 'different');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Use at least 8 characters')).toBeInTheDocument();
    expect(auth.calls.some((c) => c.name === 'updatePassword')).toBe(false);
    await user.clear(screen.getByLabelText('New password'));
    await user.type(screen.getByLabelText('New password'), 'long-enough-1');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The passwords don’t match')).toBeInTheDocument();
    expect(auth.calls.some((c) => c.name === 'updatePassword')).toBe(false);
  });

  it('changes the password, empties the fields and stays signed in', async () => {
    const { user } = boot();
    await user.type(await field('New password'), 'brand-new-pw-9');
    await user.type(screen.getByLabelText('Confirm new password'), 'brand-new-pw-9');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Password changed.')).toBeInTheDocument();
    expect(auth.accounts[0]?.password).toBe('brand-new-pw-9');
    expect(screen.getByLabelText('New password')).toHaveValue('');
    expect(screen.getByLabelText('Confirm new password')).toHaveValue('');
    expect(screen.getByText('owner@example.com')).toBeInTheDocument();
  });

  it('shows the server’s reason when the change fails and does not claim success', async () => {
    const { user } = boot();
    await user.type(await field('New password'), 'brand-new-pw-9');
    await user.type(screen.getByLabelText('Confirm new password'), 'brand-new-pw-9');
    auth.failNext('updatePassword', { code: 'network', message: 'Couldn’t reach the server.' });
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t reach the server.');
    expect(screen.queryByText('Password changed.')).not.toBeInTheDocument();
    expect(auth.accounts[0]?.password).toBe('pw-owner-1');
  });

  it('can email a reset link instead, without saying whether the address exists', async () => {
    const { user } = boot();
    await user.click(await screen.findByRole('button', { name: 'Email me a reset link instead' }));
    expect(await screen.findByText(/a reset link is on its way/)).toBeInTheDocument();
    expect(auth.calls).toContainEqual({ name: 'requestPasswordReset', args: 'owner@example.com' });
  });
});

describe('account', () => {
  it('explains a viewer fallback when access could not be confirmed', async () => {
    profiles.failNext(networkFailure);
    boot();
    expect(await screen.findByText(/couldn’t confirm your access/i)).toBeInTheDocument();
    expect(screen.getByText(/\(not verified\)/)).toBeInTheDocument();
  });

  it('shows no such explanation when access is confirmed', async () => {
    boot();
    await screen.findByText('Owner — can change the library');
    expect(screen.queryByText(/couldn’t confirm your access/i)).not.toBeInTheDocument();
  });

  it('signs out of all devices through the server and lands on the sign-in page', async () => {
    const { user } = boot();
    await user.click(await screen.findByRole('button', { name: 'Sign out of all devices' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(auth.calls.map((c) => c.name)).toContain('signOutEverywhere');
    expect(auth.calls.map((c) => c.name)).not.toContain('signOut');
  });

  it('signs this device out even when the server cannot be reached', async () => {
    const { user } = boot();
    auth.failNext('signOutEverywhere', networkFailure);
    await user.click(await screen.findByRole('button', { name: 'Sign out of all devices' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(auth.session).toBeNull();
  });

  it('a plain sign-out still only ends this device', async () => {
    const { user } = boot();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(auth.calls.map((c) => c.name)).toEqual(['signOut']);
  });
});

describe('on this device', () => {
  it('counts the suggestion history and clears it without touching anything else', async () => {
    await device.history.record(OWNER_ID, entry(1));
    await device.history.record(OWNER_ID, entry(2));
    await device.metadata.put(OWNER_ID, 'k', { v: 1 }, new Date());
    const { user } = boot();
    expect(await screen.findByText('2 entries')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear suggestion history' }));
    expect(await screen.findByText('Suggestion history cleared.')).toBeInTheDocument();
    expect(screen.getByText('0 entries')).toBeInTheDocument();
    expect(await device.history.recent(OWNER_ID, 10)).toEqual([]);
    expect(await device.metadata.get(OWNER_ID, 'k')).not.toBeNull();
  });

  it('clears saved posters and trailers without touching the history', async () => {
    await device.history.record(OWNER_ID, entry(1));
    await device.metadata.put(OWNER_ID, 'k', { v: 1 }, new Date());
    const { user } = boot();
    await user.click(
      await screen.findByRole('button', { name: 'Clear saved posters and trailers' }),
    );
    expect(await screen.findByText(/Saved posters and trailers cleared/)).toBeInTheDocument();
    expect(await device.metadata.get(OWNER_ID, 'k')).toBeNull();
    expect(await device.history.recent(OWNER_ID, 10)).toHaveLength(1);
  });

  it('shows how many titles are hidden from Discover and brings them back', async () => {
    const soon = new Date(Date.now() + 86_400_000);
    await device.snoozes.snooze(OWNER_ID, 'a', soon, new Date());
    await device.snoozes.snooze(OWNER_ID, 'b', soon, new Date());
    await device.snoozes.snooze(
      OWNER_ID,
      'gone',
      new Date(Date.now() - 1000),
      new Date(Date.now() - 2000),
    );
    const { user } = boot();
    expect(await screen.findByText('2 titles')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show hidden titles again' }));
    expect(
      await screen.findByText('Hidden titles are back in your suggestions.'),
    ).toBeInTheDocument();
    expect(screen.getByText('0 titles')).toBeInTheDocument();
    expect(await device.snoozes.active(OWNER_ID, new Date())).toEqual([]);
    expect(screen.getByRole('button', { name: 'Show hidden titles again' })).toBeDisabled();
  });

  it('is not shown when the device keeps nothing', async () => {
    boot(false);
    await screen.findByText('Owner — can change the library');
    expect(screen.queryByText('On this device')).not.toBeInTheDocument();
  });
});
