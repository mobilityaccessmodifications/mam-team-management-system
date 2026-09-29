begin;

-- A grant to inspect all leave requests and their existing evidence does not
-- confer reviewer, balance, upload, delete, cancellation or HR capability.
create table private.leave_register_read_grants (
  person_id uuid primary key references public.internal_org_people(id) on delete cascade,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp()
);
alter table private.leave_register_read_grants enable row level security;
revoke all on table private.leave_register_read_grants from public, anon, authenticated, service_role;

create function private.has_leave_register_read_grant(p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_actor is not null
    and private.is_active_portal_account(p_actor)
    and exists (
      select 1
      from private.leave_register_read_grants access_grant
      join public.internal_org_people person on person.id = access_grant.person_id
      join public.profiles profile on profile.id = person.auth_user_id
      where person.auth_user_id = p_actor
        and person.node_kind = 'person'
        and person.is_active
        and profile.account_status = 'active'
        and profile.login_name is not null
    );
$$;
revoke all on function private.has_leave_register_read_grant(uuid) from public, anon, authenticated, service_role;

create function public.can_view_all_leave_requests()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and private.has_leave_register_read_grant((select auth.uid()));
$$;
revoke all on function public.can_view_all_leave_requests() from public, anon, authenticated, service_role;
grant execute on function public.can_view_all_leave_requests() to authenticated;

create or replace function private.can_view_leave_request_attachment(p_attachment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_attachment_id is not null
    and (select auth.uid()) is not null
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and private.has_current_portal_access()
    and exists (
      select 1
      from public.leave_request_attachments attachment
      join public.leave_requests request on request.id = attachment.leave_request_id
      where attachment.id = p_attachment_id
        and (
          (
            request.user_id = (select auth.uid())
            and private.current_active_portal_employee_id() is not null
          )
          or private.can_review_leave_request(request.id)
          or private.has_leave_register_read_grant((select auth.uid()))
        )
    );
$$;
comment on function private.can_view_leave_request_attachment(uuid) is
  'Owner, current reviewer or explicitly granted active read-only Leave register viewer may inspect evidence; upload and deletion remain separately authorised.';
revoke all on function private.can_view_leave_request_attachment(uuid) from public, anon, authenticated, service_role;

create or replace function public.list_leave_workspace_requests()
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
  v_actor_can_read_all boolean := private.has_leave_register_read_grant((select auth.uid()));
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
    coalesce(employee.full_name, profile.full_name, 'Employee'),
    employee.company_key,
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
      request.user_id is not null
      and (request.user_id = v_actor_user_id or v_actor_is_system_admin)
      and (v_actor_person_id is not null or v_actor_is_system_admin)
      and request.status <> 'cancelled'
    ),
    (
      request.user_id is not null
      and (request.user_id = v_actor_user_id or v_actor_is_system_admin)
      and (v_actor_person_id is not null or v_actor_is_system_admin)
      and request.status in ('submitted', 'approved')
    ),
    request.reason,
    request.manager_note
  from public.leave_requests request
  join public.internal_org_people employee
    on employee.id = request.employee_person_id
   and employee.node_kind = 'person'
  left join public.profiles profile
    on profile.id = request.user_id
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
      or request.employee_person_id = v_actor_person_id
      or private.can_review_leave_request(request.id)
      or v_actor_can_read_all
    )
  order by request.start_date desc, request.created_at desc, request.id;
end;
$$;
comment on function public.list_leave_workspace_requests() is
  'Returns all leave requests only to current reviewers or explicit read-only viewers; per-row action flags remain independent.';
revoke all on function public.list_leave_workspace_requests() from public, anon, authenticated, service_role;
grant execute on function public.list_leave_workspace_requests() to authenticated;

commit;
