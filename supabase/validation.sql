-- CinemaVault PR3 schema validation.
-- Run after migrations with:
--   supabase db reset
-- or against a target database after applying migrations.

do $$
declare
  required_table text;
begin
  foreach required_table in array array['movies', 'movie_metadata', 'sync_state']
  loop
    if to_regclass('public.' || required_table) is null then
      raise exception 'Missing required table: public.%', required_table;
    end if;
  end loop;
end;
$$;

do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename
    from pg_tables
    where schemaname = 'public'
      and tablename in ('movies', 'movie_metadata', 'sync_state')
  loop
    if not exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = r.schemaname
        and c.relname = r.tablename
        and c.relrowsecurity = true
    ) then
      raise exception 'RLS is disabled on public.%', r.tablename;
    end if;
  end loop;
end;
$$;

do $$
declare
  expected_policy_count integer := 12;
  actual_policy_count integer;
begin
  select count(*)
  into actual_policy_count
  from pg_policies
  where schemaname = 'public'
    and tablename in ('movies', 'movie_metadata', 'sync_state');

  if actual_policy_count <> expected_policy_count then
    raise exception
      'Expected % CinemaVault RLS policies, found %',
      expected_policy_count,
      actual_policy_count;
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'movies'
      and indexname = 'movies_owner_identity_idx'
  ) then
    raise exception 'Missing movies_owner_identity_idx';
  end if;

  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'sync_state'
      and indexname = 'sync_state_owner_device_idx'
  ) then
    raise exception 'Missing sync_state_owner_device_idx';
  end if;
end;
$$;

select
  'CinemaVault PR3 schema validation passed' as status,
  current_database() as database_name,
  now() as validated_at;
