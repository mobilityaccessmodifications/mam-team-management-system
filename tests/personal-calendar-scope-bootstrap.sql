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
  node_kind text not null,
  is_active boolean not null,
  full_name text not null,
  company_key text not null
);

create table public.leave_requests (
  id uuid primary key,
  employee_person_id uuid not null references public.internal_org_people (id),
  user_id uuid not null references auth.users (id),
  request_type_label text not null,
  start_date date not null,
  end_date date not null,
  start_time time,
  end_time time,
  business_days integer not null,
  hours numeric,
  status text not null,
  created_at timestamptz not null default clock_timestamp()
);

create table private.employee_check_in_reminders (
  id uuid primary key,
  person_id uuid not null references public.internal_org_people (id),
  milestone text not null,
  reminder_sequence text not null,
  due_date date not null,
  delivery_status text not null
);

create table private.payroll_balance_import_grants (
  person_id uuid primary key references public.internal_org_people (id)
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

create function private.is_internal_org_hr()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles profile
    where profile.id = (select auth.uid())
      and profile.app_role = 'system_admin'
      and profile.account_status = 'active'
      and profile.login_name is not null
  );
$$;

create function private.has_payroll_balance_import_access_for(p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_active_portal_account(p_actor)
    and (
      exists (
        select 1 from public.profiles profile
        where profile.id = p_actor and profile.app_role = 'system_admin'
      )
      or exists (
        select 1
        from private.payroll_balance_import_grants access_grant
        join public.internal_org_people person on person.id = access_grant.person_id
        where person.auth_user_id = p_actor
          and person.node_kind = 'person'
          and person.is_active
      )
    );
$$;

-- Exact production OUT contract verified read-only on 16 September 2026.
-- The release migration must drop and recreate this function to add person_id.
create function public.list_leave_calendar_entries()
returns table (
  id uuid, employee_name text, company_key text, leave_type_label text,
  start_date date, end_date date, start_time time, end_time time,
  business_days integer, hours numeric, status text
)
language sql
stable
as $$
  select null::uuid, null::text, null::text, null::text, null::date, null::date,
    null::time, null::time, null::integer, null::numeric, null::text
  where false;
$$;

do $$
begin
  if pg_get_function_result('public.list_leave_calendar_entries()'::regprocedure)
      <> 'TABLE(id uuid, employee_name text, company_key text, leave_type_label text, start_date date, end_date date, start_time time without time zone, end_time time without time zone, business_days integer, hours numeric, status text)' then
    raise exception 'Calendar bootstrap no longer matches the verified production OUT contract.';
  end if;
end;
$$;

create function public.list_employee_check_in_calendar_entries()
returns table (
  reminder_id uuid, person_id uuid, employee_name text, milestone text,
  sequence text, due_date date, status text
)
language sql
stable
as $$
  select null::uuid, null::uuid, null::text, null::text, null::text, null::date, null::text
  where false;
$$;

create function public.list_employee_check_in_calendar_entries_for_preview(p_person_id uuid)
returns table (
  reminder_id uuid, person_id uuid, employee_name text, milestone text,
  sequence text, due_date date, status text
)
language sql
stable
as $$
  select null::uuid, null::uuid, null::text, null::text, null::text, null::date, null::text
  where false;
$$;

grant usage on schema auth, public to authenticated;
grant execute on function auth.uid(), auth.jwt() to authenticated;
grant execute on function public.list_leave_calendar_entries() to authenticated;
grant execute on function public.list_employee_check_in_calendar_entries() to authenticated;
grant execute on function public.list_employee_check_in_calendar_entries_for_preview(uuid) to authenticated;
