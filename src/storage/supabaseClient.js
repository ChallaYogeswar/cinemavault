/* Public browser configuration only. Never place service-role or secret keys here. */
(function (global) {
  'use strict';

  const SUPABASE_URL = 'https://qhopjfqpnmoinggejgvt.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_bvBb8dJt1bkRLLvIQIYEBw_EVZWq-yo';

  if (!global.supabase?.createClient) {
    console.error('[CinemaVault] Supabase JS client failed to load.');
    return;
  }

  global.CinemaVaultSupabaseClient = global.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    }
  );
})(window);
