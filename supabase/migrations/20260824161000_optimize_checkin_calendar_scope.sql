begin;

do $$
begin
  if to_regprocedure('private.has_employee_check_in_workspace_access()') is null
    or to_regprocedure('private.has_global_employee_check_in_scope()') is null
    or to_regprocedure('private.list_visible_employee_check_in_person_ids()') is null
    or to_regclass('private.employee_check_in_reminders') is null then
    raise exception 'Check-in Calendar scope optimisation prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Resolve the current caller's authorised employee scope once, then join the
-- matching reminders. This preserves the manager/global visibility rule while
-- avoiding a full organisation traversal for every calendar reminder.
create or replace function public.list_employee_check_in_calendar_entries()
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
begin
  if not private.has_employee_check_in_workspace_access() then
    return;
  end if;

  return query
  select
    reminder.id,
    person.id,
    person.full_name,
    reminder.milestone,
    reminder.reminder_sequence,
    reminder.due_date,
    reminder.delivery_status
  from private.list_visible_employee_check_in_person_ids() visible_person
  join public.internal_org_people person on person.id = visible_person.person_id
  join private.employee_check_in_reminders reminder on reminder.person_id = person.id
  where person.node_kind = 'person'
    and person.is_active
    and reminder.reminder_sequence = 'initial'
    and reminder.delivery_status not in ('superseded', 'cancelled')
    and (
      private.has_global_employee_check_in_scope()
      or reminder.delivery_status <> 'completed'
    )
  order by
    reminder.due_date,
    lower(person.full_name),
    reminder.milestone,
    reminder.reminder_sequence;
end;
$$;

comment on function public.list_employee_check_in_calendar_entries() is
  'Returns Check-in calendar entries from the caller’s precomputed global or manager-only scope.';

revoke all on function public.list_employee_check_in_calendar_entries() from public, anon, authenticated;
grant execute on function public.list_employee_check_in_calendar_entries() to authenticated;

commit;
