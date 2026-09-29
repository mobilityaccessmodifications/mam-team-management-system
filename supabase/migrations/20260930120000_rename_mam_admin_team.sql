begin;

select pg_advisory_xact_lock(hashtextextended('mam:rename-mam-admin-team:20260930120000', 0));

lock table private.employee_directory_details in share row exclusive mode;

alter table private.employee_directory_details
  drop constraint employee_directory_details_canonical_team;

-- Preserve employee identities and reporting while renaming the classification.
-- The original backfill suppresses the check-in trigger so this label-only
-- change cannot enqueue or reschedule employee email.
alter table private.employee_directory_details
  disable trigger employee_directory_details_sync_employee_check_in_manager_email;

with changed as (
  update private.employee_directory_details
  set team_name = 'Operation & Accounts'
  where team_name = 'MAM admin'
  returning person_id
)
insert into private.employee_directory_audit_events(person_id, event_type, changed_fields)
select person_id, 'updated', array['team_name']::text[] from changed;

alter table private.employee_directory_details
  enable trigger employee_directory_details_sync_employee_check_in_manager_email;

alter table private.employee_directory_details
  add constraint employee_directory_details_canonical_team
  check (team_name is null or team_name in ('Operation & Accounts', 'Management', 'Major', 'Minor', 'Warehouse', 'Equipsy'));

create or replace function private.employee_calendar_peer_ids(p_person_id uuid)
returns table(person_id uuid)
language sql stable security definer set search_path = '' as $$
  with recursive ancestors(origin_id, id, parent_id, node_kind, depth, path) as (
    select employee.id, parent.id, parent.parent_id, parent.node_kind, 1,
      array[employee.id, parent.id]::uuid[]
    from public.internal_org_people employee
    join public.internal_org_people parent on parent.id = employee.parent_id
    where employee.is_active and employee.node_kind = 'person'
      and parent.is_active and parent.company_key = employee.company_key
    union all
    select ancestors.origin_id, parent.id, parent.parent_id, parent.node_kind,
      ancestors.depth + 1, ancestors.path || parent.id
    from ancestors
    join public.internal_org_people parent on parent.id = ancestors.parent_id
    join public.internal_org_people employee on employee.id = ancestors.origin_id
    where parent.is_active and parent.company_key = employee.company_key
      and not parent.id = any(ancestors.path)
  ), nearest as (
    select distinct on (ancestors.origin_id) ancestors.origin_id, ancestors.id as manager_id
    from ancestors
    join public.internal_org_people manager on manager.id = ancestors.id
    join public.profiles manager_profile on manager_profile.id = manager.auth_user_id
    where ancestors.node_kind = 'person'
      and manager_profile.app_role = 'manager'
      and manager_profile.account_status = 'active' and manager_profile.login_name is not null
      and private.is_active_portal_account(manager_profile.id)
    order by ancestors.origin_id, ancestors.depth
  )
  select peer.id
  from public.internal_org_people actor
  join public.profiles actor_profile on actor_profile.id = actor.auth_user_id
  join nearest actor_manager on actor_manager.origin_id = actor.id
  join nearest peer_manager on peer_manager.manager_id = actor_manager.manager_id
  join public.internal_org_people peer on peer.id = peer_manager.origin_id
  join public.profiles peer_profile on peer_profile.id = peer.auth_user_id
  where actor.id = p_person_id and actor.is_active and actor.node_kind = 'person'
    and actor_profile.account_status = 'active' and actor_profile.login_name is not null
    and private.is_active_portal_account(actor_profile.id)
    and peer.is_active and peer.node_kind = 'person'
    and peer.company_key = actor.company_key and peer.id <> actor.id
    and peer_profile.account_status = 'active' and peer_profile.login_name is not null
    and private.is_active_portal_account(peer_profile.id);
$$;

revoke all on function private.employee_calendar_peer_ids(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.manager_calendar_team_ids(p_person_id uuid)
returns table(person_id uuid)
language sql stable security definer set search_path = '' as $$
  with recursive team(id) as (
    select person.id
    from public.internal_org_people person
    join public.profiles profile on profile.id = person.auth_user_id
    where person.id = p_person_id and person.node_kind = 'person'
      and person.is_active and profile.app_role = 'manager'
      and profile.account_status = 'active' and profile.login_name is not null
      and private.is_active_portal_account(profile.id)
    union
    select child.id from team
    join public.internal_org_people child on child.parent_id = team.id
    where child.is_active
  )
  select person.id from team
  join public.internal_org_people person on person.id = team.id
  where person.node_kind = 'person' and person.id <> p_person_id;
$$;

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
  v_peer_ids uuid[] := array(select peer.person_id from private.employee_calendar_peer_ids(v_actor_person_id) peer);

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
    where (v_can_view_all_approved or (v_is_manager and employee.is_active)
      or request.employee_person_id = any(v_peer_ids))
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
  v_peer_ids uuid[];
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

  v_peer_ids := array(select peer.person_id from private.employee_calendar_peer_ids(p_person_id) peer);
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
    where (v_can_view_all_approved or (v_is_manager and employee.is_active)
      or request.employee_person_id = any(v_peer_ids))
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

commit;
