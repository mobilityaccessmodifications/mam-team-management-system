begin;

-- A cancellation is a state transition, not a deletion. The original
-- approval fields and their existing event stay intact; the employee's
-- cancellation is recorded as an additional immutable event.
create function public.cancel_my_approved_leave_request(
  p_request_id uuid
)
returns table (
  id uuid,
  status text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_actor_is_system_admin boolean := private.is_portal_account_admin()
    and exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.app_role = 'system_admin'
        and profile.login_name is not null
        and profile.account_status = 'active'
    );
  v_melbourne_today date := (current_timestamp at time zone 'Australia/Melbourne')::date;
  v_request public.leave_requests%rowtype;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account()
    or (
      private.current_active_portal_employee_id() is null
      and not v_actor_is_system_admin
    )
    or p_request_id is null then
    raise exception 'This leave request cannot be cancelled.' using errcode = '42501';
  end if;

  -- Lock before checking eligibility so a concurrent reviewer decision or
  -- repeat cancellation cannot create a second state transition or event.
  select request.*
  into v_request
  from public.leave_requests request
  where request.id = p_request_id
  for update;

  -- Do not disclose whether a supplied ID exists, belongs to another person,
  -- is no longer approved, or has already begun. A dedicated payroll rule can
  -- later add a same-day exception; version one is intentionally future-only.
  if not found
    or (
      v_request.user_id is distinct from v_actor_user_id
      and not v_actor_is_system_admin
    )
    or v_request.status <> 'approved'
    or v_request.start_date <= v_melbourne_today then
    raise exception 'This leave request cannot be cancelled.' using errcode = '42501';
  end if;

  update public.leave_requests request
  set status = 'cancelled',
      updated_at = clock_timestamp()
  where request.id = v_request.id
  returning request.* into v_request;

  insert into public.leave_request_events (
    leave_request_id,
    actor_user_id,
    event_type,
    note
  )
  values (
    v_request.id,
    v_actor_user_id,
    'cancelled',
    case
      when v_request.user_id = v_actor_user_id then 'Cancelled by employee before leave start.'
      else 'Cancelled by System Admin through Change Profile before leave start.'
    end
  );

  return query
  select v_request.id, 'Cancelled';
end;
$$;

comment on function public.cancel_my_approved_leave_request(uuid) is
  'Cancels an authenticated active linked employee''s own approved future leave, or permits a real System Admin to exercise the same function through Change Profile. It preserves the original decision and appends an actor-audited cancellation event.';

-- Add only a server-derived control flag. The browser never decides whether a
-- row belongs to the employee or whether the date/status remains eligible.
drop function public.list_leave_workspace_requests();

create function public.list_leave_workspace_requests()
returns table (
  id uuid,
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
  v_actor_person_id uuid := private.current_active_portal_employee_id();
  v_melbourne_today date := (current_timestamp at time zone 'Australia/Melbourne')::date;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account() then
    raise exception 'An active portal account is required to view leave.'
      using errcode = '42501';
  end if;

  -- HR may retain its existing cross-employee workspace even when the account
  -- is not itself rostered. All other callers must be active linked employees.
  if not v_actor_is_hr and v_actor_person_id is null then
    raise exception 'An active linked employee account is required to view leave.'
      using errcode = '42501';
  end if;

  return query
  select
    request.id,
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
      request.user_id = v_actor_user_id
      and v_actor_person_id is not null
      and request.status = 'approved'
      and request.start_date > v_melbourne_today
    ),
    request.reason,
    request.manager_note
  from public.leave_requests request
  join public.profiles profile
    on profile.id = request.user_id
  left join lateral (
    select person.full_name, person.company_key
    from public.internal_org_people person
    where person.auth_user_id = request.user_id
      and person.node_kind = 'person'
    order by person.is_active desc, person.updated_at desc
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
  'Returns private leave details for the authenticated employee, current explicit request reviewers, or HR. Cancelled requests remain visible for history but are excluded from the availability calendar; can_cancel is derived only in the database.';

revoke all on function public.cancel_my_approved_leave_request(uuid)
  from public, anon, authenticated;
revoke all on function public.list_leave_workspace_requests()
  from public, anon, authenticated;

grant execute on function public.cancel_my_approved_leave_request(uuid)
  to authenticated;
grant execute on function public.list_leave_workspace_requests()
  to authenticated;

commit;
