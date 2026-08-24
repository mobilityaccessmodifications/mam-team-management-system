begin;

do $$
begin
  if to_regclass('public.profiles') is null
    or to_regclass('private.employee_check_in_access_grants') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regprocedure('private.is_active_linked_internal_employee(uuid)') is null then
    raise exception 'System Admin global-access prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- `system_admin` is the controlled, all-module administrator role.  Do not
-- key global Check-in scope to one login name: every active System Admin has
-- the same global Check-in Calendar and task capability.  Explicit grants
-- remain available for non-admin global reviewers.
create or replace function private.has_configured_global_employee_check_in_access(
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id is not null
    and (
      exists (
        select 1
        from public.profiles profile
        where profile.id = p_user_id
          and profile.app_role = 'system_admin'
          and profile.account_status = 'active'
          and profile.login_name is not null
      )
      or (
        private.is_active_linked_internal_employee(p_user_id)
        and exists (
          select 1
          from private.employee_check_in_access_grants access_grant
          where access_grant.reviewer_user_id = p_user_id
            and access_grant.scope_kind = 'global'
            and access_grant.revoked_at is null
        )
      )
    );
$$;

comment on function private.has_configured_global_employee_check_in_access(uuid) is
  'Checks whether a supplied active System Admin or explicitly granted reviewer has global Check-in scope.';

-- Change profile is a System Admin capability.  The selected employee is only
-- a display scope; all authorisation remains with the signed-in System Admin.
create or replace function public.list_employee_check_in_calendar_entries_for_preview(
  p_person_id uuid
)
returns table (
  reminder_id uuid,
  person_id uuid,
  employee_name text,
  milestone text,
  sequence text,
  due_date date,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_target_auth_user_id uuid;
  v_target_can_access boolean := false;
  v_target_is_global boolean := false;
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only a System Admin may preview Check-in Calendar scope.' using errcode = '42501';
  end if;

  select person.auth_user_id
    into v_target_auth_user_id
  from public.internal_org_people person
  where person.id = p_person_id
    and person.node_kind = 'person'
    and person.is_active;

  if not found or v_target_auth_user_id is null then
    raise exception 'The selected employee is unavailable.' using errcode = '23503';
  end if;

  select private.is_active_linked_internal_employee(v_target_auth_user_id),
         private.has_configured_global_employee_check_in_access(v_target_auth_user_id)
    into v_target_can_access, v_target_is_global;

  return query
  with recursive descendants as (
    select person.id, person.parent_id, 0::integer as depth
    from public.internal_org_people person
    where person.id = p_person_id
      and person.node_kind = 'person'
      and person.is_active

    union all

    select child.id, child.parent_id, descendants.depth + 1
    from public.internal_org_people child
    join descendants on child.parent_id = descendants.id
    where child.is_active
  )
  select
    reminder.id,
    person.id,
    person.full_name,
    reminder.milestone,
    reminder.reminder_sequence,
    reminder.due_date,
    reminder.delivery_status
  from public.internal_org_people person
  join private.employee_check_in_reminders reminder on reminder.person_id = person.id
  where v_target_can_access
    and person.node_kind = 'person'
    and person.is_active
    and reminder.reminder_sequence = 'initial'
    and reminder.delivery_status not in ('superseded', 'cancelled')
    and (
      v_target_is_global
      or exists (
        select 1
        from descendants
        where descendants.id = person.id
          and descendants.depth > 0
      )
    )
    and (
      v_target_is_global
      or reminder.delivery_status <> 'completed'
    )
  order by
    reminder.due_date,
    lower(person.full_name),
    reminder.milestone,
    reminder.reminder_sequence;
end;
$$;

comment on function public.list_employee_check_in_calendar_entries_for_preview(uuid) is
  'System Admin-only Change profile projection of the selected employee’s actual Check-in Calendar scope.';

revoke all on function private.has_configured_global_employee_check_in_access(uuid)
  from public, anon, authenticated;
revoke all on function public.list_employee_check_in_calendar_entries_for_preview(uuid)
  from public, anon, authenticated;
grant execute on function public.list_employee_check_in_calendar_entries_for_preview(uuid)
  to authenticated, service_role;

commit;
