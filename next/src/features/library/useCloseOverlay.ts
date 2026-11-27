import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

function cameFromLibrary(state: unknown): boolean {
  return (
    typeof state === 'object' && state !== null && 'overlay' in state && state.overlay === true
  );
}

/**
 * Closing a dialog behaves like the back button when it was opened from inside the app (so the
 * history stays a clean stack: library -> detail -> edit), and falls back to the library when the
 * dialog was opened by a deep link. Filters in the query string are preserved either way.
 */
export function useCloseOverlay(): () => void {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(() => {
    if (cameFromLibrary(location.state)) {
      void navigate(-1);
    } else {
      void navigate({ pathname: '/library', search: location.search }, { replace: true });
    }
  }, [navigate, location.state, location.search]);
}
