begin;

do $$
begin
  if to_regprocedure('private.is_active_linked_internal_employee(uuid)') is null
    or to_regprocedure('private.has_configured_global_employee_check_in_access(uuid)') is null
    or to_regclass('private.employee_check_in_reminders') is null then
    raise exception 'Profile-scoped Check-in Calendar prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Change profile is a testing projection, not impersonation. Only the
-- configured `admin` Super Admin login may request it, and the selected active
-- employee's real manager/global scope determines which Check-ins are shown.
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
  if not exists (
    select 1
    from public.profiles profile
    where profile.id = (select auth.uid())
      and profile.login_name = 'admin'
      and profile.app_role = 'system_admin'
      and profile.account_status = 'active'
  ) then
    raise exception 'Only the configured Super Admin may preview Check-in Calendar scope.' using errcode = '42501';
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
  'Configured Super Admin-only Change profile projection of the selected employee’s actual Check-in Calendar scope.';

revoke all on function public.list_employee_check_in_calendar_entries_for_preview(uuid)
  from public, anon, authenticated;
grant execute on function public.list_employee_check_in_calendar_entries_for_preview(uuid)
  to authenticated, service_role;

commit;
