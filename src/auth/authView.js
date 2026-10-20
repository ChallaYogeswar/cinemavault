/* CinemaVault — sign-in experience.
 * Sign in · create account · phone code · magic link · forgot / reset password · social providers.
 * Rendered full-screen into #app whenever nobody is signed in. All data access goes through Supabase Auth.
 */
(function (global) {
  'use strict';

  const S = () => global.CinemaVaultSupabase;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ICONS = {
    google: 'M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z',
    github: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
    facebook: 'M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z',
    apple: 'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701'
  };
  const LABELS = { google: 'Google', github: 'GitHub', facebook: 'Facebook', apple: 'Apple' };
  const icon = name => '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="' + ICONS[name] + '"/></svg>';

  const view = { name: 'signin', email: '', phone: '', notice: '', recoverySession: false };
  let providers = null;
  let cooldownTimer = null;

  function eye(id) {
    return '<button type="button" class="auth-eye" data-eye="' + id + '" aria-label="Show password" aria-pressed="false">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/></svg></button>';
  }

  function passwordField(id, label, autocomplete, extra = '') {
    return '<label class="auth-field"><span>' + label + '</span><div class="auth-input-wrap"><input id="' + id + '" type="password" autocomplete="' + autocomplete + '" required minlength="8" placeholder="••••••••" ' + extra + '>' + eye(id) + '</div></label>';
  }

  function socialRow(compact) {
    const list = ['google', 'github', 'facebook', 'apple'];
    return '<div class="auth-social' + (compact ? ' compact' : '') + '">' + list.map(p => {
      const off = providers && providers.known && !providers[p];
      return '<button type="button" class="auth-social-btn' + (off ? ' is-off' : '') + '" data-provider="' + p + '"' + (off ? ' aria-disabled="true" title="Not switched on yet"' : '') + '>' + icon(p) + '<span>' + LABELS[p] + '</span></button>';
    }).join('') + '</div>';
  }

  function divider(text) { return '<div class="auth-divider"><span>' + text + '</span></div>'; }

  function msg(kind, text) {
    const box = $('#auth-msg');
    if (!box) return;
    box.className = 'auth-msg ' + (kind || '');
    box.textContent = text || '';
    box.hidden = !text;
  }

  function busy(form, on, label) {
    const btn = $('button[type=submit]', form);
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Please wait…'; }
    else if (btn.dataset.label) btn.textContent = btn.dataset.label;
    btn.disabled = on;
    $$('input', form).forEach(i => { i.readOnly = on; });
  }

  function strength(pw) {
    let score = 0;
    if (pw.length >= 8) score++;
    if (pw.length >= 12) score++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
    if (/\d/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;
    return Math.min(4, score);
  }

  function strengthMeter() {
    return '<div class="auth-strength" aria-hidden="true"><i></i><i></i><i></i><i></i></div><small class="auth-hint" id="strength-label">Use 8+ characters with letters and numbers.</small>';
  }

  /* ---------- views ---------- */
  function tabs() {
    const active = view.name === 'signup' ? 'signup' : 'signin';
    return '<div class="auth-tabs" role="tablist"><button role="tab" aria-selected="' + (active === 'signin') + '" data-go="signin">Sign in</button><button role="tab" aria-selected="' + (active === 'signup') + '" data-go="signup">Create account</button></div>';
  }

  function viewSignIn() {
    return tabs() +
      '<h1 class="auth-title">Welcome back.</h1><p class="auth-sub">Sign in to open the vault on this device.</p>' +
      socialRow() + divider('or with email') +
      '<form id="auth-form" novalidate>' +
        '<label class="auth-field"><span>Email</span><input id="f-email" type="email" autocomplete="email" required placeholder="you@example.com" value="' + esc(view.email) + '"></label>' +
        passwordField('f-password', 'Password', 'current-password') +
        '<div class="auth-row"><button type="button" class="auth-link" data-go="forgot">Forgot password?</button></div>' +
        '<p id="auth-msg" class="auth-msg" role="alert" hidden></p>' +
        '<button class="auth-primary" type="submit">Sign in</button>' +
      '</form>' +
      '<div class="auth-alt"><button type="button" class="auth-ghost" data-go="phone">Use phone number</button><button type="button" class="auth-ghost" data-go="magic">Email me a sign-in link</button></div>';
  }

  function viewSignUp() {
    return tabs() +
      '<h1 class="auth-title">Create your account.</h1><p class="auth-sub">New here? Make an account to browse the vault. Friends get view-only access.</p>' +
      socialRow(true) + divider('or sign up with email') +
      '<form id="auth-form" novalidate>' +
        '<label class="auth-field"><span>Name</span><input id="f-name" type="text" autocomplete="name" placeholder="Your name" maxlength="60"></label>' +
        '<label class="auth-field"><span>Email</span><input id="f-email" type="email" autocomplete="email" required placeholder="you@example.com" value="' + esc(view.email) + '"></label>' +
        passwordField('f-password', 'Password', 'new-password') + strengthMeter() +
        passwordField('f-confirm', 'Confirm password', 'new-password') +
        '<p id="auth-msg" class="auth-msg" role="alert" hidden></p>' +
        '<button class="auth-primary" type="submit">Create account</button>' +
      '</form>' +
      '<div class="auth-alt"><button type="button" class="auth-ghost" data-go="phone">Sign up with phone number</button></div>';
  }

  function viewPhone() {
    return '<button type="button" class="auth-back" data-go="signin">← Back</button>' +
      '<h1 class="auth-title">Phone number.</h1><p class="auth-sub">We’ll text you a 6-digit code. New numbers are registered automatically.</p>' +
      '<form id="auth-form" novalidate>' +
        '<label class="auth-field"><span>Mobile number</span><input id="f-phone" type="tel" inputmode="tel" autocomplete="tel" required placeholder="+91 98765 43210" value="' + esc(view.phone) + '"></label>' +
        '<small class="auth-hint">Include your country code, e.g. +91 for India.</small>' +
        '<p id="auth-msg" class="auth-msg" role="alert" hidden></p>' +
        '<button class="auth-primary" type="submit">Send code</button>' +
      '</form>';
  }

  function viewPhoneVerify() {
    return '<button type="button" class="auth-back" data-go="phone">← Change number</button>' +
      '<h1 class="auth-title">Enter the code.</h1><p class="auth-sub">Sent to <b>' + esc(view.phone) + '</b>.</p>' +
      '<form id="auth-form" novalidate>' +
        '<label class="auth-field"><span>6-digit code</span><input id="f-code" class="auth-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required placeholder="••••••"></label>' +
        '<p id="auth-msg" class="auth-msg" role="alert" hidden></p>' +
        '<button class="auth-primary" type="submit">Verify &amp; sign in</button>' +
      '</form>' +
      '<div class="auth-alt"><button type="button" class="auth-ghost" id="resend-code" disabled>Resend code</button></div>';
  }

  function viewMagic() {
    return '<button type="button" class="auth-back" data-go="signin">← Back</button>' +
      '<h1 class="auth-title">Email me a link.</h1><p class="auth-sub">No password needed — open the link we send and you’re in.</p>' +
      '<form id="auth-form" novalidate>' +
        '<label class="auth-field"><span>Email</span><input id="f-email" type="email" autocomplete="email" required placeholder="you@example.com" value="' + esc(view.email) + '"></label>' +
        '<p id="auth-msg" class="auth-msg" role="alert" hidden></p>' +
        '<button class="auth-primary" type="submit">Send sign-in link</button>' +
      '</form>';
  }

  function viewForgot() {
    return '<button type="button" class="auth-back" data-go="signin">← Back to sign in</button>' +
      '<h1 class="auth-title">Reset your password.</h1><p class="auth-sub">Enter your account email and we’ll send a link to choose a new password.</p>' +
      '<form id="auth-form" novalidate>' +
        '<label class="auth-field"><span>Email</span><input id="f-email" type="email" autocomplete="email" required placeholder="you@example.com" value="' + esc(view.email) + '"></label>' +
        '<p id="auth-msg" class="auth-msg" role="alert" hidden></p>' +
        '<button class="auth-primary" type="submit">Send reset link</button>' +
      '</form>';
  }

  function viewRecover() {
    return '<h1 class="auth-title">Choose a new password.</h1><p class="auth-sub">You’re verified. Set a new password to finish.</p>' +
      '<form id="auth-form" novalidate>' +
        passwordField('f-password', 'New password', 'new-password') + strengthMeter() +
        passwordField('f-confirm', 'Confirm new password', 'new-password') +
        '<p id="auth-msg" class="auth-msg" role="alert" hidden></p>' +
        '<button class="auth-primary" type="submit">Update password</button>' +
      '</form>';
  }

  function viewSent() {
    const reset = view.sentKind === 'reset';
    const magic = view.sentKind === 'magic';
    return '<div class="auth-sent"><span class="auth-sent-mark">✉</span><h1 class="auth-title">Check your email.</h1>' +
      '<p class="auth-sub">We sent ' + (reset ? 'a password reset link' : magic ? 'a sign-in link' : 'a confirmation link') + ' to <b>' + esc(view.email) + '</b>. Open it on this device to continue.</p>' +
      '<p class="auth-hint">Can’t find it? Look in spam — it can take a minute.</p>' +
      '<p id="auth-msg" class="auth-msg" role="alert" hidden></p>' +
      '<div class="auth-alt">' + (reset ? '' : '<button type="button" class="auth-ghost" id="resend-mail">Resend email</button>') + '<button type="button" class="auth-ghost" data-go="signin">Back to sign in</button></div></div>';
  }

  const VIEWS = { signin: viewSignIn, signup: viewSignUp, phone: viewPhone, 'phone-verify': viewPhoneVerify, magic: viewMagic, forgot: viewForgot, recover: viewRecover, sent: viewSent };

  /* ---------- render ---------- */
  function render() {
    const app = $('#app');
    if (!app) return;
    clearInterval(cooldownTimer);
    app.innerHTML =
      '<main class="auth-page">' +
        '<aside class="auth-aside" aria-hidden="true">' +
          '<span class="auth-brand"><span class="brand-mark">CV</span>CinemaVault</span><div class="auth-aside-inner">' +
          '<h2>Every film you want to remember.<em> One place.</em></h2>' +
          '<p>A living archive for everything you’ve watched, everything waiting, and whatever you discover next.</p>' +
        '</div></aside>' +
        '<section class="auth-panel"><div class="auth-card">' +
          '<span class="auth-brand mobile"><span class="brand-mark">CV</span>CinemaVault</span>' +
          (view.notice ? '<p class="auth-notice ' + (view.noticeKind || '') + '" role="status">' + esc(view.notice) + '</p>' : '') +
          (VIEWS[view.name] || viewSignIn)() +
          '<p class="auth-foot">Private archive · Friends can browse but never edit.</p>' +
        '</div></section>' +
      '</main>';
    bind();
    if (view.name === 'phone-verify') startCooldown(30);
    const first = $('#auth-form input:not([readonly])');
    if (first && !('ontouchstart' in global)) first.focus();
  }

  function go(name, extra) {
    Object.assign(view, { name, notice: '', sentKind: '' }, extra || {});
    render();
  }

  function startCooldown(seconds) {
    const btn = $('#resend-code');
    if (!btn) return;
    let left = seconds;
    const tick = () => {
      if (left <= 0) { btn.disabled = false; btn.textContent = 'Resend code'; clearInterval(cooldownTimer); return; }
      btn.disabled = true; btn.textContent = 'Resend code in ' + left + 's'; left -= 1;
    };
    tick();
    cooldownTimer = setInterval(tick, 1000);
  }

  /* ---------- behaviour ---------- */
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function normalizePhone(raw) {
    const cleaned = String(raw || '').replace(/[\s().-]/g, '');
    if (/^\+[1-9]\d{7,14}$/.test(cleaned)) return cleaned;
    return null;
  }

  async function onSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    msg('', '');
    const name = view.name;
    try {
      if (name === 'signin') {
        const email = $('#f-email').value.trim();
        const password = $('#f-password').value;
        view.email = email;
        if (!EMAIL_RE.test(email)) return msg('error', 'Enter a valid email address.');
        if (!password) return msg('error', 'Enter your password.');
        busy(form, true, 'Signing in…');
        try { await S().signIn(email, password); /* the app takes over on SIGNED_IN */ }
        catch (e) {
          busy(form, false);
          if (/email not confirmed/i.test(e?.message || '')) {
            msg('error', S().friendly(e));
            offerResend(email);
            return;
          }
          throw e;
        }
        return;
      }

      if (name === 'signup') {
        const nameVal = $('#f-name').value.trim();
        const email = $('#f-email').value.trim();
        const password = $('#f-password').value;
        const confirm = $('#f-confirm').value;
        view.email = email;
        if (!EMAIL_RE.test(email)) return msg('error', 'Enter a valid email address.');
        if (password.length < 8) return msg('error', 'Your password needs at least 8 characters.');
        if (strength(password) < 2) return msg('error', 'Make your password stronger — mix letters and numbers.');
        if (password !== confirm) return msg('error', 'The two passwords don’t match.');
        busy(form, true, 'Creating account…');
        try {
          const result = await S().signUp(email, password, nameVal);
          if (result.needsConfirmation) { view.sentKind = 'signup'; view.name = 'sent'; render(); }
          /* otherwise a session exists and the app takes over */
        } finally { if ($('#auth-form')) busy($('#auth-form'), false); }
        return;
      }

      if (name === 'phone') {
        const phone = normalizePhone($('#f-phone').value);
        view.phone = $('#f-phone').value.trim();
        if (!phone) return msg('error', 'Enter your number with the country code, like +91 98765 43210.');
        busy(form, true, 'Sending code…');
        try { await S().sendPhoneCode(phone); view.phone = phone; go('phone-verify'); }
        finally { if ($('#auth-form')) busy($('#auth-form'), false); }
        return;
      }

      if (name === 'phone-verify') {
        const code = $('#f-code').value.replace(/\D/g, '');
        if (code.length !== 6) return msg('error', 'Enter the 6-digit code from your text message.');
        busy(form, true, 'Verifying…');
        try { await S().verifyPhoneCode(view.phone, code); }
        catch (e) { busy(form, false); throw e; }
        return;
      }

      if (name === 'magic' || name === 'forgot') {
        const email = $('#f-email').value.trim();
        view.email = email;
        if (!EMAIL_RE.test(email)) return msg('error', 'Enter a valid email address.');
        busy(form, true, 'Sending…');
        try {
          if (name === 'magic') await S().sendMagicLink(email); else await S().sendPasswordReset(email);
          view.sentKind = name === 'magic' ? 'magic' : 'reset'; view.name = 'sent'; render();
        } finally { if ($('#auth-form')) busy($('#auth-form'), false); }
        return;
      }

      if (name === 'recover') {
        const password = $('#f-password').value;
        const confirm = $('#f-confirm').value;
        if (password.length < 8) return msg('error', 'Your password needs at least 8 characters.');
        if (strength(password) < 2) return msg('error', 'Make your password stronger — mix letters and numbers.');
        if (password !== confirm) return msg('error', 'The two passwords don’t match.');
        busy(form, true, 'Updating…');
        try {
          await S().updatePassword(password);
          view.recovering = false;
          if (typeof view.onRecovered === 'function') view.onRecovered();
        } finally { if ($('#auth-form')) busy($('#auth-form'), false); }
      }
    } catch (error) {
      msg('error', S().friendly(error));
    }
  }

  function offerResend(email) {
    const box = $('#auth-msg');
    if (!box) return;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'auth-link'; btn.textContent = ' Resend confirmation email';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { await S().resendConfirmation(email); msg('ok', 'Confirmation email sent to ' + email + '.'); }
      catch (e) { msg('error', S().friendly(e)); }
    });
    box.appendChild(btn);
  }

  async function onProvider(event) {
    const button = event.currentTarget;
    const provider = button.dataset.provider;
    if (button.classList.contains('is-off')) {
      msg('error', LABELS[provider] + ' sign-in isn’t switched on for this site yet. Use email or phone for now.');
      return;
    }
    button.disabled = true;
    msg('', '');
    try { await S().signInWithProvider(provider); /* browser redirects to the provider */ }
    catch (e) { button.disabled = false; msg('error', S().friendly(e)); }
  }

  function bind() {
    $$('[data-go]').forEach(el => el.addEventListener('click', () => {
      const keepEmail = $('#f-email')?.value.trim();
      if (keepEmail) view.email = keepEmail;
      go(el.dataset.go);
    }));
    $('#auth-form')?.addEventListener('submit', onSubmit);
    $$('[data-provider]').forEach(el => el.addEventListener('click', onProvider));
    $$('[data-eye]').forEach(el => el.addEventListener('click', () => {
      const input = document.getElementById(el.dataset.eye);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      el.setAttribute('aria-pressed', String(show));
      el.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    }));
    const pw = $('#f-password');
    if (pw && $('.auth-strength')) {
      const labels = ['Too weak', 'Weak', 'Okay', 'Good', 'Strong'];
      pw.addEventListener('input', () => {
        const s = pw.value ? strength(pw.value) : 0;
        $('.auth-strength').dataset.level = pw.value ? Math.max(1, s) : 0;
        $('#strength-label').textContent = pw.value ? labels[s] : 'Use 8+ characters with letters and numbers.';
      });
    }
    $('#f-code')?.addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
    $('#resend-code')?.addEventListener('click', async () => {
      msg('', '');
      try { await S().sendPhoneCode(view.phone); msg('ok', 'New code sent.'); startCooldown(30); }
      catch (e) { msg('error', S().friendly(e)); }
    });
    $('#resend-mail')?.addEventListener('click', async () => {
      const btn = $('#resend-mail'); btn.disabled = true;
      try {
        if (view.sentKind === 'magic') await S().sendMagicLink(view.email); else await S().resendConfirmation(view.email);
        msg('ok', 'Sent again to ' + view.email + '.');
      } catch (e) { msg('error', S().friendly(e)); }
      setTimeout(() => { if (btn.isConnected) btn.disabled = false; }, 30000);
    });
  }

  /* ---------- public API ---------- */
  async function show(options = {}) {
    Object.assign(view, { name: options.view || 'signin', notice: options.notice || '', noticeKind: options.noticeKind || '', sentKind: '', onRecovered: options.onRecovered });
    document.body.classList.add('auth-mode');
    render();
    // Dim switched-off providers once we know which ones the project has enabled.
    if (!providers) {
      providers = await S().providers();
      if (document.body.classList.contains('auth-mode') && (view.name === 'signin' || view.name === 'signup')) {
        $$('[data-provider]').forEach(el => {
          const off = providers.known && !providers[el.dataset.provider];
          el.classList.toggle('is-off', off);
          if (off) { el.setAttribute('aria-disabled', 'true'); el.title = 'Not switched on yet'; }
        });
      }
    }
  }

  function hide() { document.body.classList.remove('auth-mode'); clearInterval(cooldownTimer); }

  global.CinemaVaultAuthView = Object.freeze({ show, hide });
})(window);
