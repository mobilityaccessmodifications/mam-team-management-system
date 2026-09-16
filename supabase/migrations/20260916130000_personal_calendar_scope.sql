begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:personal-calendar-scope:20260916130000', 0)
  );

  if to_regclass('public.leave_requests') is null
    or to_regclass('public.internal_org_people') is null
    or to_regclass('public.profiles') is null
    or to_regclass('private.employee_check_in_reminders') is null
    or to_regclass('private.payroll_balance_import_grants') is null
    or to_regprocedure('private.is_internal_org_hr()') is null
    or to_regprocedure('private.is_active_portal_account(uuid)') is null
    or to_regprocedure('private.current_active_portal_employee_id()') is null
    or to_regprocedure('private.has_payroll_balance_import_access_for(uuid)') is null
    or to_regprocedure('public.list_leave_calendar_entries()') is null
    or to_regprocedure('public.list_employee_check_in_calendar_entries()') is null
    or to_regprocedure('public.list_employee_check_in_calendar_entries_for_preview(uuid)') is null then
    raise exception 'Personal Calendar scope prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Viewing every employee's approved absence is deliberately separate from
-- reviewing leave. It does not grant decision, attachment, note or balance
-- access and therefore must not reuse the approval-grant table.
create table private.approved_leave_calendar_grants (
  person_id uuid primary key references public.internal_org_people (id) on delete cascade,
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default clock_timestamp()
);

comment on table private.approved_leave_calendar_grants is
  'Explicit active Accounts/Bookkeeping employee grants to see named approved absences and exact schedule/duration in Calendar for payroll processing. Grants confer no leave-review, reason, note, attachment or balance access.';

alter table private.approved_leave_calendar_grants enable row level security;
revoke all on table private.approved_leave_calendar_grants
  from public, anon, authenticated, service_role;

create function private.can_view_all_approved_leave_calendar_for(p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_actor is not null
    and private.is_active_portal_account(p_actor)
    and (
      exists (
        select 1
        from public.profiles profile
        where profile.id = p_actor
          and profile.app_role = 'system_admin'
          and profile.account_status = 'active'
          and profile.login_name is not null
      )
      or exists (
      select 1
      from private.approved_leave_calendar_grants access_grant
      join public.internal_org_people person on person.id = access_grant.person_id
      join public.profiles profile on profile.id = person.auth_user_id
      where person.auth_user_id = p_actor
        and person.node_kind = 'person'
        and person.is_active
        and profile.account_status = 'active'
        and profile.login_name is not null
      )
    );
$$;

comment on function private.can_view_all_approved_leave_calendar_for(uuid) is
  'Target-aware approved-leave Calendar capability used by the live and System Admin preview projections.';

revoke all on function private.can_view_all_approved_leave_calendar_for(uuid)
  from public, anon, authenticated, service_role;

create function private.can_view_all_approved_leave_calendar()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_view_all_approved_leave_calendar_for((select auth.uid()));
$$;

comment on function private.can_view_all_approved_leave_calendar() is
  'True for System Admin or an explicitly granted active linked employee. It is a view-only Calendar capability.';

revoke all on function private.can_view_all_approved_leave_calendar()
  from public, anon, authenticated, service_role;

-- Ordinary employees receive only their own submitted/approved leave. An
-- explicit view-only delegate receives current and archived employees' approved dates and
-- names, exact schedule and duration for payroll processing, but the leave
-- category remains minimised to "Approved leave". Reasons, notes, evidence,
-- balances and decision authority remain outside this projection.
-- The deployed function predates stable Calendar person IDs. PostgreSQL cannot
-- change a table-returning function's OUT row type with CREATE OR REPLACE, so
-- recreate it inside this transaction and restore its authenticated grant.
drop function public.list_leave_calendar_entries();

create function public.list_leave_calendar_entries()
returns table (
  id uuid,
  person_id uuid,
  employee_name text,
  company_key text,
  leave_type_label text,
  start_date date,
  end_date date,
  start_time time without time zone,
  end_time time without time zone,
  business_days integer,
  hours numeric,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_person_id uuid := private.current_active_portal_employee_id();
  v_can_view_all_approved boolean := private.can_view_all_approved_leave_calendar();
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account() then
    raise exception 'An active portal account is required to view the calendar.'
      using errcode = '42501';
  end if;

  if v_actor_person_id is null and not v_can_view_all_approved then
    raise exception 'An active linked employee account is required to view the calendar.'
      using errcode = '42501';
  end if;

  return query
  with scoped_leave as (
    -- Personal self-service is based only on the employee the request belongs
    -- to. The submitter can be a manager acting on another person's behalf,
    -- so request.user_id must never widen this branch.
    select
      request.id,
      request.employee_person_id as person_id,
      employee.full_name as employee_name,
      employee.company_key,
      request.request_type_label as leave_type_label,
      request.start_date,
      request.end_date,
      request.start_time,
      request.end_time,
      request.business_days,
      request.hours,
      case request.status
        when 'approved' then 'Approved'
        else 'Pending'
      end as status,
      request.created_at
    from public.leave_requests request
    join public.internal_org_people employee
      on employee.id = request.employee_person_id
     and employee.node_kind = 'person'
    where v_actor_person_id is not null
      and request.employee_person_id = v_actor_person_id
      and request.status in ('submitted', 'approved')

    union all

    -- The payroll branch is deliberately disjoint from personal self-service:
    -- it is approved-only, category-minimised and excludes the actor's own rows
    -- to avoid duplicate records and preserve the actor's ordinary own view.
    select
      request.id,
      request.employee_person_id as person_id,
      case
        when employee.is_active then employee.full_name
        else employee.full_name || ' (archived)'
      end as employee_name,
      employee.company_key,
      'Approved leave'::text as leave_type_label,
      request.start_date,
      request.end_date,
      request.start_time,
      request.end_time,
      request.business_days,
      request.hours,
      'Approved'::text as status,
      request.created_at
    from public.leave_requests request
    join public.internal_org_people employee
      on employee.id = request.employee_person_id
     and employee.node_kind = 'person'
    where v_can_view_all_approved
      and request.status = 'approved'
      and (
        v_actor_person_id is null
        or request.employee_person_id <> v_actor_person_id
      )
  )
  select
    scoped_leave.id,
    scoped_leave.person_id,
    scoped_leave.employee_name,
    scoped_leave.company_key,
    scoped_leave.leave_type_label,
    scoped_leave.start_date,
    scoped_leave.end_date,
    scoped_leave.start_time,
    scoped_leave.end_time,
    scoped_leave.business_days,
    scoped_leave.hours,
    scoped_leave.status
  from scoped_leave
  order by scoped_leave.start_date, scoped_leave.created_at, scoped_leave.id;
end;
$$;

comment on function public.list_leave_calendar_entries() is
  'Returns own pending/approved leave, plus named category-minimised Approved leave with exact schedule/duration for explicitly granted Accounts/Bookkeeping payroll processing and System Admin. Retained archived-employee history is labelled (archived); all other employee records are omitted.';

revoke all on function public.list_leave_calendar_entries()
  from public, anon, authenticated, service_role;
grant execute on function public.list_leave_calendar_entries()
  to authenticated;

create function public.list_leave_calendar_entries_for_preview(p_person_id uuid)
returns table (
  id uuid,
  person_id uuid,
  employee_name text,
  company_key text,
  leave_type_label text,
  start_date date,
  end_date date,
  start_time time without time zone,
  end_time time without time zone,
  business_days integer,
  hours numeric,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_target_user_id uuid;
  v_can_view_all_approved boolean;
begin
  if not private.is_internal_org_hr() then
    raise exception 'Only a Super Admin may preview Leave Calendar scope.' using errcode = '42501';
  end if;

  select person.auth_user_id
  into v_target_user_id
  from public.internal_org_people person
  join public.profiles profile on profile.id = person.auth_user_id
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active
    and profile.account_status = 'active'
    and profile.login_name is not null
    and private.is_active_portal_account(profile.id);

  if not found or v_target_user_id is null then
    raise exception 'The selected employee is unavailable.' using errcode = '23503';
  end if;

  v_can_view_all_approved := private.can_view_all_approved_leave_calendar_for(v_target_user_id);

  return query
  with scoped_leave as (
    select
      request.id,
      request.employee_person_id as person_id,
      employee.full_name as employee_name,
      employee.company_key,
      request.request_type_label as leave_type_label,
      request.start_date,
      request.end_date,
      request.start_time,
      request.end_time,
      request.business_days,
      request.hours,
      case request.status
        when 'approved' then 'Approved'
        else 'Pending'
      end as status,
      request.created_at
    from public.leave_requests request
    join public.internal_org_people employee
      on employee.id = request.employee_person_id
     and employee.node_kind = 'person'
    where request.employee_person_id = p_person_id
      and request.status in ('submitted', 'approved')

    union all

    select
      request.id,
      request.employee_person_id as person_id,
      case
        when employee.is_active then employee.full_name
        else employee.full_name || ' (archived)'
      end as employee_name,
      employee.company_key,
      'Approved leave'::text as leave_type_label,
      request.start_date,
      request.end_date,
      request.start_time,
      request.end_time,
      request.business_days,
      request.hours,
      'Approved'::text as status,
      request.created_at
    from public.leave_requests request
    join public.internal_org_people employee
      on employee.id = request.employee_person_id
     and employee.node_kind = 'person'
    where v_can_view_all_approved
      and request.status = 'approved'
      and request.employee_person_id <> p_person_id
  )
  select
    scoped_leave.id,
    scoped_leave.person_id,
    scoped_leave.employee_name,
    scoped_leave.company_key,
    scoped_leave.leave_type_label,
    scoped_leave.start_date,
    scoped_leave.end_date,
    scoped_leave.start_time,
    scoped_leave.end_time,
    scoped_leave.business_days,
    scoped_leave.hours,
    scoped_leave.status
  from scoped_leave
  order by scoped_leave.start_date, scoped_leave.created_at, scoped_leave.id;
end;
$$;

comment on function public.list_leave_calendar_entries_for_preview(uuid) is
  'System Admin-only projection of the selected active employee''s exact Leave Calendar scope.';

revoke all on function public.list_leave_calendar_entries_for_preview(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_leave_calendar_entries_for_preview(uuid)
  to authenticated;

-- Calendar Check-ins are personal for employees. System Admin retains the
-- operational all-employee projection; managers use the dedicated Check-ins
-- workspace for their team rather than receiving team records in Calendar.
create or replace function public.list_employee_check_in_calendar_entries()
returns table (
  reminder_id uuid,
  person_id uuid,
  employee_name text,
  milestone text,
  sequence text,
  due_date date,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_person_id uuid := private.current_active_portal_employee_id();
  v_is_system_admin boolean := private.is_internal_org_hr();
begin
  if not v_is_system_admin and v_actor_person_id is null then
    return;
  end if;

  return query
  select
    reminder.id,
    person.id,
    person.full_name,
    reminder.milestone,
    reminder.reminder_sequence,
    reminder.due_date,
    reminder.delivery_status
  from private.employee_check_in_reminders reminder
  join public.internal_org_people person on person.id = reminder.person_id
  where person.node_kind = 'person'
    and person.is_active
    and reminder.reminder_sequence = 'initial'
    and reminder.delivery_status not in ('superseded', 'cancelled')
    and (v_is_system_admin or person.id = v_actor_person_id)
  order by
    reminder.due_date,
    lower(person.full_name),
    reminder.milestone,
    reminder.reminder_sequence;
end;
$$;

comment on function public.list_employee_check_in_calendar_entries() is
  'Returns the active linked employee''s own Check-in dates; System Admin receives the operational all-employee projection.';

create or replace function public.list_employee_check_in_calendar_entries_for_preview(
  p_person_id uuid
)
returns table (
  reminder_id uuid,
  person_id uuid,
  employee_name text,
  milestone text,
  sequence text,
  due_date date,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_internal_org_hr() then
    raise exception 'Only a Super Admin may preview Check-in Calendar scope.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.internal_org_people person
    join public.profiles profile on profile.id = person.auth_user_id
    where person.id = p_person_id
      and person.node_kind = 'person'
      and person.is_active
      and profile.account_status = 'active'
      and profile.login_name is not null
      and private.is_active_portal_account(profile.id)
  ) then
    raise exception 'The selected employee is unavailable.' using errcode = '23503';
  end if;

  return query
  select
    reminder.id,
    person.id,
    person.full_name,
    reminder.milestone,
    reminder.reminder_sequence,
    reminder.due_date,
    reminder.delivery_status
  from public.internal_org_people person
  join private.employee_check_in_reminders reminder on reminder.person_id = person.id
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active
    and reminder.reminder_sequence = 'initial'
    and reminder.delivery_status not in ('superseded', 'cancelled')
  order by
    reminder.due_date,
    reminder.milestone,
    reminder.reminder_sequence;
end;
$$;

comment on function public.list_employee_check_in_calendar_entries_for_preview(uuid) is
  'Super Admin-only Change Profile projection of the selected employee''s own Check-in dates.';

-- Change Profile may show Gerard's real importer surface without granting
-- access based on a display name or leaking the grant list to the browser.
create function public.can_import_payroll_balances_for_preview(p_person_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_target_auth_user_id uuid;
begin
  if not private.is_internal_org_hr() then
    raise exception 'Only a Super Admin may preview payroll import access.' using errcode = '42501';
  end if;

  select person.auth_user_id
  into v_target_auth_user_id
  from public.internal_org_people person
  join public.profiles profile on profile.id = person.auth_user_id
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active
    and profile.account_status = 'active'
    and profile.login_name is not null;

  if not found or v_target_auth_user_id is null then
    return false;
  end if;

  return private.has_payroll_balance_import_access_for(v_target_auth_user_id);
end;
$$;

comment on function public.can_import_payroll_balances_for_preview(uuid) is
  'System Admin-only boolean projection of whether the selected active account would receive payroll import access.';

revoke all on function public.can_import_payroll_balances_for_preview(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.can_import_payroll_balances_for_preview(uuid)
  to authenticated;

commit;
