import { createContext, useContext } from 'react';

export interface SyncControls {
  /** Asks for the waiting changes to be sent now. Safe to call at any time and as often as you like. */
  readonly requestFlush: () => void;
}

const NOTHING: SyncControls = { requestFlush: () => undefined };

export const SyncContext = createContext<SyncControls>(NOTHING);

export const useSync = (): SyncControls => useContext(SyncContext);
