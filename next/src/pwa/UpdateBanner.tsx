import { Button } from '@/components/ui/Button';
import { pwaStore, type PwaStore } from './pwaStore';
import { usePwaState } from './usePwa';

/**
 * A new version is downloaded and waiting. Never applied automatically: reloading under someone
 * who is halfway through editing a title would lose their work.
 */
export function UpdateBanner({ store = pwaStore }: { readonly store?: PwaStore }) {
  const { updateReady } = usePwaState(store);
  if (!updateReady) return null;
  return (
    <div
      role="status"
      className="bg-gold/15 text-gold flex flex-wrap items-center justify-center gap-3 px-4 py-2 text-center text-sm"
    >
      <span>A new version of CinemaVault is ready.</span>
      <Button
        variant="secondary"
        onClick={() => {
          store.applyUpdate();
        }}
      >
        Reload
      </Button>
    </div>
  );
}
