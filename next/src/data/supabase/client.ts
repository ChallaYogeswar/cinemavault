import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AppConfig } from '@/services/env';

/** Distinct from the old app's key so the two apps never read or clobber each other's session. */
export const AUTH_STORAGE_KEY = 'cinemavault-next-auth';

export function createSupabaseClient(config: AppConfig): SupabaseClient {
  // The client is untyped on purpose (no generated schema): every row is validated with zod at the
  // repository boundary instead, which also protects against schema drift.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return createClient(config.supabaseUrl, config.supabasePublishableKey, {
    // The data layer owns retry and offline policy (one TanStack retry, then the saved copy).
    // PostgREST's own automatic retries would stack on top of it: offline, a single read took
    // ~7 s (1 + 2 + 4 s of back-off) per attempt before the app was allowed to say "offline".
    db: { retry: false },
    auth: {
      storageKey: AUTH_STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true, // password-recovery links land back here with a code
      flowType: 'pkce',
    },
  });
}
