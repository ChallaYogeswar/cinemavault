# CinemaVault — sign-in, roles and one-time setup

## How it works
- Auth = **Supabase Auth** (email + password, magic link, phone OTP, Google / GitHub / Facebook / Apple, password reset).
  The AUTHENTICATION zip's Model 1.5 feature set (accounts, recovery, social, phone) was used on Supabase Auth
  rather than a custom backend: no extra server, and RLS in Postgres enforces permissions.
- Roles: **owner** (you — one account, full edit) and **viewer** (everyone else who signs up — read-only).
  Enforced in the database (RLS), not just the UI: a viewer's write is rejected by Postgres.
- Sign in once per device; the session persists and refreshes automatically. No URL/key/TMDB entry on any device.

## 1. Run the migrations (once each)
Supabase → SQL Editor → paste `supabase/migrations/20261019120000_owner_viewer_roles.sql` → Run.
Then run `supabase/migrations/20261021120000_profile_contact_sync.sql` (keeps the profile email/phone in step when a user changes it).
Both are re-runnable. The account that currently owns the most movies becomes the **owner**; every new signup is a **viewer**.
Check: `select email, role from public.profiles;`

## 2. Auth URL configuration
Supabase → Authentication → URL Configuration
- Site URL: `https://cinemavaul.vercel.app`
- Redirect URLs: `https://cinemavaul.vercel.app/**` (and `http://localhost:3000/**` for local dev)

## 3. Enable sign-in methods (login page dims any that are off)
Callback URL for every OAuth provider: `https://qhopjfqpnmoinggejgvt.supabase.co/auth/v1/callback`
- **Google**: Google Cloud Console → OAuth client (Web) → paste Client ID/Secret in Supabase → Providers → Google.
- **GitHub**: GitHub → Settings → Developer settings → OAuth Apps.
- **Facebook**: developers.facebook.com → app → Facebook Login.
- **Apple**: requires an Apple Developer account (Services ID + key); the secret JWT expires every 6 months.
- **Phone**: Providers → Phone → enable and connect an SMS provider (Twilio / MessageBird / Vonage). SMS costs money.
- **Email**: keep "Confirm email" on. Built-in SMTP is heavily rate-limited — set custom SMTP (Resend, Brevo…) under Auth → SMTP.
- Recommended: Auth → Providers → Email → enable leaked-password protection.

## 4. Posters/trailers without a key on each device
Vercel → Project → Settings → Environment Variables → add `TMDB_API_KEY` (v3 key or v4 token) for Production → redeploy.
The `/api/tmdb` function keeps the key server-side and only answers signed-in users.

## Sharing with a friend
Send them the URL → Create account → confirm email → they see the full library, read-only.
To promote someone: `update public.profiles set role='owner' where email='...'` (only one owner is allowed by design;
demote yourself first).

## Fixing "redirect_uri" errors (Google / GitHub)
Supabase always sends the provider this callback — it must match **exactly** (https, no trailing slash, correct project ref):

    https://qhopjfqpnmoinggejgvt.supabase.co/auth/v1/callback

- **GitHub** "The redirect_uri is not associated with this application": GitHub → Settings → Developer settings → OAuth Apps →
  your app (Client ID `Ov23liEBhjjCzSHc1sE5`) → **Authorization callback URL** = the URL above (not the Vercel URL).
  The same Client ID + secret must be saved in Supabase → Authentication → Providers → GitHub.
- **Google** "Error 400: redirect_uri_mismatch": Google Cloud Console → APIs & Services → Credentials → the Web OAuth client
  (ID starts `627733649699-4cblvpu2…`) → **Authorized redirect URIs** → add the URL above; **Authorized JavaScript origins** → add
  `https://cinemavaul.vercel.app`. Changes can take a few minutes. While the consent screen is in *Testing*, only listed test users
  can sign in — add your friends or click *Publish app*.

## Account management (Settings → Sign-in & security)
- Change email: current password required (if the account has one) → Supabase emails a confirmation. With Supabase's default
  "Secure email change" it must be approved from **both** the old and new inbox. Pending changes show with a Resend button.
- Change/set password: current password + new + confirm. Accounts without a password (Google/link/phone) can set one, or use
  "Email me a reset link".
- Forgot password: login page → Forgot password → email link → "Choose a new password".
- Sign out / sign out of all devices (global session revoke).
- Customize the emails under Supabase → Authentication → Emails (Confirm signup, Magic link, Change email, Reset password).

## Posters not loading?
Settings → Posters & trailers → **Test poster service** says exactly what's wrong (missing `TMDB_API_KEY`, key rejected, or function not deployed).
