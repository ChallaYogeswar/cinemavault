import type { ReactNode } from 'react';
import { useAuth } from '@/app/auth/auth';
import { SignedInSession } from '@/app/SignedInSession';

/** Opens the session for whoever auth says is signed in; nothing renders while nobody is. */
export function SessionFromAuth({ children }: { readonly children: ReactNode }) {
  const { state } = useAuth();
  if (state.status !== 'signed_in') return null;
  return <SignedInSession user={state.user}>{children}</SignedInSession>;
}
