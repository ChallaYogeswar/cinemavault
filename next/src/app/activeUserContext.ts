import { createContext, useContext } from 'react';
import type { ActiveUserStore } from './activeUser';

export const ActiveUserContext = createContext<ActiveUserStore | null>(null);

export function useActiveUser(): ActiveUserStore {
  const store = useContext(ActiveUserContext);
  if (!store) throw new Error('useActiveUser must be used inside <ActiveUserContext>');
  return store;
}
