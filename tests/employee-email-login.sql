-- Disposable PostgreSQL database only. All identities and credentials synthetic.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
create schema auth;
create schema private;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.actor',true),'')::uuid
$$;
create table auth.users (id uuid primary key, email text, encrypted_password text);
create table public.profiles (
  id uuid primary key references auth.users(id), full_name text, preferred_name text,
  app_role text default 'employee', login_name text unique,
  account_status text default 'active', account_version bigint default 1,
  must_change_password boolean default false, temporary_password_issued_at timestamptz,
  password_changed_at timestamptz, disabled_at timestamptz,
  credentials_valid_after timestamptz default now(), updated_at timestamptz default now(),
  constraint profiles_login_name_format_check check (
    login_name is null or (login_name=lower(btrim(login_name)) and login_name ~ '^[a-z0-9][a-z0-9._-]{2,63}$')
  )
);
create table public.internal_org_people (
  id uuid primary key, full_name text, node_kind text default 'person',
  is_active boolean default true, auth_user_id uuid references auth.users(id),
  version bigint default 1, updated_by uuid
);
create table private.portal_account_admin_events (
  actor_user_id uuid, target_user_id uuid, event_type text, before_state jsonb, after_state jsonb
);
create function private.is_portal_account_admin() returns boolean language sql stable as $$
  select exists(select 1 from public.profiles where id=auth.uid() and app_role='system_admin' and account_status='active')
$$;
-- Existing service-only resolver: the migration must preserve this boundary.
create function public.resolve_portal_login_auth_email(p_login_name text)
returns text language sql stable security definer set search_path='' as $$
  select member.email from public.profiles profile join auth.users member on member.id=profile.id
  where profile.login_name=lower(btrim(p_login_name)) and profile.account_status='active'
    and profile.login_name is not null and member.email is not null limit 1
$$;
revoke all on function public.resolve_portal_login_auth_email(text) from public,anon,authenticated;
grant execute on function public.resolve_portal_login_auth_email(text) to service_role;

insert into auth.users values
  ('10000000-0000-0000-0000-000000000001','admin@opaque.invalid','synthetic-admin-hash'),
  ('10000000-0000-0000-0000-000000000002','work@opaque.invalid','synthetic-work-hash'),
  ('10000000-0000-0000-0000-000000000003','personal@opaque.invalid','synthetic-personal-hash'),
  ('10000000-0000-0000-0000-000000000004','pending@opaque.invalid','synthetic-pending-hash'),
  ('10000000-0000-0000-0000-000000000005','new@opaque.invalid','synthetic-new-hash');
insert into public.profiles(id,full_name,app_role,login_name) values
  ('10000000-0000-0000-0000-000000000001','Admin','system_admin','admin'),
  ('10000000-0000-0000-0000-000000000002','Work Person','employee','work.person'),
  ('10000000-0000-0000-0000-000000000003','Personal Person','employee','personal.person'),
  ('10000000-0000-0000-0000-000000000004','Pending Person','employee','pending.person');
insert into public.internal_org_people(id,full_name,auth_user_id) values
  ('20000000-0000-0000-0000-000000000002','Work Person','10000000-0000-0000-0000-000000000002'),
  ('20000000-0000-0000-0000-000000000003','Personal Person','10000000-0000-0000-0000-000000000003'),
  ('20000000-0000-0000-0000-000000000004','Pending Person','10000000-0000-0000-0000-000000000004'),
  ('20000000-0000-0000-0000-000000000005','New Person',null);
create temporary table before_auth as table auth.users;
create temporary table before_admin as select * from public.profiles where login_name='admin';

\ir ../supabase/migrations/20260918110000_employee_email_login.sql

begin;
select set_config('test.actor','10000000-0000-0000-0000-000000000001',true);
select * from public.update_portal_login('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002',' Work.Person@company.example ',1);
select * from public.update_portal_login('20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000003','person+home@personal.example',1);
select * from public.create_portal_account('20000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000005','new@company.example','employee',1);

do $$ begin
  if public.resolve_portal_login_auth_email('WORK.PERSON@COMPANY.EXAMPLE') <> 'work@opaque.invalid'
    or public.resolve_portal_login_auth_email('person+home@personal.example') <> 'personal@opaque.invalid'
    or public.resolve_portal_login_auth_email('work.person') is not null
    or public.resolve_portal_login_auth_email('unknown@company.example') is not null then
    raise exception 'Email resolution or old-name removal failed';
  end if;
  if public.resolve_portal_login_auth_email('admin') <> 'admin@opaque.invalid'
    or public.resolve_portal_login_auth_email('pending.person') <> 'pending@opaque.invalid'
    or exists ((select * from before_admin) except (select * from public.profiles where login_name='admin'))
    or exists ((select * from before_auth) except (select * from auth.users)) then
    raise exception 'Existing administrator, missing-email login or Auth credentials changed';
  end if;
  if (select count(*) from private.portal_account_admin_events) <> 3 then
    raise exception 'Account changes must remain audited';
  end if;
  begin
    perform public.update_portal_login('20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000003','WORK.PERSON@COMPANY.EXAMPLE',2);
    raise exception 'Duplicate email accepted';
  exception when unique_violation then null; end;
  begin
    perform public.update_portal_login('20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000003','other@company.example',1);
    raise exception 'Stale account version accepted';
  exception when serialization_failure then null; end;
  if private.is_valid_portal_login('Upper@company.example')
    or private.is_valid_portal_login('two@@company.example')
    or private.is_valid_portal_login('.first@company.example')
    or private.is_valid_portal_login('first..last@company.example')
    or private.is_valid_portal_login(repeat('x',65)||'@company.example')
    or private.is_valid_portal_login('person@'||repeat('x',64)||'.example')
    or private.is_valid_portal_login(null) then
    raise exception 'Invalid email accepted';
  end if;
  if not private.is_valid_portal_login('admin') or not private.is_valid_portal_login('system_admin') then
    raise exception 'Legacy administrator usernames rejected';
  end if;
  if has_function_privilege('anon','public.resolve_portal_login_auth_email(text)','execute')
    or has_function_privilege('authenticated','public.resolve_portal_login_auth_email(text)','execute')
    or not has_function_privilege('service_role','public.resolve_portal_login_auth_email(text)','execute') then
    raise exception 'Resolver privacy changed';
  end if;
end $$;

select set_config('test.actor','10000000-0000-0000-0000-000000000002',true);
do $$ begin
  begin
    perform public.update_portal_login('20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000003','stolen@company.example',2);
    raise exception 'Employee renamed another account';
  exception when insufficient_privilege then null; end;
end $$;
update public.profiles set account_status='disabled' where login_name='person+home@personal.example';
do $$ begin
  if public.resolve_portal_login_auth_email('person+home@personal.example') is not null then
    raise exception 'Disabled account resolved';
  end if;
end $$;
rollback;
