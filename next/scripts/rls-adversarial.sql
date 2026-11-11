-- CinemaVault RLS adversarial suite.
--
-- Attacks the database the way a hostile client would (raw statements as `anon`, as a signed-in
-- VIEWER and as the OWNER, bypassing every application check) and reports PASS/FAIL per attack.
-- Everything runs inside one transaction that is ROLLED BACK: it changes nothing, so it is safe on
-- the development project. NEVER point it at production (see docs/migration-baseline.md).
--
-- Needs exactly one owner and at least one viewer in public.profiles.
--
-- Run on real Supabase:  paste into the SQL editor / execute_sql (it is a single batch).
-- Run in CI (PGlite):    tests/unit/rlsAdversarial.test.ts executes this same file against a
--                        database built from supabase/migrations/*.sql.
-- Expected result: every row starts with PASS. Any FAIL is a release blocker.

begin;

-- Impersonates a role the way PostgREST does, runs one statement, and reports what happened:
--   'ok:<rows>'  statement ran and touched/returned that many rows (RLS filtering shows as 0)
--   'err:<code>' statement failed (42501 = permission denied / row-level security violation)
create function pg_temp.attempt(who uuid, stmt text) returns text language plpgsql as $f$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', coalesce(who::text, ''), true);
  perform set_config('request.jwt.claims',
    case when who is null then '' else json_build_object('sub', who, 'role', 'authenticated')::text end, true);
  execute case when who is null then 'set local role anon' else 'set local role authenticated' end;
  begin
    execute stmt;
    get diagnostics n = row_count;
    reset role;
    return 'ok:' || n;
  exception when others then
    reset role;
    return 'err:' || sqlstate;
  end;
end $f$;

do $suite$
declare
  o uuid := (select id from public.profiles where role = 'owner');
  v uuid := (select id from public.profiles where role = 'viewer' order by id limit 1);
  m uuid;
  total bigint;
  r text;
  out text := '';
  n int := 0;

begin
  if o is null or v is null then
    raise exception 'need exactly one owner and at least one viewer in public.profiles';
  end if;

  insert into public.movies (owner_id, title, normalized_title, media_type, year)
    values (o, 'RLS probe seed', 'rls probe seed', 'movie', 1999) returning id into m;
  insert into public.movie_metadata (movie_id, overview) values (m, 'seed overview');
  select count(*) into total from public.movies where owner_id = o;

  -- ---------------------------------------------------------------- anonymous (no JWT)
  r := pg_temp.attempt(null, 'select 1 from public.movies');
  n := n + 1; out := out || format(E'%s %s anon cannot read movies (%s)\n', case when r in ('err:42501','ok:0') then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(null, 'select 1 from public.profiles');
  n := n + 1; out := out || format(E'%s %s anon cannot read profiles (%s)\n', case when r in ('err:42501','ok:0') then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(null, 'select 1 from public.movie_metadata');
  n := n + 1; out := out || format(E'%s %s anon cannot read movie_metadata (%s)\n', case when r in ('err:42501','ok:0') then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(null, 'select 1 from public.sync_state');
  n := n + 1; out := out || format(E'%s %s anon cannot read sync_state (%s)\n', case when r in ('err:42501','ok:0') then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(null, format($q$insert into public.movies (owner_id,title,normalized_title) values (%L,'anon','anon')$q$, o));
  n := n + 1; out := out || format(E'%s %s anon cannot insert a movie, even claiming the owner (%s)\n', case when r = 'err:42501' then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(null, format($q$update public.movies set title='anon' where id=%L$q$, m));
  n := n + 1; out := out || format(E'%s %s anon cannot update a movie (%s)\n', case when r in ('err:42501','ok:0') then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(null, format($q$delete from public.movies where id=%L$q$, m));
  n := n + 1; out := out || format(E'%s %s anon cannot delete a movie (%s)\n', case when r in ('err:42501','ok:0') then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(null, 'select public.is_owner()');
  n := n + 1; out := out || format(E'%s %s anon cannot call is_owner() (%s)\n', case when r = 'err:42501' then 'PASS' else 'FAIL' end, n, r);

  -- ---------------------------------------------------------------- viewer
  r := pg_temp.attempt(v, 'select 1 from public.movies');
  n := n + 1; out := out || format(E'%s %s viewer reads exactly the owner''s library (%s of %s rows)\n', case when r = 'ok:' || total then 'PASS' else 'FAIL' end, n, r, total);
  r := pg_temp.attempt(v, format($q$insert into public.movies (owner_id,title,normalized_title) values (%L,'viewer own','viewer own')$q$, v));
  n := n + 1; out := out || format(E'%s %s viewer cannot insert a movie under their own id (%s)\n', case when r = 'err:42501' then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(v, format($q$insert into public.movies (owner_id,title,normalized_title) values (%L,'viewer as owner','viewer as owner')$q$, o));
  n := n + 1; out := out || format(E'%s %s viewer cannot insert with the payload owner_id set to the owner (%s)\n', case when r = 'err:42501' then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(v, format($q$update public.movies set title='hijack' where id=%L$q$, m));
  n := n + 1; out := out || format(E'%s %s viewer cannot update a title via REST (%s)\n', case when r in ('err:42501','ok:0') and (select title from public.movies where id = m) = 'RLS probe seed' then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(v, format($q$update public.movies set owner_id=%L where id=%L$q$, v, m));
  n := n + 1; out := out || format(E'%s %s viewer cannot take over a movie by changing owner_id (%s)\n', case when r in ('err:42501','ok:0') and (select owner_id from public.movies where id = m) = o then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(v, format($q$update public.movies set deleted_at=now() where id=%L$q$, m));
  n := n + 1; out := out || format(E'%s %s viewer cannot soft-delete (%s)\n', case when r in ('err:42501','ok:0') and (select deleted_at from public.movies where id = m) is null then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(v, format($q$delete from public.movies where id=%L$q$, m));
  n := n + 1; out := out || format(E'%s %s viewer cannot hard-delete (%s)\n', case when r in ('err:42501','ok:0') and exists (select 1 from public.movies where id = m) then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(v, format($q$insert into public.movie_metadata (movie_id, overview) values (%L,'x')$q$, gen_random_uuid()));
  n := n + 1; out := out || format(E'%s %s viewer cannot insert metadata (%s)\n', case when r in ('err:42501','err:23503') then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(v, format($q$update public.movie_metadata set overview='hijack' where movie_id=%L$q$, m));
  n := n + 1; out := out || format(E'%s %s viewer cannot update the owner''s metadata (%s)\n', case when r in ('err:42501','ok:0') and (select overview from public.movie_metadata where movie_id = m) = 'seed overview' then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(v, format($q$delete from public.movie_metadata where movie_id=%L$q$, m));
  n := n + 1; out := out || format(E'%s %s viewer cannot delete the owner''s metadata (%s)\n', case when r in ('err:42501','ok:0') and exists (select 1 from public.movie_metadata where movie_id = m) then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(v, format($q$insert into public.sync_state (owner_id, device_id) values (%L,'d1')$q$, v));
  n := n + 1; out := out || format(E'%s %s viewer cannot write sync_state for themselves (%s)\n', case when r = 'err:42501' then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(v, format($q$insert into public.sync_state (owner_id, device_id) values (%L,'d1')$q$, o));
  n := n + 1; out := out || format(E'%s %s viewer cannot write sync_state as the owner (%s)\n', case when r = 'err:42501' then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(v, format($q$update public.profiles set role='owner' where id=%L$q$, v));
  n := n + 1; out := out || format(E'%s %s viewer cannot promote themselves to owner (%s)\n', case when r in ('err:42501','ok:0') and (select role from public.profiles where id = v) = 'viewer' then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(v, format($q$update public.profiles set role='viewer' where id=%L$q$, o));
  n := n + 1; out := out || format(E'%s %s viewer cannot demote the owner (%s)\n', case when r in ('err:42501','ok:0') and (select role from public.profiles where id = o) = 'owner' then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(v, format($q$update public.profiles set id=%L where id=%L$q$, o, v));
  n := n + 1; out := out || format(E'%s %s viewer cannot rewrite their profile id (%s)\n', case when r in ('err:42501','ok:0') then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(v, format($q$update public.profiles set display_name='renamed' where id=%L$q$, v));
  n := n + 1; out := out || format(E'%s %s viewer may rename themselves (positive control) (%s)\n', case when r = 'ok:1' then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(v, format($q$update public.profiles set display_name='renamed' where id=%L$q$, o));
  n := n + 1; out := out || format(E'%s %s viewer cannot rename the owner (%s)\n', case when r in ('err:42501','ok:0') then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(v, 'select 1 from public.profiles');
  n := n + 1; out := out || format(E'%s %s viewer sees only their own profile row (%s)\n', case when r = 'ok:1' then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(v, format($q$insert into public.profiles (id, role) values (%L,'owner')$q$, gen_random_uuid()));
  n := n + 1; out := out || format(E'%s %s viewer cannot insert a profile (%s)\n', case when r = 'err:42501' then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(v, format($q$delete from public.profiles where id=%L$q$, o));
  n := n + 1; out := out || format(E'%s %s viewer cannot delete the owner''s profile (%s)\n', case when r = 'err:42501' or (r = 'ok:0' and exists (select 1 from public.profiles where id = o)) then 'PASS' else 'FAIL' end, n, r);

  -- ---------------------------------------------------------------- owner: everything intended works
  r := pg_temp.attempt(o, 'select 1 from public.movies');
  n := n + 1; out := out || format(E'%s %s owner reads the whole library (%s of %s rows)\n', case when r = 'ok:' || total then 'PASS' else 'FAIL' end, n, r, total);
  r := pg_temp.attempt(o, format($q$insert into public.movies (owner_id,title,normalized_title,media_type,year) values (%L,'Owner Probe','owner probe','movie',2001)$q$, o));
  n := n + 1; out := out || format(E'%s %s owner can insert a movie (%s)\n', case when r = 'ok:1' then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(o, format($q$insert into public.movies (owner_id,title,normalized_title,media_type,year) values (%L,'For Viewer','for viewer','movie',2002)$q$, v));
  n := n + 1; out := out || format(E'%s %s owner cannot create rows owned by someone else (%s)\n', case when r = 'err:42501' then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(o, format($q$update public.movies set title='Owner Edited' where id=%L$q$, m));
  n := n + 1; out := out || format(E'%s %s owner can update a movie (%s)\n', case when r = 'ok:1' and (select title from public.movies where id = m) = 'Owner Edited' then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(o, format($q$update public.movies set owner_id=%L where id=%L$q$, v, m));
  n := n + 1; out := out || format(E'%s %s owner cannot hand a movie to another owner_id (%s)\n', case when r = 'err:42501' and (select owner_id from public.movies where id = m) = o then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(o, format($q$update public.movie_metadata set overview='owner edit' where movie_id=%L$q$, m));
  n := n + 1; out := out || format(E'%s %s owner can update metadata (%s)\n', case when r = 'ok:1' then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(o, format($q$insert into public.sync_state (owner_id, device_id) values (%L,'d1')$q$, o));
  n := n + 1; out := out || format(E'%s %s owner can write sync_state (%s)\n', case when r = 'ok:1' then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(o, format($q$update public.profiles set role='viewer' where id=%L$q$, o));
  n := n + 1; out := out || format(E'%s %s not even the owner can edit their own role over REST (%s)\n', case when r in ('err:42501','ok:0') and (select role from public.profiles where id = o) = 'owner' then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(o, 'select 1 from public.profiles');
  n := n + 1; out := out || format(E'%s %s owner sees only their own profile row (%s)\n', case when r = 'ok:1' then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(o, format($q$update public.movies set deleted_at=now() where id=%L$q$, m));
  n := n + 1; out := out || format(E'%s %s owner can soft-delete (%s)\n', case when r = 'ok:1' and (select deleted_at from public.movies where id = m) is not null then 'PASS' else 'FAIL' end, n, r);
  r := pg_temp.attempt(o, format($q$delete from public.movies where id=%L$q$, m));
  n := n + 1; out := out || format(E'%s %s owner can hard-delete, and metadata goes with it (%s)\n', case when r = 'ok:1' and not exists (select 1 from public.movie_metadata where movie_id = m) then 'PASS' else 'FAIL' end, n, r);

  -- ---------------------------------------------------------------- structure
  begin
    update public.profiles set role = 'owner' where id = v;
    n := n + 1; out := out || format(E'FAIL %s a second owner can be created\n', n);
  exception when unique_violation then
    n := n + 1; out := out || format(E'PASS %s a second owner cannot exist (unique index)\n', n);
  end;
  n := n + 1; out := out || format(E'%s %s row-level security is enabled on every public table\n',
    case when (select count(*) from pg_class c join pg_namespace s on s.oid = c.relnamespace
               where s.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity) = 0 then 'PASS' else 'FAIL' end, n);

  perform set_config('cv.out', out, true);
end
$suite$;

select unnest(string_to_array(trim(trailing E'\n' from current_setting('cv.out')), E'\n')) as result;

rollback;
