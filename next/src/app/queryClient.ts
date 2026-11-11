import { QueryClient } from '@tanstack/react-query';
import { isRetryable } from '@/data/repositories/repositoryError';

/** Defaults favour correctness over speed: never serve a stale private library silently. */
export function createQueryClient(options: { readonly retry?: boolean } = {}): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // One retry for transient failures; none for ones a retry cannot fix (forbidden, …), and
        // none while the browser itself says it is offline (the answer would be the same, and
        // waiting delays showing the saved copy).
        retry:
          options.retry === false
            ? false
            : (count, error) => count < 1 && isRetryable(error) && navigator.onLine,
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        // The default ('online') PAUSES a query while the browser reports offline, so the saved
        // copy would never be offered and the screen would wait forever. Requests run regardless;
        // a failure comes back as a network error, which the data layer knows how to handle.
        networkMode: 'always',
      },
      mutations: {
        retry: 0, // a mutation must never be retried automatically (no double writes)
        // The default ('online') would HOLD a write made offline and send it later, on its own:
        // an offline write queue by accident. Writes are online-only, so they run now or fail now.
        networkMode: 'always',
      },
    },
  });
}
