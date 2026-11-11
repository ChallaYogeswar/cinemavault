-- Schema fingerprint: one hash over everything the migrations create in `public`
-- (columns, indexes, RLS policies, constraints, function names, triggers, grants, column grants).
-- Run it on two databases; if the hash and item count match, the schemas match.
--
-- Known value on a Supabase project built from supabase/migrations/*.sql (measured on development):
--   hash 8ea6abe519010d495886599d8a56738f   items 149
-- Production reports 150 items / 31d2a757712224d3fa14212f6e38e8f8 because Supabase's
-- "automatically enable RLS" setting adds the `rls_auto_enable` function; with that one
-- function removed from the list it is identical (see docs/migration-baseline.md).
--
-- Read-only. Safe on any project.
select md5(string_agg(k || v, E'\n' order by k, v)) as hash, count(*)::int as items from (
  select 'col' k, table_name||'.'||column_name||' '||data_type||' '||is_nullable||' '||coalesce(column_default,'') v from information_schema.columns where table_schema='public'
  union all select 'idx', indexdef from pg_indexes where schemaname='public'
  union all select 'pol', tablename||' '||policyname||' '||cmd||' '||coalesce(qual,'')||' | '||coalesce(with_check,'') from pg_policies where schemaname='public'
  union all select 'con', conrelid::regclass||' '||conname||' '||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace
  union all select 'fn', proname from pg_proc where pronamespace='public'::regnamespace
  union all select 'trg', tgrelid::regclass||' '||tgname from pg_trigger where not tgisinternal and tgrelid::regclass::text in ('public.movies','public.sync_state','auth.users')
  union all select 'grant', grantee||' '||table_name||' '||privilege_type from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated')
  union all select 'colgrant', grantee||' '||table_name||'.'||column_name||' '||privilege_type from information_schema.column_privileges where table_schema='public' and grantee in ('anon','authenticated') and privilege_type='UPDATE'
) s;
