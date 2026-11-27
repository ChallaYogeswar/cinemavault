import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { InstallCard } from '@/pwa/InstallCard';
import { UpdateBanner } from '@/pwa/UpdateBanner';
import type { PwaState, PwaStore } from '@/pwa/pwaStore';

function fakeStore(initial: Partial<PwaState> = {}) {
  let state: PwaState = { updateReady: false, canInstall: false, installed: false, ...initial };
  const listeners = new Set<() => void>();
  const applyUpdate = vi.fn();
  const promptInstall = vi.fn(() => Promise.resolve('dismissed' as const));
  const store: PwaStore = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    applyUpdate,
    promptInstall,
  };
  const set = (patch: Partial<PwaState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => {
      l();
    });
  };
  return { store, set, applyUpdate, promptInstall };
}

describe('update banner', () => {
  it('is absent until a new version is waiting, then offers Reload — and only reloads on click', async () => {
    const { store, set, applyUpdate } = fakeStore();
    render(<UpdateBanner store={store} />);
    expect(screen.queryByRole('status')).toBeNull();

    set({ updateReady: true });
    expect(await screen.findByText(/new version of CinemaVault is ready/i)).toBeInTheDocument();
    expect(applyUpdate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(applyUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('install card', () => {
  it('renders nothing when the browser offers no install', () => {
    const { store } = fakeStore();
    const { container } = render(<InstallCard store={store} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers install, and is gracious when the user declines', async () => {
    const { store, promptInstall } = fakeStore({ canInstall: true });
    render(<InstallCard store={store} />);
    await userEvent.click(screen.getByRole('button', { name: 'Install app' }));
    expect(promptInstall).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/install later from your browser/i)).toBeInTheDocument();
  });

  it('says what offline means honestly: reads work, changes need a connection', () => {
    const { store } = fakeStore({ canInstall: true });
    render(<InstallCard store={store} />);
    expect(screen.getByText(/changes need a connection/i)).toBeInTheDocument();
  });

  it('confirms an installed app instead of offering install again', () => {
    const { store } = fakeStore({ installed: true });
    render(<InstallCard store={store} />);
    expect(screen.getByRole('status')).toHaveTextContent(/installed on this device/i);
    expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull();
  });
});
