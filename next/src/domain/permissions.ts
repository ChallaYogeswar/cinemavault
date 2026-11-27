import { z } from 'zod';

export type Role = 'owner' | 'viewer';

export type Action =
  | 'movie:read'
  | 'movie:create'
  | 'movie:update'
  | 'movie:delete'
  | 'metadata:write'
  /** Change one's OWN profile, email or password. Never grants access to anyone else's account. */
  | 'account:manage-own'
  /** Administer other users or roles. Reserved for the owner; nothing uses it yet. */
  | 'users:manage';

const OWNER_ONLY_ACTIONS: readonly Action[] = [
  'movie:create',
  'movie:update',
  'movie:delete',
  'metadata:write',
  'users:manage',
];

const profileSchema = z.object({ role: z.enum(['owner', 'viewer']) });

/**
 * FAIL-CLOSED role resolution (risk R1). Anything other than a well-formed profile whose role is
 * exactly "owner" resolves to "viewer": a missing profile, a failed profile query, an unexpected
 * shape, a different casing, or an unknown role. The old app fell back to full access in the UI
 * when the profile could not be read; this function must never do that.
 *
 * This is a UX convenience only. Authorization is enforced by Postgres RLS, not by this function.
 */
export function resolveRole(profile: unknown): Role {
  const parsed = profileSchema.safeParse(profile);
  return parsed.success ? parsed.data.role : 'viewer';
}

export function can(role: Role, action: Action): boolean {
  if (OWNER_ONLY_ACTIONS.includes(action)) return role === 'owner';
  return true; // reads and managing one's own account are allowed for any signed-in role
}
