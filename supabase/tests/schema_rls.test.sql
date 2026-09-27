-- CinemaVault PR3 database smoke tests.
-- Run with: supabase test db

begin;

select plan(9);

select has_table('public', 'movies', 'movies table exists');
select has_table('public', 'movie_metadata', 'movie_metadata table exists');
select has_table('public', 'sync_state', 'sync_state table exists');

select has_index('public', 'movies', 'movies_owner_identity_idx', 'movie identity index exists');
select has_index('public', 'movies', 'movies_owner_updated_idx', 'movie sync index exists');
select has_index('public', 'movie_metadata', 'movie_metadata_tmdb_identity_idx', 'TMDB lookup index exists');
select has_index('public', 'sync_state', 'sync_state_owner_device_idx', 'device sync index exists');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.movies'::regclass),
  'movies has RLS enabled'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.movie_metadata'::regclass)
  and
  (select relrowsecurity from pg_class where oid = 'public.sync_state'::regclass),
  'metadata and sync_state have RLS enabled'
);

select * from finish();

rollback;
