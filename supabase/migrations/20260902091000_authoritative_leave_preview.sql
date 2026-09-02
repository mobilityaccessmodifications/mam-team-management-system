begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:authoritative-leave-preview:20260902', 0)
  );

  if to_regclass('public.leave_requests') is null
    or to_regclass('public.leave_request_attachments') is null
    or to_regclass('public.internal_org_people') is null
    or to_regclass('public.profiles') is null
    or to_regclass('private.leave_approval_grants') is null
    or to_regclass('private.leave_request_reviewer_assignments') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regprocedure('private.is_active_portal_account(uuid)') is null
    or to_regprocedure('private.is_current_leave_request_reviewer(uuid,uuid)') is null then
    raise exception 'Authoritative leave preview prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Change profile is a read-only projection of the selected account's real
-- database authority. One JSON value avoids PostgREST's row cap while keeping
-- filtering, reviewer snapshots, cancellation dates and private-note scope in
-- PostgreSQL rather than reimplementing those rules in TypeScript.
create function public.get_leave_workspace_for_preview(
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
  v_melbourne_today date := (current_timestamp at time zone 'Australia/Melbourne')::date;
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
            and request.status = 'approved'
            and request.start_date > v_melbourne_today,
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
  'Returns one System-Admin-only JSON projection of the selected active account''s real leave visibility, reviewer snapshot authority, future cancellation eligibility and safe attachment metadata, bounded to 1,000 recent requests with an explicit truncation marker.';

revoke all on function public.get_leave_workspace_for_preview(uuid)
  from public, anon, authenticated;
grant execute on function public.get_leave_workspace_for_preview(uuid)
  to authenticated;

commit;
