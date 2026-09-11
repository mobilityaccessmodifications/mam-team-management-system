begin;

-- This migration originally shared version 20260824150000 with the preceding
-- directory filter. Supabase records one migration per version, so keep this
-- change on its own version while preserving its original ordering.

-- Leave approval assignments and notification recipients are different
-- concerns. Approval grants may nominate a global reviewer, but the email
-- for a newly submitted request must go to the employee's nearest active
-- reporting manager. Resolve that manager from the canonical org tree and
-- use the HR-maintained work email, never the portal login alias.
create or replace function public.resolve_leave_notification_manager(
  p_request_id uuid
)
returns table (
  manager_user_id uuid,
  manager_name text,
  manager_email text
)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive request_employee as (
    select employee.id, employee.parent_id
    from public.leave_requests request
    join public.internal_org_people employee
      on employee.auth_user_id = request.user_id
      and employee.node_kind = 'person'
      and employee.is_active
    where request.id = p_request_id
  ), ancestors as (
    select
      parent.id,
      parent.parent_id,
      parent.node_kind,
      parent.full_name,
      parent.auth_user_id,
      parent.is_active,
      1::integer as depth
    from public.internal_org_people parent
    join request_employee employee on employee.parent_id = parent.id

    union all

    select
      parent.id,
      parent.parent_id,
      parent.node_kind,
      parent.full_name,
      parent.auth_user_id,
      parent.is_active,
      ancestors.depth + 1
    from public.internal_org_people parent
    join ancestors on ancestors.parent_id = parent.id
  ), manager as (
    select ancestor.*
    from ancestors ancestor
    where ancestor.node_kind = 'person'
      and ancestor.is_active
      and ancestor.auth_user_id is not null
    order by ancestor.depth
    limit 1
  )
  select
    manager.auth_user_id,
    manager.full_name,
    lower(nullif(btrim(detail.work_email), ''))
  from manager
  left join private.employee_directory_details detail
    on detail.person_id = manager.id;
$$;

comment on function public.resolve_leave_notification_manager(uuid) is
  'Service-role-only resolver for new leave notification delivery. Returns the nearest active reporting manager and HR-recorded work email; approval reviewer grants remain a separate snapshot.';

revoke all on function public.resolve_leave_notification_manager(uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_leave_notification_manager(uuid)
  to service_role;

commit;
