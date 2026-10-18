/* CinemaVault PR6 — browser Supabase client.
 * Only the public/publishable key belongs here. RLS remains the authorization boundary.
 */
(function (global) {
  'use strict';

  const URL_KEY = 'cinemavault_supabase_url';
  const KEY_KEY = 'cinemavault_supabase_publishable_key';
  // Public project URL + publishable (anon-level) key. Both are safe to ship in the browser:
  // row-level security is the authorization boundary. Never put a service-role key here.
  const DEFAULT_URL = 'https://qhopjfqpnmoinggejgvt.supabase.co';
  const DEFAULT_KEY = 'sb_publishable_bvBb8dJt1bkRLLvIQIYEBw_EVZWq-yo';
  // An earlier build shipped a mistyped project ref; discard it if it was saved in this browser.
  const BAD_REFS = ['qhopjfqpmoniggejgvjt'];

  function dropStaleConfig() {
    try {
      const saved = localStorage.getItem(URL_KEY) || '';
      if (BAD_REFS.some(ref => saved.includes(ref))) {
        localStorage.removeItem(URL_KEY);
        localStorage.removeItem(KEY_KEY);
      }
    } catch (_) {}
  }
  dropStaleConfig();
  let client = null;
  let signature = '';

  function config() {
    return {
      url: localStorage.getItem(URL_KEY) || DEFAULT_URL,
      key: localStorage.getItem(KEY_KEY) || DEFAULT_KEY
    };
  }

  function configured() {
    const value = config();
    return Boolean(value.url && value.key && global.supabase?.createClient);
  }

  function getClient() {
    const value = config();
    if (!configured()) return null;
    const nextSignature = value.url + '|' + value.key;
    if (!client || signature !== nextSignature) {
      client = global.supabase.createClient(value.url, value.key, {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true
        }
      });
      signature = nextSignature;
    }
    return client;
  }

  function saveConfig(url, key) {
    const cleanUrl = String(url || '').trim().replace(/\/$/, '');
    const cleanKey = String(key || '').trim();
    if (!cleanUrl || !/^https:\/\//i.test(cleanUrl)) throw new Error('Supabase URL must start with https://');
    if (!cleanKey) throw new Error('Supabase publishable key is required');
    localStorage.setItem(URL_KEY, cleanUrl);
    localStorage.setItem(KEY_KEY, cleanKey);
    client = null;
    signature = '';
    return { url: cleanUrl, key: cleanKey };
  }

  function clearConfig() {
    localStorage.removeItem(URL_KEY);
    localStorage.removeItem(KEY_KEY);
    client = null;
    signature = '';
  }

  async function session() {
    const instance = getClient();
    if (!instance) return null;
    const { data, error } = await instance.auth.getSession();
    if (error) throw error;
    return data.session || null;
  }

  async function signIn(email, password) {
    const instance = getClient();
    if (!instance) throw new Error('Configure Supabase first.');
    const { data, error } = await instance.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }

  async function sendMagicLink(email) {
    const instance = getClient();
    if (!instance) throw new Error('Save the Supabase project URL and publishable key first.');
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      throw new Error('Enter a valid email address.');
    }
    const redirectTo = window.location.origin + window.location.pathname;
    const { error } = await instance.auth.signInWithOtp({
      email: cleanEmail,
      options: { emailRedirectTo: redirectTo, shouldCreateUser: true }
    });
    if (error) throw error;
    return { email: cleanEmail };
  }

  async function signUp(email, password) {
    const instance = getClient();
    if (!instance) throw new Error('Configure Supabase first.');
    const redirectTo = window.location.origin + window.location.pathname + window.location.hash;
    const { data, error } = await instance.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: redirectTo }
    });
    if (error) throw error;
    return data;
  }

  async function signOut() {
    const instance = getClient();
    if (!instance) return;
    const { error } = await instance.auth.signOut();
    if (error) throw error;
  }

  function onAuthStateChange(callback) {
    const instance = getClient();
    if (!instance) return () => {};
    const { data } = instance.auth.onAuthStateChange(callback);
    return () => data.subscription.unsubscribe();
  }

  global.CinemaVaultSupabase = Object.freeze({
    config,
    configured,
    getClient,
    saveConfig,
    clearConfig,
    session,
    signIn,
    signUp,
    sendMagicLink,
    signOut,
    onAuthStateChange
  });
})(window);
