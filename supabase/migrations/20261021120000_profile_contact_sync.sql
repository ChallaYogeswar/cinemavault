-- Keep profiles.email / profiles.phone in step with auth.users when a user changes their email or phone.
create or replace function public.sync_profile_contact()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.profiles
     set email = new.email,
         phone = new.phone,
         updated_at = now()
   where id = new.id
     and (email is distinct from new.email or phone is distinct from new.phone);
  return new;
end;
$$;

revoke all on function public.sync_profile_contact() from public, anon, authenticated;

drop trigger if exists on_auth_user_contact_changed on auth.users;
create trigger on_auth_user_contact_changed
  after update of email, phone on auth.users
  for each row
  when (old.email is distinct from new.email or old.phone is distinct from new.phone)
  execute function public.sync_profile_contact();

-- One-time repair for any profile that is already out of date.
update public.profiles p
   set email = u.email, phone = u.phone, updated_at = now()
  from auth.users u
 where u.id = p.id
   and (p.email is distinct from u.email or p.phone is distinct from u.phone);
