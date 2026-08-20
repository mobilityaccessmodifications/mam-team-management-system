begin;

do $$
begin
  if to_regprocedure('private.has_employee_check_in_workspace_access()') is null
    or to_regprocedure('private.can_view_employee_check_in(uuid)') is null
    or to_regprocedure('public.list_my_employee_check_in_tasks()') is null
    or to_regprocedure('public.list_employee_check_in_tasks_for_preview(uuid)') is null then
    raise exception 'Check-in load optimisation prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- The task view only needs open initial milestones. This partial index avoids
-- walking completed/final reminder rows when a manager opens Tasks.
create index if not exists employee_check_in_reminders_open_initial_person_due_idx
  on private.employee_check_in_reminders (person_id, due_date, id)
  where reminder_sequence = 'initial'
    and delivery_status in ('scheduled', 'claimed', 'delivered', 'needs_review');

-- Return the minimal task projection directly instead of first aggregating all
-- reminder history through list_employee_check_in_workspace() and filtering it
-- back out as JSON. The same scope predicate remains authoritative.
create or replace function public.list_my_employee_check_in_tasks()
returns table (
  person_id uuid,
  full_name text,
  position_title text,
  company_key text,
  reminders jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_employee_check_in_workspace_access() then
    raise exception 'Check-in task access is required.' using errcode = '42501';
  end if;

  return query
  select
    person.id,
    person.full_name,
    person.position_title,
    person.company_key,
    jsonb_agg(
      jsonb_build_object(
        'id', reminder.id,
        'milestone', reminder.milestone,
        'sequence', reminder.reminder_sequence,
        'dueDate', reminder.due_date,
        'notifyDate', reminder.notify_date,
        'status', reminder.delivery_status,
        'deliveredAt', reminder.delivered_at,
        'completedAt', reminder.completed_at
      )
      order by reminder.due_date, reminder.id
    )
  from public.internal_org_people person
  join private.employee_check_in_reminders reminder
    on reminder.person_id = person.id
  where person.node_kind = 'person'
    and person.is_active
    and reminder.reminder_sequence = 'initial'
    and reminder.delivery_status in ('scheduled', 'claimed', 'delivered', 'needs_review')
    and private.can_view_employee_check_in(person.id)
  group by person.id, person.full_name, person.position_title, person.company_key
  order by lower(person.full_name), person.id;
end;
$$;

comment on function public.list_my_employee_check_in_tasks() is
  'Returns the minimal open initial check-in task projection directly from indexed reminder rows; scope is re-authorised by private.can_view_employee_check_in.';

commit;
