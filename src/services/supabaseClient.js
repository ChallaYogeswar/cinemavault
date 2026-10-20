/* CinemaVault — Supabase client + authentication service.
 *
 * Only the public/publishable key lives here (it is designed to be public); row-level security in the
 * database is the real authorization boundary. Never put a service-role key in this file.
 *
 * Nothing needs configuring per device: open the site, sign in once, and the session is kept (and
 * refreshed automatically) in this browser.
 */
(function (global) {
  'use strict';

  const SUPABASE_URL = 'https://qhopjfqpnmoinggejgvt.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_bvBb8dJt1bkRLLvIQIYEBw_EVZWq-yo';

  // Older builds asked each browser to store a URL/key in localStorage (and one build shipped a mistyped
  // project ref). Those values are no longer used; remove them so they can never shadow the real ones.
  try {
    localStorage.removeItem('cinemavault_supabase_url');
    localStorage.removeItem('cinemavault_supabase_publishable_key');
  } catch (_) {}

  let client = null;

  function getClient() {
    if (client) return client;
    if (!global.supabase?.createClient) return null;
    client = global.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
        storageKey: 'cinemavault-auth'
      }
    });
    return client;
  }

  function configured() { return Boolean(getClient()); }

  function need() {
    const instance = getClient();
    if (!instance) throw new Error('The sign-in library failed to load. Check your connection and reload the page.');
    return instance;
  }

  function redirectUrl() {
    return global.location.origin + global.location.pathname;
  }

  /* ---------- friendly errors ---------- */
  function friendly(error) {
    const raw = String(error?.message || error || '');
    const code = String(error?.code || '');
    const text = raw.toLowerCase();
    if (/failed to fetch|networkerror|load failed|network request failed/.test(text)) return 'Can’t reach the server. Check your internet connection and try again.';
    if (/invalid login credentials/.test(text)) return 'That email and password don’t match. Check them, or use “Forgot password”.';
    if (/email not confirmed/.test(text)) return 'Please confirm your email first — open the link we sent you, then sign in.';
    if (/user already registered|already been registered/.test(text)) return 'An account with this email already exists. Sign in instead, or reset your password.';
    if (/rate limit|too many requests|over_email_send_rate_limit|over_sms_send_rate_limit/.test(text + code)) return 'Too many attempts. Please wait a few minutes and try again.';
    if (/password should be at least|weak_password|password is too weak/.test(text + code)) return 'Choose a stronger password (at least 8 characters, mixing letters and numbers).';
    if (/same password|different from the old/.test(text)) return 'Your new password must be different from the old one.';
    if (/phone.*(provider|disabled|unsupported)|sms.*(provider|disabled)|phone_provider_disabled/.test(text + code)) return 'Phone sign-in isn’t switched on for this site yet.';
    if (/provider is not enabled|unsupported provider|provider_disabled/.test(text + code)) return 'That sign-in method isn’t switched on for this site yet.';
    if (/token has expired|otp_expired|invalid.*(token|otp)|otp.*invalid/.test(text + code)) return 'That code is wrong or has expired. Request a new one.';
    if (/signups not allowed|signup_disabled/.test(text + code)) return 'New sign-ups are currently turned off.';
    if (/invalid format|validation_failed|unable to validate email/.test(text + code)) return 'That doesn’t look like a valid email address or phone number.';
    return raw || 'Something went wrong. Please try again.';
  }

  /* ---------- which sign-in methods are enabled on the project ---------- */
  let providersPromise = null;
  function providers() {
    if (!providersPromise) {
      providersPromise = fetch(SUPABASE_URL + '/auth/v1/settings', { headers: { apikey: SUPABASE_KEY } })
        .then(r => (r.ok ? r.json() : Promise.reject(new Error('settings ' + r.status))))
        .then(s => ({
          known: true,
          email: s.external?.email !== false,
          phone: Boolean(s.external?.phone),
          google: Boolean(s.external?.google),
          github: Boolean(s.external?.github),
          facebook: Boolean(s.external?.facebook),
          apple: Boolean(s.external?.apple),
          signupDisabled: Boolean(s.disable_signup),
          autoconfirm: Boolean(s.mailer_autoconfirm)
        }))
        // If the lookup fails (offline, blocked), assume everything is available and let the attempt report the real error.
        .catch(() => ({ known: false, email: true, phone: true, google: true, github: true, facebook: true, apple: true, signupDisabled: false, autoconfirm: false }));
    }
    return providersPromise;
  }

  /* ---------- sessions ---------- */
  async function session() {
    const instance = getClient();
    if (!instance) return null;
    const { data, error } = await instance.auth.getSession();
    if (error) throw error;
    return data.session || null;
  }

  function onAuthStateChange(callback) {
    const instance = need();
    const { data } = instance.auth.onAuthStateChange(callback);
    return () => data.subscription.unsubscribe();
  }

  /* ---------- sign in / up ---------- */
  async function signIn(email, password) {
    const { data, error } = await need().auth.signInWithPassword({ email: String(email).trim(), password });
    if (error) throw error;
    return data;
  }

  async function signUp(email, password, fullName) {
    const { data, error } = await need().auth.signUp({
      email: String(email).trim(),
      password,
      options: { emailRedirectTo: redirectUrl(), data: fullName ? { full_name: String(fullName).trim() } : undefined }
    });
    if (error) throw error;
    // Supabase hides "already registered" for confirmed accounts: it returns a user with no identities.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      const err = new Error('User already registered');
      throw err;
    }
    return { needsConfirmation: !data.session, email: String(email).trim() };
  }

  async function resendConfirmation(email) {
    const { error } = await need().auth.resend({ type: 'signup', email: String(email).trim(), options: { emailRedirectTo: redirectUrl() } });
    if (error) throw error;
  }

  async function sendMagicLink(email) {
    const { error } = await need().auth.signInWithOtp({
      email: String(email).trim(),
      options: { emailRedirectTo: redirectUrl(), shouldCreateUser: true }
    });
    if (error) throw error;
  }

  async function signInWithProvider(provider) {
    const { error } = await need().auth.signInWithOAuth({ provider, options: { redirectTo: redirectUrl() } });
    if (error) throw error;
  }

  async function sendPhoneCode(phone) {
    const { error } = await need().auth.signInWithOtp({ phone, options: { shouldCreateUser: true } });
    if (error) throw error;
  }

  async function verifyPhoneCode(phone, token) {
    const { data, error } = await need().auth.verifyOtp({ phone, token: String(token).trim(), type: 'sms' });
    if (error) throw error;
    return data;
  }

  async function sendPasswordReset(email) {
    const { error } = await need().auth.resetPasswordForEmail(String(email).trim(), { redirectTo: redirectUrl() });
    if (error) throw error;
  }

  async function updatePassword(password) {
    const { data, error } = await need().auth.updateUser({ password });
    if (error) throw error;
    return data;
  }

  async function signOut() {
    const instance = getClient();
    if (!instance) return;
    const { error } = await instance.auth.signOut();
    if (error) throw error;
  }

  /* ---------- role (owner / viewer) ---------- */
  const Auth = {
    profile: null,
    // The owner can edit; a viewer is read-only. If the profile can't be read (for example the roles
    // migration has not been applied yet) behave as before: the signed-in user edits their own library.
    isViewer() { return Auth.profile?.role === 'viewer'; },
    isOwner() { return !Auth.isViewer(); },
    canWrite() { return !Auth.isViewer(); }
  };

  async function loadProfile(user) {
    Auth.profile = null;
    const instance = getClient();
    if (!instance || !user) return null;
    try {
      const { data, error } = await instance.from('profiles').select('id,email,phone,display_name,role').eq('id', user.id).maybeSingle();
      if (error) throw error;
      Auth.profile = data || null;
    } catch (error) {
      console.warn('[CinemaVault] profile unavailable, defaulting to full access for this account:', error?.message || error);
      Auth.profile = null;
    }
    return Auth.profile;
  }

  async function updateDisplayName(userId, name) {
    const { error } = await need().from('profiles').update({ display_name: String(name || '').trim() }).eq('id', userId);
    if (error) throw error;
    if (Auth.profile) Auth.profile.display_name = String(name || '').trim();
  }

  global.CinemaVaultAuth = Auth;
  global.CinemaVaultSupabase = Object.freeze({
    URL: SUPABASE_URL,
    configured,
    getClient,
    providers,
    friendly,
    session,
    onAuthStateChange,
    signIn,
    signUp,
    resendConfirmation,
    sendMagicLink,
    signInWithProvider,
    sendPhoneCode,
    verifyPhoneCode,
    sendPasswordReset,
    updatePassword,
    signOut,
    loadProfile,
    updateDisplayName
  });
})(window);
