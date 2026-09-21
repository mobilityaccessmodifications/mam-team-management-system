begin;
select pg_advisory_xact_lock(hashtextextended('mam:calendar-team-filters:20260921180000',0));

create function private.is_calendar_manager(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles profile
    join public.internal_org_people person on person.auth_user_id=profile.id
    where profile.id=p_user_id and profile.app_role='manager'
      and profile.account_status='active' and profile.login_name is not null
      and person.is_active and person.node_kind='person'
      and private.is_active_portal_account(profile.id)
  );
$$;
revoke all on function private.is_calendar_manager(uuid) from public,anon,authenticated,service_role;

create or replace function public.list_leave_calendar_entries()
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
  v_team_ids uuid[] := array(select scope.person_id from private.manager_calendar_team_ids(v_actor_person_id) scope);
  v_is_manager boolean := private.is_calendar_manager(v_actor_user_id);
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
    -- Scope follows request ownership and the current reporting tree, never the submitter.
    select
      request.id,
      request.employee_person_id as person_id,
      employee.full_name as employee_name,
      employee.company_key,
      case when request.employee_person_id = v_actor_person_id then request.request_type_label
        when request.status = 'approved' then 'Approved leave' else 'Pending leave' end as leave_type_label,
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
      and (request.employee_person_id = v_actor_person_id or request.employee_person_id = any(v_team_ids))
      and request.status in ('submitted', 'approved')

    union all

    -- Cross-team approved visibility is disjoint from own/reporting-team rows:
    -- managers see active employees; explicit payroll grants retain archived history.
    -- Both are approved-only, category-minimised and exclude the actor's own rows
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
    where (v_can_view_all_approved or (v_is_manager and employee.is_active))
      and not (request.employee_person_id = any(v_team_ids))
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
  'Returns own leave, Managers’ reporting-team pending/approved absences and other active teams’ approved absences. Team categories are minimised. Explicit payroll grants retain approved-only history. No reasons, notes, attachments or balances.';

revoke all on function public.list_leave_calendar_entries()
  from public, anon, authenticated, service_role;
grant execute on function public.list_leave_calendar_entries()
  to authenticated;

create or replace function public.list_leave_calendar_entries_for_preview(p_person_id uuid)
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
  v_is_manager boolean;
  v_can_view_all_approved boolean;
  v_team_ids uuid[];
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

  v_is_manager := private.is_calendar_manager(v_target_user_id);
  v_team_ids := array(select scope.person_id from private.manager_calendar_team_ids(p_person_id) scope);
  v_can_view_all_approved := private.can_view_all_approved_leave_calendar_for(v_target_user_id);

  return query
  with scoped_leave as (
    select
      request.id,
      request.employee_person_id as person_id,
      employee.full_name as employee_name,
      employee.company_key,
      case when request.employee_person_id = p_person_id then request.request_type_label
        when request.status = 'approved' then 'Approved leave' else 'Pending leave' end as leave_type_label,
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
    where (request.employee_person_id = p_person_id or request.employee_person_id = any(v_team_ids))
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
    where (v_can_view_all_approved or (v_is_manager and employee.is_active))
      and not (request.employee_person_id = any(v_team_ids))
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


create function public.list_leave_calendar_entries_with_teams()
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
  status text,
  team_name text
)
language sql stable security definer set search_path = '' as $$
  select entry.*, coalesce(nullif(btrim(detail.team_name),''),'Unassigned') as team_name
  from public.list_leave_calendar_entries() entry
  left join private.employee_directory_details detail on detail.person_id=entry.person_id
  order by entry.start_date,entry.id;
$$;
revoke all on function public.list_leave_calendar_entries_with_teams() from public,anon,authenticated,service_role;
grant execute on function public.list_leave_calendar_entries_with_teams() to authenticated;

create function public.list_leave_calendar_entries_with_teams_for_preview(p_person_id uuid)
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
  status text,
  team_name text
)
language sql stable security definer set search_path = '' as $$
  select entry.*, coalesce(nullif(btrim(detail.team_name),''),'Unassigned') as team_name
  from public.list_leave_calendar_entries_for_preview(p_person_id) entry
  left join private.employee_directory_details detail on detail.person_id=entry.person_id
  order by entry.start_date,entry.id;
$$;
revoke all on function public.list_leave_calendar_entries_with_teams_for_preview(uuid) from public,anon,authenticated,service_role;
grant execute on function public.list_leave_calendar_entries_with_teams_for_preview(uuid) to authenticated;

commit;
