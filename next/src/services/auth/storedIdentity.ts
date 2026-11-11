import { z } from 'zod';
import type { AuthUser } from './authService';

const storedSession = z.object({
  user: z.object({ id: z.uuid(), email: z.string().nullish() }),
  refresh_token: z.string().min(1),
});

/**
 * Who the browser last had signed in, read from the session supabase-js keeps in local storage.
 *
 * Why this exists: supabase-js reports "no session" at start-up when the access token has expired
 * (an hour) and cannot be refreshed because the device is offline, yet it KEEPS the stored session
 * (it only deletes it when the server actually rejects it). Without this, opening the app offline
 * after an hour away would show the sign-in screen and hide the saved library.
 *
 * What it does NOT do: it proves nothing to the server and authorizes nothing. It only lets the
 * app show the copy saved on this device for that account. Every request still needs a valid
 * token; the moment the server is reachable the session is refreshed, or, if the server rejects it
 * (password changed, signed out elsewhere), the app signs out and the saved copy is wiped.
 *
 * Returns null for anything that is not a complete, well-formed stored session.
 */
export function readStoredIdentity(
  storageKey: string,
  storage?: Pick<Storage, 'getItem'>,
): AuthUser | null {
  try {
    const source = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    const text = source?.getItem(storageKey) ?? null;
    if (text === null) return null;
    const parsed = storedSession.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    return { id: parsed.data.user.id, email: parsed.data.user.email ?? null };
  } catch {
    return null;
  }
}
