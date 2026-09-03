begin;

do $$
begin
  if to_regclass('public.leave_requests') is null
    or to_regclass('public.leave_request_events') is null
    or to_regclass('public.leave_request_attachments') is null
    or to_regclass('public.internal_org_people') is null
    or to_regclass('public.profiles') is null
    or to_regclass('private.leave_approval_grants') is null
    or to_regclass('private.leave_request_reviewer_assignments') is null
    or to_regprocedure('private.is_active_portal_account(uuid)') is null
    or to_regprocedure('private.is_internal_org_hr()') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regprocedure('private.current_active_portal_employee_id()') is null
    or to_regprocedure('private.can_review_leave_request(uuid)') is null
    or to_regprocedure('private.is_current_leave_request_reviewer(uuid,uuid)') is null then
    raise exception 'Leave cancellation prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Cancellation is an audited state transition, not a deletion. An employee
-- may cancel any one of their own leave requests until it has already been
-- cancelled; System Admin retains the same capability in Change Profile.
create or replace function public.cancel_my_approved_leave_request(
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
  v_actor_is_system_admin boolean := private.is_system_portal_account_admin();
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

  -- Lock before checking ownership and current state so duplicate clicks or a
  -- concurrent decision cannot append a second cancellation event.
  select request.*
  into v_request
  from public.leave_requests request
  where request.id = p_request_id
  for update;

  if not found
    or (
      v_request.user_id is distinct from v_actor_user_id
      and not v_actor_is_system_admin
    )
    or v_request.status = 'cancelled' then
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
      when v_request.user_id = v_actor_user_id then 'Cancelled by employee.'
      else 'Cancelled by System Admin through Change Profile.'
    end
  );

  return query
  select v_request.id, 'Cancelled';
end;
$$;

comment on function public.cancel_my_approved_leave_request(uuid) is
  'Cancels an authenticated active linked employee''s own non-cancelled leave, or permits a real System Admin to cancel through Change Profile. The original request and decision history are preserved and an audited cancellation event is appended.';

create or replace function public.cancel_selected_employee_approved_leave_request(
  p_person_id uuid,
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
  v_target_user_id uuid;
  v_request public.leave_requests%rowtype;
begin
  if v_actor_user_id is null
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
    or not private.is_active_portal_account()
    or not private.is_system_portal_account_admin()
    or p_person_id is null
    or p_request_id is null then
    raise exception 'This leave request cannot be cancelled.' using errcode = '42501';
  end if;

  select person.auth_user_id
    into v_target_user_id
  from public.internal_org_people person
  join public.profiles target_profile
    on target_profile.id = person.auth_user_id
   and target_profile.account_status = 'active'
   and target_profile.login_name is not null
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active = true
    and person.auth_user_id is not null;

  -- Keep the response deliberately indistinguishable for missing, inactive or
  -- unlinked profiles. The browser never supplies an Auth user ID.
  if v_target_user_id is null then
    raise exception 'This leave request cannot be cancelled.' using errcode = '42501';
  end if;

  select request.*
    into v_request
  from public.leave_requests request
  where request.id = p_request_id
  for update;

  if not found
    or v_request.user_id is distinct from v_target_user_id
    or v_request.status = 'cancelled' then
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
    'Cancelled by System Admin through Change Profile.'
  );

  return query
  select v_request.id, 'Cancelled';
end;
$$;

comment on function public.cancel_selected_employee_approved_leave_request(uuid, uuid) is
  'Cancels a selected active employee''s non-cancelled leave from System Admin Change Profile. The target is resolved from the active organisation link and the real System Admin is recorded as the audit actor.';

-- The existing function predates the stable person_id return column. PostgreSQL
-- does not permit CREATE OR REPLACE to change an OUT row type, so replace only
-- this function (without CASCADE) inside the transaction before recreating it.
drop function public.list_leave_workspace_requests();

-- The active workspace projection supplies the client with a server-derived
-- capability, so an employee never receives a control for another employee's
-- request even when they can review it.
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
      and request.status <> 'cancelled'
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
  'Returns private leave details with stable person IDs and server-derived decision, cancellation and attachment controls. Employees may cancel their own non-cancelled leave; a real System Admin retains this ability in Change Profile.';

-- Change Profile is a System-Admin-only view of the selected employee's real
-- leave authority. Keep its cancellation flag aligned with the active
-- workspace projection above.
create or replace function public.get_leave_workspace_for_preview(
  p_person_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_target_user_id uuid;
  v_target_role text;
  v_target_is_system_admin boolean;
  v_target_can_review_workspace boolean;
  v_workspace jsonb;
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only the active System Admin may preview another employee leave workspace.'
      using errcode = '42501';
  end if;

  select person.auth_user_id, profile.app_role
  into v_target_user_id, v_target_role
  from public.internal_org_people person
  join public.profiles profile on profile.id = person.auth_user_id
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active
    and person.auth_user_id is not null
    and profile.account_status = 'active'
    and profile.login_name is not null
    and private.is_active_portal_account(profile.id)
  limit 1;

  if not found then
    raise exception 'The selected employee does not have an active linked portal account.'
      using errcode = '42501';
  end if;

  v_target_is_system_admin := v_target_role = 'system_admin';
  v_target_can_review_workspace := v_target_is_system_admin
    or v_target_role = 'manager'
    or exists (
      select 1
      from private.leave_approval_grants approval_grant
      where approval_grant.reviewer_user_id = v_target_user_id
        and approval_grant.revoked_at is null
        and (
          approval_grant.scope_kind = 'global'
          or v_target_role = 'manager'
        )
    )
    or exists (
      select 1
      from private.leave_request_reviewer_assignments assignment
      where private.is_current_leave_request_reviewer(
        assignment.leave_request_id,
        v_target_user_id
      )
    );

  with visible_requests as materialized (
    select
      request.*,
      employee.id as employee_person_id,
      coalesce(employee.full_name, profile.full_name, 'Employee') as employee_name,
      coalesce(employee.company_key, 'mam') as employee_company_key,
      coalesce(primary_assignment.reviewer_label, request.manager_name_snapshot) as assigned_reviewer_label,
      (
        v_target_is_system_admin
        or private.is_current_leave_request_reviewer(request.id, v_target_user_id)
      ) as target_can_review
    from public.leave_requests request
    join public.profiles profile on profile.id = request.user_id
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
        request.user_id = v_target_user_id
        or v_target_is_system_admin
        or private.is_current_leave_request_reviewer(request.id, v_target_user_id)
      )
    order by request.start_date desc, request.created_at desc, request.id
    limit 1001
  ), bounded_requests as materialized (
    select request.*
    from visible_requests request
    order by request.start_date desc, request.created_at desc, request.id
    limit 1000
  ), request_projection as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', request.id,
          'person_id', request.employee_person_id,
          'employee_name', request.employee_name,
          'company_key', request.employee_company_key,
          'leave_type_label', request.request_type_label,
          'start_date', request.start_date,
          'end_date', request.end_date,
          'start_time', request.start_time,
          'end_time', request.end_time,
          'business_days', request.business_days,
          'hours', request.hours,
          'approval_required', request.approval_required,
          'status', case request.status
            when 'approved' then 'Approved'
            when 'rejected' then 'Declined'
            when 'cancelled' then 'Cancelled'
            else 'Pending'
          end,
          'submitted_at', request.submitted_at,
          'assigned_reviewer_label', request.assigned_reviewer_label,
          'can_decide', request.user_id is distinct from v_target_user_id
            and request.approval_required
            and request.status = 'submitted'
            and request.target_can_review,
          'can_cancel', (request.user_id = v_target_user_id or v_target_is_system_admin)
            and request.status <> 'cancelled',
          'can_attach', (request.user_id = v_target_user_id or v_target_is_system_admin)
            and request.status in ('submitted', 'approved'),
          'employee_note', request.reason,
          'manager_note', request.manager_note
        )
        order by request.start_date desc, request.created_at desc, request.id
      ),
      '[]'::jsonb
    ) as value
    from bounded_requests request
  ), attachment_projection as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', attachment.id,
          'leave_request_id', attachment.leave_request_id,
          'file_name', attachment.file_name,
          'mime_type', attachment.mime_type,
          'size_bytes', attachment.size_bytes,
          'created_at', attachment.created_at
        )
        order by attachment.created_at, attachment.id
      ),
      '[]'::jsonb
    ) as value
    from public.leave_request_attachments attachment
    join bounded_requests request on request.id = attachment.leave_request_id
  )
  select jsonb_build_object(
    'requests', request_projection.value,
    'attachments', attachment_projection.value,
    'can_review_leave', v_target_can_review_workspace,
    'is_truncated', (select count(*) > 1000 from visible_requests)
  )
  into v_workspace
  from request_projection
  cross join attachment_projection;

  return coalesce(v_workspace, jsonb_build_object(
    'requests', '[]'::jsonb,
    'attachments', '[]'::jsonb,
    'can_review_leave', v_target_can_review_workspace,
    'is_truncated', false
  ));
end;
$$;

comment on function public.get_leave_workspace_for_preview(uuid) is
  'Returns one System-Admin-only JSON projection of the selected active account''s real leave visibility, reviewer snapshot authority, cancellation eligibility and safe attachment metadata, bounded to 1,000 recent requests with an explicit truncation marker.';

revoke all on function public.cancel_my_approved_leave_request(uuid) from public, anon, authenticated;
revoke all on function public.cancel_selected_employee_approved_leave_request(uuid, uuid) from public, anon, authenticated;
revoke all on function public.list_leave_workspace_requests() from public, anon, authenticated;
revoke all on function public.get_leave_workspace_for_preview(uuid) from public, anon, authenticated;

grant execute on function public.cancel_my_approved_leave_request(uuid) to authenticated;
grant execute on function public.cancel_selected_employee_approved_leave_request(uuid, uuid) to authenticated;
grant execute on function public.list_leave_workspace_requests() to authenticated;
grant execute on function public.get_leave_workspace_for_preview(uuid) to authenticated;

commit;
