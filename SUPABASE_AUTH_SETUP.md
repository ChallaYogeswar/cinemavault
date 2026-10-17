# CinemaVault Supabase Auth Setup

This repository uses the browser-safe Supabase publishable key. Never place a service-role key in browser code or commit OAuth client secrets.

## 1. Supabase URL Configuration

In Supabase Dashboard → Authentication → URL Configuration:

- Set the Site URL to the canonical production URL you intend to keep.
- Add every URL you actually use to the Redirect URLs allowlist:
  - `https://cinemavaul.vercel.app/**`
  - `https://cinemavault-three.vercel.app/**`
  - `https://cinemavault-git-fix-supabase-movie-loading-cy-dev.vercel.app/**`
  - `https://challayogeswar.github.io/cinemavault/**`

Remove obsolete preview URLs after the final production domain is chosen. Do not configure every possible Vercel preview domain as a permanent redirect unless you need it.

## 2. Google sign-in

1. Supabase Dashboard → Authentication → Sign In / Providers → Google → Enable.
2. Create or select a Google OAuth client in Google Cloud Console.
3. Add the Supabase callback URL shown by Supabase as an Authorized redirect URI:
   `https://qhopjfqpnmoinggejgvt.supabase.co/auth/v1/callback`
4. Copy the Google client ID and client secret into the Supabase Google provider settings, then save.
5. In Google Cloud Console, configure the authorized JavaScript origin(s) for the app domains you use, as required by the selected OAuth client type.

## 3. GitHub sign-in

1. Supabase Dashboard → Authentication → Sign In / Providers → GitHub → Enable.
2. Create a GitHub OAuth App.
3. Set its Authorization callback URL to:
   `https://qhopjfqpnmoinggejgvt.supabase.co/auth/v1/callback`
4. Copy the GitHub Client ID and Client Secret into Supabase's GitHub provider settings, then save.

The OAuth callback URL above is Supabase's callback—not the app's Vercel/GitHub Pages URL. The app URL is configured separately in the redirect allowlist.

## 4. Password recovery

1. Keep the Supabase reset email template's confirmation link pointed at Supabase's verification URL (normally `{{ .ConfirmationURL }}`) so Supabase can validate the one-time token before redirecting back to the app.
2. The app requests a redirect ending in `?auth=reset-password`. After a valid recovery callback, the app displays the new-password and confirmation fields.
3. Set the email OTP expiry to a reasonable value in Supabase Auth settings. Reset links are single-use; request a new email and open the newest message once if the link reports `otp_expired`.
4. Test the complete sequence in a private/incognito window: request reset → open the newest email → enter matching passwords → submit → sign in with the new password.

## 5. Existing library ownership

The existing 3,155 movie rows belong to one Supabase user and are protected by Row Level Security. A newly registered account gets its own private, initially empty library; it does not inherit the existing user's collection. Continue signing in with the existing owner account to access that collection.
