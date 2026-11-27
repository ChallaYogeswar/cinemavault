import { useSyncExternalStore } from 'react';
import { pwaStore, type PwaState, type PwaStore } from './pwaStore';

export function usePwaState(store: PwaStore = pwaStore): PwaState {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getState(),
    () => store.getState(),
  );
}
