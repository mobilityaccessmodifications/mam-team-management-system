begin;

-- Leave decision notices must reach the requesting employee even when HR has
-- recorded only a personal address. Keep both HR-managed addresses server
-- side and return a deduplicated list for the n8n receiver.
create or replace function public.resolve_leave_notification_employee_recipients(
  p_request_id uuid
)
returns table (
  employee_work_email text,
  employee_personal_email text,
  employee_emails text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  with employee_address as (
    select
      lower(nullif(btrim(detail.work_email), '')) as work_email,
      lower(nullif(btrim(detail.personal_email), '')) as personal_email
    from public.leave_requests request
    join public.internal_org_people employee
      on employee.auth_user_id = request.user_id
      and employee.node_kind = 'person'
      and employee.is_active
    left join private.employee_directory_details detail
      on detail.person_id = employee.id
    where request.id = p_request_id
    limit 1
  )
  select
    employee_address.work_email,
    employee_address.personal_email,
    array(
      select distinct address
      from unnest(array[employee_address.work_email, employee_address.personal_email]) as addresses(address)
      where address is not null
        and address ~ '^[^[:space:]@]+@[^[:space:]@]+$'
      order by address
    )
  from employee_address;
$$;

comment on function public.resolve_leave_notification_employee_recipients(uuid) is
  'Service-role-only resolver for leave decision delivery. Returns both HR-recorded employee email addresses and a deduplicated recipient list; never exposes them to the browser.';

revoke all on function public.resolve_leave_notification_employee_recipients(uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_leave_notification_employee_recipients(uuid)
  to service_role;

commit;
