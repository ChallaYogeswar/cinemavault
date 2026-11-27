alter table public.movies drop constraint if exists movies_user_rating_check;
alter table public.movies add constraint movies_user_rating_check
  check (user_rating is null or (user_rating >= 0 and user_rating <= 5));
