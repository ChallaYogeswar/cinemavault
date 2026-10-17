-- Align CinemaVault user ratings with the UI's five-star scale.
-- Production currently enforces user_rating between 0 and 5.
-- This migration is deliberately idempotent and does not rewrite movie rows.

alter table public.movies
  drop constraint if exists movies_user_rating_check;

alter table public.movies
  add constraint movies_user_rating_check
  check (user_rating is null or (user_rating >= 0 and user_rating <= 5));
