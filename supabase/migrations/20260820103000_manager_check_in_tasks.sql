begin;

-- This task surface builds on the scoped check-in workspace introduced by
-- 20260819143000. Keep the access-grant table private: managers receive a
-- deliberately narrow RPC projection instead of direct table or HR-register
-- access.
do $$
begin
  if to_regclass('private.employee_check_in_access_grants') is null
    or to_regprocedure('private.has_employee_check_in_workspace_access()') is null
    or to_regprocedure('private.can_view_employee_check_in(uuid)') is null
    or to_regprocedure('public.list_employee_check_in_workspace()') is null
    or to_regprocedure('public.complete_visible_employee_check_in_reminder(uuid)') is null then
    raise exception 'Manager check-in task prerequisites are missing.'
      using errcode = '55000';
  end if;
end;
$$;

-- Defence in depth: no browser role can inspect or change check-in access
-- grants directly. All scope decisions stay in the existing private helpers.
alter table private.employee_check_in_access_grants enable row level security;
revoke all on table private.employee_check_in_access_grants from public, anon, authenticated;

create function public.can_view_employee_check_in_tasks()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_employee_check_in_workspace_access();
$$;

comment on function public.can_view_employee_check_in_tasks() is
  'Returns whether the current active HR user or scoped manager can access the minimal employee check-in task list.';

create function public.list_my_employee_check_in_tasks()
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
  -- Check at the wrapper boundary, then call the existing scoped projection,
  -- which re-checks every returned employee against the active grant and the
  -- current organisation hierarchy. The projection contains no contact,
  -- address, date-of-birth, email, manager-email, or HR enrolment fields.
  if not private.has_employee_check_in_workspace_access() then
    raise exception 'Check-in task access is required.' using errcode = '42501';
  end if;

  return query
  select
    workspace.person_id,
    workspace.full_name,
    workspace.position_title,
    workspace.company_key,
    task_reminders.reminders
  from public.list_employee_check_in_workspace() workspace
  cross join lateral (
    select coalesce(
      jsonb_agg(
        reminder.value
        order by reminder.value ->> 'dueDate', reminder.value ->> 'id'
      ),
      '[]'::jsonb
    ) as reminders
    from jsonb_array_elements(
      case
        when jsonb_typeof(workspace.reminders) = 'array' then workspace.reminders
        else '[]'::jsonb
      end
    ) as reminder(value)
    where reminder.value ->> 'sequence' = 'initial'
      and reminder.value ->> 'status' in (
        'scheduled',
        'claimed',
        'delivered',
        'needs_review'
      )
  ) task_reminders
  where jsonb_array_length(task_reminders.reminders) > 0;
end;
$$;

comment on function public.list_my_employee_check_in_tasks() is
  'Returns only incomplete initial employee check-in tasks in the active caller’s scope. HR sees the global scope; managers see active granted subtrees only.';

create function public.complete_my_employee_check_in_task(p_reminder_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_reminder_id is null then
    raise exception 'A check-in task is required.' using errcode = '22004';
  end if;

  if not private.has_employee_check_in_workspace_access() then
    raise exception 'Check-in task access is required.' using errcode = '42501';
  end if;

  -- A five-month final reminder is a delivery follow-up, not a second manager
  -- task. Check both its initial-sequence identity and the caller's current
  -- employee scope before delegating, so a crafted UUID cannot complete a
  -- hidden final reminder or a task outside the caller's team.
  if not exists (
    select 1
    from private.employee_check_in_reminders reminder
    where reminder.id = p_reminder_id
      and reminder.reminder_sequence = 'initial'
      and private.can_view_employee_check_in(reminder.person_id)
  ) then
    raise exception 'The check-in task is unavailable.' using errcode = '42501';
  end if;

  -- The delegated function locks the reminder, re-checks its employee after
  -- the lock, rejects future/claimed reminders, and writes the audit event.
  -- Do not replace it with a direct update here.
  perform public.complete_visible_employee_check_in_reminder(p_reminder_id);
end;
$$;

comment on function public.complete_my_employee_check_in_task(uuid) is
  'Marks a due scoped manager check-in task complete after server-side scope and reminder-state checks.';

revoke all on function public.can_view_employee_check_in_tasks() from public, anon, authenticated;
revoke all on function public.list_my_employee_check_in_tasks() from public, anon, authenticated;
revoke all on function public.complete_my_employee_check_in_task(uuid) from public, anon, authenticated;

grant execute on function public.can_view_employee_check_in_tasks() to authenticated, service_role;
grant execute on function public.list_my_employee_check_in_tasks() to authenticated, service_role;
grant execute on function public.complete_my_employee_check_in_task(uuid) to authenticated, service_role;

commit;
