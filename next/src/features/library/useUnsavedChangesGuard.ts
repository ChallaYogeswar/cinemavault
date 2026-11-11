import { useEffect, type RefObject } from 'react';
import { useBlocker } from 'react-router-dom';

export const DISCARD_PROMPT = 'Discard your changes?';

/**
 * One guard for EVERY way out of a form with unsaved edits. Because it sits on the router, it
 * covers Escape, the close button, a backdrop click, Cancel, the browser Back and Forward buttons
 * and links elsewhere in the app; none of them needs its own confirmation code.
 *  - In-app navigation that would change the page asks first (`useBlocker`).
 *  - Closing or reloading the tab triggers the browser's own prompt (`beforeunload`).
 * `dirty` is a ref so the check always sees the latest value at the moment of navigation.
 */
export function useUnsavedChangesGuard(dirty: RefObject<boolean>): void {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty.current && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm(DISCARD_PROMPT)) blocker.proceed();
    else blocker.reset();
  }, [blocker]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty.current) event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [dirty]);
}
