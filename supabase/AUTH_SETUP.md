# CinemaVault — sign-in, roles and one-time setup

## How it works
- Auth = **Supabase Auth** (email + password, magic link, phone OTP, Google / GitHub / Facebook / Apple, password reset).
  The AUTHENTICATION zip's Model 1.5 feature set (accounts, recovery, social, phone) was used on Supabase Auth
  rather than a custom backend: no extra server, and RLS in Postgres enforces permissions.
- Roles: **owner** (you — one account, full edit) and **viewer** (everyone else who signs up — read-only).
  Enforced in the database (RLS), not just the UI: a viewer's write is rejected by Postgres.
- Sign in once per device; the session persists and refreshes automatically. No URL/key/TMDB entry on any device.

## 1. Run the roles migration (once)
Supabase → SQL Editor → paste `supabase/migrations/20261019120000_owner_viewer_roles.sql` → Run.
It is re-runnable. The account that currently owns the most movies becomes the **owner**; every new signup is a **viewer**.
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
