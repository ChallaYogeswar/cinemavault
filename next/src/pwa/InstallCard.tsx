import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { pwaStore, type PwaStore } from './pwaStore';
import { usePwaState } from './usePwa';

/**
 * Install as an app. Shown only when the browser has offered an install prompt (or the app is
 * already installed); other browsers install from their own menu and need nothing from us.
 * The saved library lives per signed-in user either way — installing adds no extra storage.
 */
export function InstallCard({ store = pwaStore }: { readonly store?: PwaStore }) {
  const { canInstall, installed } = usePwaState(store);
  const [declined, setDeclined] = useState(false);
  if (!canInstall && !installed) return null;
  return (
    <div className="border-line bg-surface/60 mt-6 max-w-xl rounded-3xl border p-6">
      <h2 className="font-serif text-2xl">App</h2>
      {installed ? (
        <p role="status" className="text-muted mt-3 text-sm">
          CinemaVault is installed on this device. If the connection drops, it still opens and shows
          your library as last saved; changes need a connection.
        </p>
      ) : (
        <>
          <p className="text-muted mt-3 text-sm">
            Install CinemaVault for its own window and a home-screen icon. If the connection drops,
            it still opens and shows your library as last saved; changes need a connection.
          </p>
          {declined ? (
            <p role="status" className="text-dim mt-3 text-xs">
              No problem — you can install later from your browser’s menu.
            </p>
          ) : null}
          <Button
            className="mt-4"
            variant="secondary"
            onClick={() => {
              void store.promptInstall().then((outcome) => {
                setDeclined(outcome === 'dismissed');
              });
            }}
          >
            Install app
          </Button>
        </>
      )}
    </div>
  );
}
