create schema auth;
create schema private;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end;
$$;

create table auth.users (
  id uuid primary key
);

create table public.profiles (
  id uuid primary key references auth.users (id),
  app_role text not null,
  account_status text not null,
  login_name text
);

create table public.internal_org_people (
  id uuid primary key,
  auth_user_id uuid unique references auth.users (id),
  parent_id uuid references public.internal_org_people (id),
  node_kind text not null,
  is_active boolean not null,
  full_name text,
  company_key text not null
);

create table private.employee_directory_details (
  person_id uuid primary key references public.internal_org_people (id),
  date_of_birth date
);

create function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

create function private.is_active_portal_account(p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles profile
    where profile.id = p_user
      and profile.account_status = 'active'
      and profile.login_name is not null
  );
$$;

create function private.current_active_portal_employee_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select person.id
  from public.internal_org_people person
  where person.auth_user_id = (select auth.uid())
    and person.node_kind = 'person'
    and person.is_active
  limit 1;
$$;

-- Reproduce the deployed broad birthday contract. The forward migration must
-- preserve this narrow OUT shape while replacing its all-staff visibility.
create function public.list_calendar_birthdays()
returns table (
  employee_name text,
  birthday_month smallint,
  birthday_day smallint
)
language sql
stable
as $$
  select
    person.full_name,
    extract(month from detail.date_of_birth)::smallint,
    extract(day from detail.date_of_birth)::smallint
  from public.internal_org_people person
  join private.employee_directory_details detail on detail.person_id = person.id
  where person.node_kind = 'person'
    and person.is_active
    and detail.date_of_birth is not null;
$$;

grant usage on schema auth, public to authenticated;
grant execute on function auth.uid(), auth.jwt() to authenticated;
grant execute on function public.list_calendar_birthdays() to authenticated;
