begin;

-- Leave submission notifications follow the approval role boundary rather than
-- blindly emailing the nearest reporting-line node. Walk upward until the
-- first active manager/admin account is found, skipping employee-role nodes.
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
    join public.profiles profile
      on profile.id = ancestor.auth_user_id
      and profile.account_status = 'active'
      and profile.app_role in ('manager', 'system_admin')
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
  'Service-role-only resolver for new leave notifications. Walks upward to the first active manager/admin account and returns its HR-recorded work email; employee-role nodes are skipped.';

revoke all on function public.resolve_leave_notification_manager(uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_leave_notification_manager(uuid)
  to service_role;

-- Keep the Auth claim used by RLS and server-side capability checks aligned
-- with the database-controlled profile role. Preserve other app metadata.
create or replace function private.sync_profile_auth_org_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update auth.users member
  set raw_app_meta_data = jsonb_set(
    coalesce(member.raw_app_meta_data, '{}'::jsonb),
    '{org_role}',
    to_jsonb(new.app_role),
    true
  )
  where member.id = new.id
    and member.raw_app_meta_data ->> 'org_role' is distinct from new.app_role;

  return new;
end;
$$;

comment on function private.sync_profile_auth_org_role() is
  'Keeps the controlled Auth org_role claim equal to public.profiles.app_role. User-editable metadata is never consulted.';

revoke all on function private.sync_profile_auth_org_role() from public, anon, authenticated;

drop trigger if exists profiles_sync_auth_org_role on public.profiles;
create trigger profiles_sync_auth_org_role
after insert or update of app_role on public.profiles
for each row execute function private.sync_profile_auth_org_role();

-- Repair existing accounts once, then let the trigger maintain the invariant.
update auth.users member
set raw_app_meta_data = jsonb_set(
  coalesce(member.raw_app_meta_data, '{}'::jsonb),
  '{org_role}',
  to_jsonb(profile.app_role),
  true
)
from public.profiles profile
where profile.id = member.id
  and profile.app_role is not null
  and member.raw_app_meta_data ->> 'org_role' is distinct from profile.app_role;

commit;
