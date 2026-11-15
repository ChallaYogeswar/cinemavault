import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { Role } from '@/domain/permissions';
import type { ActiveUserStore } from './activeUser';
import { SessionContext, type Session } from './session';

interface Props {
  /** Who is signed in. Owned by the auth layer, not by this tree. */
  readonly store: ActiveUserStore;
  readonly role: Role;
  readonly roleVerified?: boolean;
  readonly roleFromDevice?: boolean;
  readonly retryRole?: () => void;
  readonly email?: string | null;
  readonly children: ReactNode;
}

/**
 * Exposes the signed-in account to the app. It renders nothing while nobody is signed in, so no
 * signed-in screen can ever exist without an account behind it.
 */
export function SessionProvider(props: Props) {
  const userId = useSyncExternalStore(props.store.subscribe, props.store.get);
  if (userId === null) return null;
  return <SignedIn {...props} userId={userId} />;
}

const noop = (): void => undefined;

function SignedIn({
  store,
  userId,
  role,
  roleVerified = true,
  roleFromDevice = false,
  retryRole = noop,
  email = null,
  children,
}: Props & { readonly userId: string }) {
  const epoch = useSyncExternalStore(store.subscribe, store.epoch);
  const roleRef = useRef<Role>(role);
  useEffect(() => {
    roleRef.current = role;
  }, [role]);
  const getRole = useCallback(() => roleRef.current, []);

  const value = useMemo<Session>(
    () => ({
      role,
      getRole,
      roleVerified,
      roleFromDevice,
      retryRole,
      userId,
      email,
      isCurrent: () => store.epoch() === epoch,
    }),
    [role, getRole, roleVerified, roleFromDevice, retryRole, userId, email, epoch, store],
  );
  return <SessionContext value={value}>{children}</SessionContext>;
}
