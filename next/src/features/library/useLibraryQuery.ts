import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { parseLibraryQuery, serializeLibraryQuery, type LibraryQuery } from '@/domain/library';

/** The keys this screen owns; any other query parameter (e.g. the M2 preview flags) is preserved. */
const OWNED_KEYS = ['q', 'type', 'status', 'rating', 'genre', 'sort'] as const;

/**
 * Library filters live in the URL: refresh keeps the view, the back button works, and a filtered
 * view can be shared. Changes use `replace` so typing in the search box does not flood history.
 */
export function useLibraryQuery() {
  const [params, setParams] = useSearchParams();
  const query = useMemo(() => parseLibraryQuery(params), [params]);

  const update = useCallback(
    (patch: Partial<LibraryQuery>) => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          const merged = { ...parseLibraryQuery(previous), ...patch };
          for (const key of OWNED_KEYS) next.delete(key);
          for (const [key, value] of serializeLibraryQuery(merged)) next.set(key, value);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const clear = useCallback(() => {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const key of OWNED_KEYS) next.delete(key);
        return next;
      },
      { replace: true },
    );
  }, [setParams]);

  return { query, update, clear };
}
