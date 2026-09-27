-- CinemaVault initial Supabase schema.
-- PR3: database foundation only. No frontend integration is included here.

create extension if not exists pgcrypto;

create table if not exists public.movies (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,

  title text not null,
  normalized_title text not null,
  media_type text not null default 'movie'
    check (media_type in ('movie', 'tv')),
  year smallint
    check (year is null or year between 1888 and 2100),

  genre text,
  runtime_minutes integer
    check (runtime_minutes is null or runtime_minutes > 0),
  watched boolean not null default false,
  watched_on date,

  user_rating numeric(3,1)
    check (user_rating is null or (user_rating >= 0 and user_rating <= 10)),
  verdict text,
  technical_notes text,
  shot_link text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint movies_title_not_blank check (length(btrim(title)) > 0),
  constraint movies_normalized_title_not_blank check (length(btrim(normalized_title)) > 0),
  constraint movies_watched_date_consistency
    check (watched = true or watched_on is null)
);

create unique index if not exists movies_owner_identity_idx
  on public.movies (owner_id, normalized_title, media_type, year)
  where deleted_at is null;

create index if not exists movies_owner_updated_idx
  on public.movies (owner_id, updated_at desc);

create index if not exists movies_owner_media_type_idx
  on public.movies (owner_id, media_type);

create index if not exists movies_owner_watched_idx
  on public.movies (owner_id, watched);

create index if not exists movies_owner_title_idx
  on public.movies (owner_id, normalized_title);

create table if not exists public.movie_metadata (
  movie_id uuid primary key references public.movies(id) on delete cascade,

  tmdb_id integer,
  tmdb_media_type text
    check (tmdb_media_type is null or tmdb_media_type in ('movie', 'tv')),
  poster_url text,
  backdrop_url text,
  overview text,
  tmdb_rating numeric(3,1)
    check (tmdb_rating is null or (tmdb_rating >= 0 and tmdb_rating <= 10)),
  trailer_key text,

  metadata_updated_at timestamptz not null default now()
);

create index if not exists movie_metadata_tmdb_identity_idx
  on public.movie_metadata (tmdb_id, tmdb_media_type)
  where tmdb_id is not null and tmdb_media_type is not null;

create index if not exists movie_metadata_updated_idx
  on public.movie_metadata (metadata_updated_at desc);

create table if not exists public.sync_state (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  last_synced_at timestamptz,
  cursor text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint sync_state_device_not_blank check (length(btrim(device_id)) > 0)
);

create unique index if not exists sync_state_owner_device_idx
  on public.sync_state (owner_id, device_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists movies_set_updated_at on public.movies;
create trigger movies_set_updated_at
before update on public.movies
for each row
execute function public.set_updated_at();

drop trigger if exists sync_state_set_updated_at on public.sync_state;
create trigger sync_state_set_updated_at
before update on public.sync_state
for each row
execute function public.set_updated_at();

alter table public.movies enable row level security;
alter table public.movie_metadata enable row level security;
alter table public.sync_state enable row level security;

-- Keep Data API access least-privilege. RLS policies alone do not remove table grants.
revoke all on table public.movies, public.movie_metadata, public.sync_state from anon;
grant select, insert, update, delete on table public.movies, public.movie_metadata, public.sync_state to authenticated;

drop policy if exists "movies_select_own" on public.movies;
create policy "movies_select_own"
on public.movies
for select
to authenticated
using (owner_id = (select auth.uid()));

drop policy if exists "movies_insert_own" on public.movies;
create policy "movies_insert_own"
on public.movies
for insert
to authenticated
with check (owner_id = (select auth.uid()));

drop policy if exists "movies_update_own" on public.movies;
create policy "movies_update_own"
on public.movies
for update
to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

drop policy if exists "movies_delete_own" on public.movies;
create policy "movies_delete_own"
on public.movies
for delete
to authenticated
using (owner_id = (select auth.uid()));

drop policy if exists "movie_metadata_select_own" on public.movie_metadata;
create policy "movie_metadata_select_own"
on public.movie_metadata
for select
to authenticated
using (
  exists (
    select 1
    from public.movies m
    where m.id = movie_metadata.movie_id
      and m.owner_id = (select auth.uid())
  )
);

drop policy if exists "movie_metadata_insert_own" on public.movie_metadata;
create policy "movie_metadata_insert_own"
on public.movie_metadata
for insert
to authenticated
with check (
  exists (
    select 1
    from public.movies m
    where m.id = movie_metadata.movie_id
      and m.owner_id = (select auth.uid())
  )
);

drop policy if exists "movie_metadata_update_own" on public.movie_metadata;
create policy "movie_metadata_update_own"
on public.movie_metadata
for update
to authenticated
using (
  exists (
    select 1
    from public.movies m
    where m.id = movie_metadata.movie_id
      and m.owner_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1
    from public.movies m
    where m.id = movie_metadata.movie_id
      and m.owner_id = (select auth.uid())
  )
);

drop policy if exists "movie_metadata_delete_own" on public.movie_metadata;
create policy "movie_metadata_delete_own"
on public.movie_metadata
for delete
to authenticated
using (
  exists (
    select 1
    from public.movies m
    where m.id = movie_metadata.movie_id
      and m.owner_id = (select auth.uid())
  )
);

drop policy if exists "sync_state_select_own" on public.sync_state;
create policy "sync_state_select_own"
on public.sync_state
for select
to authenticated
using (owner_id = (select auth.uid()));

drop policy if exists "sync_state_insert_own" on public.sync_state;
create policy "sync_state_insert_own"
on public.sync_state
for insert
to authenticated
with check (owner_id = (select auth.uid()));

drop policy if exists "sync_state_update_own" on public.sync_state;
create policy "sync_state_update_own"
on public.sync_state
for update
to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

drop policy if exists "sync_state_delete_own" on public.sync_state;
create policy "sync_state_delete_own"
on public.sync_state
for delete
to authenticated
using (owner_id = (select auth.uid()));

comment on table public.movies is
  'Canonical CinemaVault library records. Ownership is enforced through owner_id and RLS.';

comment on table public.movie_metadata is
  'TMDB-derived metadata cached separately from user-owned library fields.';

comment on table public.sync_state is
  'Per-user, per-device synchronization cursor/state for the local-first client.';
