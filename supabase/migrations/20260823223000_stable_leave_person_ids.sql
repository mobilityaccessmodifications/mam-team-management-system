begin;

do $$
begin
  if to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regprocedure('private.can_review_leave_request(uuid)') is null
    or to_regclass('public.leave_requests') is null
    or to_regclass('public.internal_org_people') is null then
    raise exception 'Stable leave projection prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Display names are not identities. Both private leave projections now carry
-- the immutable directory person ID resolved from the request owner's auth
-- account, preventing two employees with the same name from sharing a Change
-- Profile view, "My leave" list, or calendar exclusion rule.
drop function public.list_leave_workspace_requests();

create function public.list_leave_workspace_requests()
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
  approval_required boolean,
  status text,
  submitted_at timestamptz,
  assigned_reviewer_label text,
  can_decide boolean,
  can_cancel boolean,
  can_attach boolean,
  employee_note text,
  manager_note text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_is_hr boolean := private.is_internal_org_hr();
  v_actor_is_system_admin boolean := private.is_system_portal_account_admin();
  v_actor_person_id uuid := private.current_active_portal_employee_id();
  v_melbourne_today date := (current_timestamp at time zone 'Australia/Melbourne')::date;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account() then
    raise exception 'An active portal account is required to view leave.'
      using errcode = '42501';
  end if;

  if not v_actor_is_hr and v_actor_person_id is null then
    raise exception 'An active linked employee account is required to view leave.'
      using errcode = '42501';
  end if;

  return query
  select
    request.id,
    employee.id,
    coalesce(employee.full_name, profile.full_name),
    coalesce(employee.company_key, 'mam'),
    request.request_type_label,
    request.start_date,
    request.end_date,
    request.start_time,
    request.end_time,
    request.business_days,
    request.hours,
    request.approval_required,
    case request.status
      when 'approved' then 'Approved'
      when 'rejected' then 'Declined'
      when 'cancelled' then 'Cancelled'
      else 'Pending'
    end,
    request.submitted_at,
    coalesce(primary_assignment.reviewer_label, request.manager_name_snapshot),
    (
      request.user_id is distinct from v_actor_user_id
      and request.approval_required
      and request.status = 'submitted'
      and private.can_review_leave_request(request.id)
    ),
    (
      (request.user_id = v_actor_user_id or v_actor_is_system_admin)
      and (v_actor_person_id is not null or v_actor_is_system_admin)
      and request.status = 'approved'
      and request.start_date > v_melbourne_today
    ),
    (
      (request.user_id = v_actor_user_id or v_actor_is_system_admin)
      and (v_actor_person_id is not null or v_actor_is_system_admin)
      and request.status in ('submitted', 'approved')
    ),
    request.reason,
    request.manager_note
  from public.leave_requests request
  join public.profiles profile
    on profile.id = request.user_id
  left join lateral (
    select person.id, person.full_name, person.company_key
    from public.internal_org_people person
    where person.auth_user_id = request.user_id
      and person.node_kind = 'person'
    order by person.is_active desc, person.updated_at desc, person.id
    limit 1
  ) employee on true
  left join lateral (
    select assignment.reviewer_label
    from private.leave_request_reviewer_assignments assignment
    where assignment.leave_request_id = request.id
      and assignment.is_primary
    limit 1
  ) primary_assignment on true
  where request.status in ('submitted', 'approved', 'rejected', 'changes_requested', 'cancelled')
    and (
      request.user_id = v_actor_user_id
      or private.can_review_leave_request(request.id)
    )
  order by request.start_date desc, request.created_at desc, request.id;
end;
$$;

comment on function public.list_leave_workspace_requests() is
  'Returns private leave details with a stable directory person ID and server-derived decision, cancellation and attachment controls. A real System Admin retains these functions in Change Profile.';

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
  v_actor_is_hr boolean := private.is_internal_org_hr();
  v_actor_person_id uuid;
  v_actor_company_key text;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account() then
    raise exception 'An active portal account is required to view the calendar.'
      using errcode = '42501';
  end if;

  if not v_actor_is_hr then
    v_actor_person_id := private.current_active_portal_employee_id();
    if v_actor_person_id is null then
      raise exception 'An active linked employee account is required to view the calendar.'
        using errcode = '42501';
    end if;

    select person.company_key
      into v_actor_company_key
    from public.internal_org_people person
    where person.id = v_actor_person_id
      and person.auth_user_id = v_actor_user_id
      and person.node_kind = 'person'
      and person.is_active;

    if v_actor_company_key is null then
      raise exception 'An active linked employee account is required to view the calendar.'
        using errcode = '42501';
    end if;
  end if;

  return query
  select
    request.id,
    employee.id,
    coalesce(employee.full_name, profile.full_name),
    coalesce(employee.company_key, 'mam'),
    case
      when v_actor_is_hr
        or request.user_id = v_actor_user_id
        or private.can_review_leave_request(request.id)
        then request.request_type_label
      else 'Away'
    end,
    request.start_date,
    request.end_date,
    request.start_time,
    request.end_time,
    request.business_days,
    request.hours,
    case request.status
      when 'approved' then 'Approved'
      else 'Pending'
    end
  from public.leave_requests request
  join public.profiles profile
    on profile.id = request.user_id
  left join lateral (
    select person.id, person.full_name, person.company_key
    from public.internal_org_people person
    where person.auth_user_id = request.user_id
      and person.node_kind = 'person'
      and person.is_active
    order by person.updated_at desc, person.id
    limit 1
  ) employee on true
  where request.status in ('submitted', 'approved')
    and (v_actor_is_hr or employee.company_key = v_actor_company_key)
  order by request.start_date, request.created_at, request.id;
end;
$$;

comment on function public.list_leave_calendar_entries() is
  'Returns an availability-only company calendar with a stable directory person ID. Current HR and request reviewers see authorised leave types; peers receive Away only.';

revoke all on function public.list_leave_workspace_requests()
  from public, anon, authenticated;
revoke all on function public.list_leave_calendar_entries()
  from public, anon, authenticated;

grant execute on function public.list_leave_workspace_requests()
  to authenticated;
grant execute on function public.list_leave_calendar_entries()
  to authenticated;

commit;
