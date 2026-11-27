create or replace function public.sync_profile_contact()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  update public.profiles
     set email = new.email, phone = new.phone, updated_at = now()
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
