-- CinemaVault: owner / viewer roles and view-only sharing.
--  * The library owner (the account that owns the movies) can read and write.
--  * Anyone else who creates an account becomes a 'viewer': they can READ the owner's library
--    but every write is rejected by RLS, whatever the client sends.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  phone text,
  display_name text,
  role text not null default 'viewer' check (role in ('owner', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Exactly one owner can exist.
create unique index if not exists profiles_single_owner_idx
  on public.profiles ((role)) where role = 'owner';

alter table public.profiles enable row level security;

-- Helper functions (SECURITY DEFINER so policies can consult profiles without recursion).
create or replace function public.is_owner()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'owner'
  );
$$;

create or replace function public.library_owner_id()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select p.id from public.profiles p where p.role = 'owner' limit 1;
$$;

revoke all on function public.is_owner() from public, anon;
revoke all on function public.library_owner_id() from public, anon;
grant execute on function public.is_owner() to authenticated;
grant execute on function public.library_owner_id() to authenticated;

-- Create a profile automatically for every new sign-up (email, social or phone).
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, phone, display_name, role)
  values (
    new.id,
    new.email,
    new.phone,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    'viewer'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Back-fill existing accounts; whoever owns the library becomes the owner.
insert into public.profiles (id, email, phone, display_name, role)
select u.id, u.email, u.phone,
       coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', split_part(u.email, '@', 1)),
       'viewer'
from auth.users u
on conflict (id) do nothing;

update public.profiles
set role = 'owner'
where id = (
  select owner_id from public.movies group by owner_id order by count(*) desc limit 1
)
and not exists (select 1 from public.profiles where role = 'owner');

-- Profiles: each user reads their own row; may edit only their display name (never their role).
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select to authenticated using (id = (select auth.uid()));

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;
grant update (display_name) on table public.profiles to authenticated;

-- Movies: owner reads/writes their own; every signed-in user may READ the owner's library.
drop policy if exists "movies_select_own" on public.movies;
drop policy if exists "movies_select_shared" on public.movies;
create policy "movies_select_shared" on public.movies
  for select to authenticated
  using (owner_id = (select auth.uid()) or owner_id = (select public.library_owner_id()));

drop policy if exists "movies_insert_own" on public.movies;
create policy "movies_insert_own" on public.movies
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and (select public.is_owner()));

drop policy if exists "movies_update_own" on public.movies;
create policy "movies_update_own" on public.movies
  for update to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_owner()))
  with check (owner_id = (select auth.uid()) and (select public.is_owner()));

drop policy if exists "movies_delete_own" on public.movies;
create policy "movies_delete_own" on public.movies
  for delete to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_owner()));

-- Metadata follows the movie: readable wherever the movie is readable (the sub-select is itself
-- filtered by the movies policy); writable by the owner only.
drop policy if exists "movie_metadata_select_own" on public.movie_metadata;
drop policy if exists "movie_metadata_select_shared" on public.movie_metadata;
create policy "movie_metadata_select_shared" on public.movie_metadata
  for select to authenticated
  using (exists (select 1 from public.movies m where m.id = movie_metadata.movie_id));

drop policy if exists "movie_metadata_insert_own" on public.movie_metadata;
create policy "movie_metadata_insert_own" on public.movie_metadata
  for insert to authenticated
  with check ((select public.is_owner()) and exists (
    select 1 from public.movies m where m.id = movie_metadata.movie_id and m.owner_id = (select auth.uid())));

drop policy if exists "movie_metadata_update_own" on public.movie_metadata;
create policy "movie_metadata_update_own" on public.movie_metadata
  for update to authenticated
  using ((select public.is_owner()) and exists (
    select 1 from public.movies m where m.id = movie_metadata.movie_id and m.owner_id = (select auth.uid())))
  with check ((select public.is_owner()) and exists (
    select 1 from public.movies m where m.id = movie_metadata.movie_id and m.owner_id = (select auth.uid())));

drop policy if exists "movie_metadata_delete_own" on public.movie_metadata;
create policy "movie_metadata_delete_own" on public.movie_metadata
  for delete to authenticated
  using ((select public.is_owner()) and exists (
    select 1 from public.movies m where m.id = movie_metadata.movie_id and m.owner_id = (select auth.uid())));

-- sync_state is a per-device owner concern; viewers never write it.
drop policy if exists "sync_state_insert_own" on public.sync_state;
create policy "sync_state_insert_own" on public.sync_state
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and (select public.is_owner()));

drop policy if exists "sync_state_update_own" on public.sync_state;
create policy "sync_state_update_own" on public.sync_state
  for update to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_owner()))
  with check (owner_id = (select auth.uid()) and (select public.is_owner()));

-- Linter fix: pin the trigger function's search_path.
alter function public.set_updated_at() set search_path = '';
