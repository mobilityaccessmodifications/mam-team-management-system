begin;

create or replace function public.get_leave_workspace_for_preview(p_person_id uuid)
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
  v_target_can_read_all boolean;
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
  v_target_can_read_all := private.has_leave_register_read_grant(v_target_user_id);
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
      request.id,
      request.employee_person_id,
      request.user_id,
      request.request_type_label,
      request.start_date,
      request.end_date,
      request.start_time,
      request.end_time,
      request.business_days,
      request.hours,
      request.approval_required,
      request.status,
      request.submitted_at,
      request.manager_name_snapshot,
      request.reason,
      request.manager_note,
      request.created_at,
      coalesce(employee.full_name, profile.full_name, 'Employee') as employee_name,
      coalesce(employee.company_key, 'mam') as employee_company_key,
      coalesce(primary_assignment.reviewer_label, request.manager_name_snapshot) as assigned_reviewer_label,
      (
        v_target_is_system_admin
        or private.is_current_leave_request_reviewer(request.id, v_target_user_id)
      ) as target_can_review
    from public.leave_requests request
    join public.internal_org_people employee
      on employee.id = request.employee_person_id
     and employee.node_kind = 'person'
    left join public.profiles profile on profile.id = request.user_id
    left join lateral (
      select assignment.reviewer_label
      from private.leave_request_reviewer_assignments assignment
      where assignment.leave_request_id = request.id
        and assignment.is_primary
      limit 1
    ) primary_assignment on true
    where request.status in ('submitted', 'approved', 'rejected', 'changes_requested', 'cancelled')
      and (
        request.employee_person_id = p_person_id
        or request.user_id = v_target_user_id
        or v_target_is_system_admin
        or private.is_current_leave_request_reviewer(request.id, v_target_user_id)
        or v_target_can_read_all
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
          'can_decide', request.employee_person_id is distinct from p_person_id
            and request.approval_required
            and request.status = 'submitted'
            and request.target_can_review,
          'can_cancel', (request.employee_person_id = p_person_id or v_target_is_system_admin)
            and request.status <> 'cancelled',
          'can_attach', (request.employee_person_id = p_person_id or v_target_is_system_admin)
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
    'can_view_all_leave', v_target_can_read_all,
    'is_truncated', (select count(*) > 1000 from visible_requests)
  )
  into v_workspace
  from request_projection
  cross join attachment_projection;

  return coalesce(v_workspace, jsonb_build_object(
    'requests', '[]'::jsonb,
    'attachments', '[]'::jsonb,
    'can_review_leave', v_target_can_review_workspace,
    'can_view_all_leave', v_target_can_read_all,
    'is_truncated', false
  ));
end;
$$;

comment on function public.get_leave_workspace_for_preview(uuid) is
  'Returns the selected active account''s leave visibility to System Admin, including an independent read-only all-staff grant without approval authority.';
revoke all on function public.get_leave_workspace_for_preview(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_leave_workspace_for_preview(uuid) to authenticated;

commit;
