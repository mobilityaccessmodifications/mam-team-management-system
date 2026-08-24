begin;

-- Employee decision notices use the HR-maintained work email, not a browser
-- supplied address or a portal login alias. This resolver is service-role-only
-- because the email is sent to n8n and must never enter the normal DTOs.
create or replace function public.resolve_leave_notification_employee(
  p_request_id uuid
)
returns table (employee_email text)
language sql
stable
security definer
set search_path = ''
as $$
  select lower(nullif(btrim(detail.work_email), ''))
  from public.leave_requests request
  join public.internal_org_people employee
    on employee.auth_user_id = request.user_id
    and employee.node_kind = 'person'
    and employee.is_active
  left join private.employee_directory_details detail
    on detail.person_id = employee.id
  where request.id = p_request_id
  limit 1;
$$;

comment on function public.resolve_leave_notification_employee(uuid) is
  'Service-role-only resolver for leave decision delivery. Returns the requesting employee HR work email and never exposes it to the browser.';

revoke all on function public.resolve_leave_notification_employee(uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_leave_notification_employee(uuid)
  to service_role;

commit;
