import { pwaStore } from './pwaStore';

/**
 * Called once from main.tsx. The worker is registered only in a production build: in `vite dev`
 * a worker would serve stale code and hide changes. The install prompt and update state are
 * still wired in dev so the UI can be developed.
 */
export function startPwa(): void {
  pwaStore.start(
    {
      navigator,
      window,
      document,
      reload: () => {
        window.location.reload();
      },
      setInterval: (run, ms) => window.setInterval(run, ms),
      clearInterval: (handle) => {
        window.clearInterval(handle as number);
      },
    },
    { registerWorker: import.meta.env.PROD && 'serviceWorker' in navigator },
  );
}
