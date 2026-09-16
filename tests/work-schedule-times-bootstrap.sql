create schema auth;
create schema private;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end;
$$;

create table auth.users (id uuid primary key);

create table public.profiles (
  id uuid primary key references auth.users (id),
  full_name text,
  app_role text not null,
  account_status text not null default 'active',
  login_name text,
  credentials_valid_after timestamptz
);

create table public.internal_org_people (
  id uuid primary key,
  auth_user_id uuid unique references auth.users (id),
  parent_id uuid references public.internal_org_people (id),
  node_kind text not null default 'person',
  is_active boolean not null default true,
  full_name text,
  company_key text not null default 'mam',
  updated_by uuid,
  version bigint not null default 0
);

create table private.employee_directory_details (
  person_id uuid primary key references public.internal_org_people (id),
  working_weekdays smallint[],
  updated_by uuid,
  version bigint not null default 0
);

create table private.employee_directory_audit_events (
  id bigint generated always as identity primary key,
  person_id uuid not null,
  actor_user_id uuid not null,
  event_type text not null,
  changed_fields text[] not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint employee_directory_audit_events_changed_fields_check check (
    changed_fields <@ array[
      'first_name', 'last_name', 'work_email', 'personal_email', 'phone',
      'position_title', 'team_name', 'manager_id', 'country', 'address',
      'date_of_birth', 'started_date', 'scheduled_employment_end_date',
      'company_key', 'is_active', 'sort_order', 'laptop_supplied',
      'laptop_id', 'mouse_id', 'keyboard_id', 'asset_tags',
      'employment_type', 'working_weekdays'
    ]::text[]
  )
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

create function private.valid_employee_working_weekdays(p_value smallint[])
returns boolean
language sql
immutable
as $$
  select p_value is null or (
    cardinality(p_value) between 1 and 7
    and not exists (select 1 from unnest(p_value) item(value) where value not between 1 and 7)
    and cardinality(p_value) = (select count(distinct value) from unnest(p_value) item(value))
  );
$$;

create function private.normalise_employee_working_weekdays(p_value smallint[])
returns smallint[]
language plpgsql
immutable
as $$
declare
  v_result smallint[];
begin
  if p_value is null or cardinality(p_value) = 0 then return null; end if;
  if not private.valid_employee_working_weekdays(p_value) then
    raise exception 'Choose valid, non-repeating work days.' using errcode = '22023';
  end if;
  select array_agg(value order by value) into v_result from unnest(p_value) item(value);
  return v_result;
end;
$$;

alter table private.employee_directory_details
  add constraint employee_directory_details_working_weekdays_check
  check (private.valid_employee_working_weekdays(working_weekdays));

create function private.normalise_employee_work_schedule_reason(p_value text, p_label text)
returns text
language plpgsql
immutable
as $$
declare
  v_result text := btrim(coalesce(p_value, ''));
begin
  if char_length(v_result) not between 1 and 1000 then
    raise exception '% must contain between 1 and 1,000 characters.', p_label using errcode = '22023';
  end if;
  return v_result;
end;
$$;

create table private.employee_work_schedule_change_requests (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.internal_org_people (id),
  submitted_by_user_id uuid not null references auth.users (id),
  original_working_weekdays smallint[] check (private.valid_employee_working_weekdays(original_working_weekdays)),
  requested_working_weekdays smallint[] not null check (private.valid_employee_working_weekdays(requested_working_weekdays)),
  request_reason text not null,
  status text not null default 'submitted' check (status in ('submitted', 'approved', 'declined', 'cancelled')),
  submitted_at timestamptz not null default clock_timestamp(),
  decided_at timestamptz,
  decided_by_user_id uuid references auth.users (id),
  reviewer_name text,
  decision_reason text
);

create unique index employee_work_schedule_change_requests_one_submitted_idx
  on private.employee_work_schedule_change_requests (person_id)
  where status = 'submitted';

create table private.employee_work_schedule_change_events (
  id bigint generated always as identity primary key,
  request_id uuid not null references private.employee_work_schedule_change_requests (id),
  person_id uuid not null references public.internal_org_people (id),
  actor_user_id uuid not null references auth.users (id),
  event_type text not null,
  from_working_weekdays smallint[],
  to_working_weekdays smallint[] not null,
  reason text not null,
  created_at timestamptz not null default clock_timestamp()
);

create function private.has_current_portal_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles profile
    where profile.id = (select auth.uid())
      and profile.account_status = 'active'
      and profile.login_name is not null
  );
$$;

create function private.is_system_portal_account_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_current_portal_access() and exists (
    select 1 from public.profiles profile
    where profile.id = (select auth.uid()) and profile.app_role = 'system_admin'
  );
$$;

create function private.resolve_internal_org_employee_manager(p_person_id uuid)
returns table (manager_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select parent.id
  from public.internal_org_people person
  join public.internal_org_people parent on parent.id = person.parent_id
  join public.profiles profile on profile.id = parent.auth_user_id
  where person.id = p_person_id
    and parent.is_active
    and profile.app_role = 'manager'
    and profile.account_status = 'active';
$$;

create function private.employee_work_schedule_workspace_json(uuid, boolean, uuid, boolean)
returns jsonb language sql stable security definer as $$ select '{}'::jsonb $$;

create function private.submit_employee_work_schedule_change_request(uuid, smallint[], text)
returns uuid language sql security definer as $$ select gen_random_uuid() $$;

create function public.decide_employee_work_schedule_change_request(uuid, text, text)
returns void language plpgsql security definer as $$ begin null; end $$;

create function public.list_employee_directory_records_with_work_schedule(p_include_archived boolean default false)
returns table (
  person_id uuid, person_version bigint, detail_version bigint, company_key text,
  is_active boolean, first_name text, last_name text, full_name text,
  position_title text, team_name text, manager_id uuid, manager_name text,
  work_email text, personal_email text, phone text, country text, address text,
  date_of_birth date, started_date date, scheduled_employment_end_date date,
  archive_reason text, employment_type text, has_paid_leave_entitlement boolean,
  laptop_supplied text, laptop_id text, mouse_id text, keyboard_id text,
  asset_tags text[], working_weekdays smallint[]
)
language sql stable security definer
as $$
  select person.id, person.version, detail.version, person.company_key,
    person.is_active, person.full_name, ''::text, person.full_name,
    'Role'::text, 'Team'::text, person.parent_id, ''::text,
    ''::text, ''::text, ''::text, ''::text, ''::text,
    null::date, null::date, null::date, ''::text, 'full_time'::text, true,
    null::text, null::text, null::text, null::text, '{}'::text[], detail.working_weekdays
  from public.internal_org_people person
  join private.employee_directory_details detail on detail.person_id = person.id
  where p_include_archived or person.is_active;
$$;

create function public.get_employee_directory_record_with_work_schedule(p_person_id uuid)
returns table (
  person_id uuid, person_version bigint, detail_version bigint, company_key text,
  is_active boolean, first_name text, last_name text, full_name text,
  position_title text, team_name text, manager_id uuid, manager_name text,
  work_email text, personal_email text, phone text, country text, address text,
  date_of_birth date, started_date date, scheduled_employment_end_date date,
  archive_reason text, employment_type text, has_paid_leave_entitlement boolean,
  laptop_supplied text, laptop_id text, mouse_id text, keyboard_id text,
  asset_tags text[], working_weekdays smallint[]
)
language sql stable security definer
as $$
  select record.*
  from public.list_employee_directory_records_with_work_schedule(true) record
  where record.person_id = p_person_id
$$;

create function public.create_employee_directory_record_with_work_schedule(
  text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,
  text,text,text,text,text[],text,text,smallint[],integer default 0
)
returns table (person_id uuid, person_version bigint, detail_version bigint)
language plpgsql security definer as $$ begin raise exception 'Not used by this fixture'; end $$;

create function public.update_employee_directory_record_with_work_schedule(
  uuid,text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,
  bigint,bigint,text,text,text,text,text[],text,text,smallint[],integer default null
)
returns table (person_id uuid, person_version bigint, detail_version bigint)
language plpgsql security definer as $$ begin raise exception 'Not used by this fixture'; end $$;

create function public.get_my_employee_work_schedule_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person_id uuid;
  v_role text;
begin
  select person.id, profile.app_role into v_person_id, v_role
  from public.profiles profile
  left join public.internal_org_people person
    on person.auth_user_id = profile.id and person.is_active
  where profile.id = (select auth.uid());
  return private.employee_work_schedule_workspace_json(
    v_person_id,
    false,
    case when v_role in ('manager', 'system_admin') then v_person_id end,
    v_role = 'system_admin'
  );
end;
$$;

create function public.submit_my_employee_work_schedule_change_request(
  p_requested_working_weekdays smallint[],
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_id uuid;
begin
  select person.id into v_person_id
  from public.internal_org_people person
  where person.auth_user_id = (select auth.uid()) and person.is_active;
  return private.submit_employee_work_schedule_change_request(
    v_person_id,
    p_requested_working_weekdays,
    p_reason
  );
end;
$$;

grant usage on schema auth, public to authenticated;
grant execute on function auth.uid(), auth.jwt() to authenticated;
grant execute on function public.get_my_employee_work_schedule_workspace() to authenticated;
grant execute on function public.submit_my_employee_work_schedule_change_request(smallint[], text) to authenticated;
grant execute on function public.decide_employee_work_schedule_change_request(uuid, text, text) to authenticated;
