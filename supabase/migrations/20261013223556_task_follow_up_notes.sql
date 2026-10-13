begin;
set local search_path = '';
select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control', 0));
lock table private.confirmed_test_identity_purges, private.confirmed_test_purge_schema
  in share row exclusive mode nowait;

do $$
begin
  if (select count(*) from private.confirmed_test_purge_schema) <> 1
    or private.confirmed_test_purge_schema_hash() is distinct from
      (select schema_hash from private.confirmed_test_purge_schema where singleton)
    or to_regprocedure('public.list_my_employee_check_in_tasks()') is null
    or to_regprocedure('public.list_employee_check_in_workspace_for_preview(uuid)') is null
    or to_regprocedure('public.list_my_subscription_review_tasks()') is null
    or to_regprocedure('public.list_subscription_review_tasks_for_preview(uuid)') is null
    or to_regprocedure('public.get_my_employee_work_schedule_workspace()') is null
    or to_regprocedure('public.get_selected_employee_work_schedule_workspace(uuid)') is null
    or to_regprocedure('private.lock_portal_role_actor()') is null then
    raise exception 'Task notes require the reviewed task scope and predecessor catalog.' using errcode = '55000';
  end if;
end;
$$;

create table private.task_follow_up_notes (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('check_in', 'subscription_review', 'work_schedule')),
  check_in_reminder_id uuid references private.employee_check_in_reminders(id) on delete cascade,
  subscription_id uuid references private.subscription_register(id) on delete cascade,
  review_on date,
  work_schedule_request_id uuid references private.employee_work_schedule_change_requests(id) on delete cascade,
  notes text not null check (char_length(notes) <= 5000),
  version bigint not null default 1 check (version between 1 and 9007199254740991),
  updated_at timestamptz not null default clock_timestamp(),
  updated_by_user_id uuid not null references auth.users(id) on delete restrict,
  constraint task_follow_up_notes_target_check check (
    (kind = 'check_in' and check_in_reminder_id is not null and subscription_id is null
      and review_on is null and work_schedule_request_id is null)
    or (kind = 'subscription_review' and subscription_id is not null and review_on is not null
      and check_in_reminder_id is null and work_schedule_request_id is null)
    or (kind = 'work_schedule' and work_schedule_request_id is not null
      and check_in_reminder_id is null and subscription_id is null and review_on is null)
  )
);
create unique index task_follow_up_notes_check_in_idx on private.task_follow_up_notes(check_in_reminder_id)
  where kind = 'check_in';
create unique index task_follow_up_notes_subscription_idx on private.task_follow_up_notes(subscription_id, review_on)
  where kind = 'subscription_review';
create unique index task_follow_up_notes_work_schedule_idx on private.task_follow_up_notes(work_schedule_request_id)
  where kind = 'work_schedule';
alter table private.task_follow_up_notes enable row level security;
alter table private.task_follow_up_notes force row level security;
revoke all on table private.task_follow_up_notes from public, anon, authenticated, service_role;

create function private.require_task_notes_scope(
  p_kind text, p_task_id uuid, p_review_on date, p_preview_person_id uuid
)
returns void language plpgsql stable security invoker set search_path = '' as $$
declare workspace jsonb; permitted boolean := false;
begin
  if (select auth.uid()) is null or not exists(select 1 from private.portal_role_policy()) then
    raise exception 'Active portal access is required for task notes.' using errcode = '42501';
  end if;
  if p_task_id is null or p_kind is null or p_kind not in ('check_in', 'subscription_review', 'work_schedule')
    or (p_kind = 'subscription_review' and p_review_on is null)
    or (p_kind <> 'subscription_review' and p_review_on is not null) then
    raise exception 'The task notes target is invalid.' using errcode = '22023';
  end if;
  if p_kind = 'check_in' then
    if p_preview_person_id is null then
      select exists(
        select 1 from public.list_my_employee_check_in_tasks() employee
        cross join lateral jsonb_array_elements(employee.reminders) reminder
        where reminder->>'id' = p_task_id::text
          and reminder->>'sequence' = 'initial'
          and reminder->>'status' in ('scheduled', 'claimed', 'delivered', 'needs_review')
      ) into permitted;
    else
      select exists(
        select 1 from public.list_employee_check_in_workspace_for_preview(p_preview_person_id) employee
        cross join lateral jsonb_array_elements(employee.reminders) reminder
        where reminder->>'id' = p_task_id::text
          and reminder->>'sequence' = 'initial'
          and reminder->>'status' in ('scheduled', 'claimed', 'delivered', 'needs_review')
      ) into permitted;
    end if;
  elsif p_kind = 'subscription_review' then
    if p_preview_person_id is null then
      select exists(select 1 from public.list_my_subscription_review_tasks() task
        where task.subscription_id = p_task_id and task.next_review_on = p_review_on) into permitted;
    else
      select exists(select 1 from public.list_subscription_review_tasks_for_preview(p_preview_person_id) task
        where task.subscription_id = p_task_id and task.next_review_on = p_review_on) into permitted;
    end if;
  else
    if p_preview_person_id is null then
      workspace := public.get_my_employee_work_schedule_workspace();
    else
      workspace := public.get_selected_employee_work_schedule_workspace(p_preview_person_id);
    end if;
    select exists(select 1 from jsonb_array_elements(
      coalesce(workspace->'history', '[]'::jsonb) || coalesce(workspace->'reviews', '[]'::jsonb)
    ) task where task->>'id' = p_task_id::text and task->>'status' = 'submitted') into permitted;
  end if;
  if not permitted then
    raise exception 'The task is outside the current task scope.' using errcode = '42501';
  end if;
end;
$$;

create function public.get_visible_task_notes(
  p_kind text, p_task_id uuid, p_review_on date default null, p_preview_person_id uuid default null
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  perform private.require_task_notes_scope(p_kind, p_task_id, p_review_on, p_preview_person_id);
  select jsonb_build_object('text', item.notes, 'version', item.version) into result
  from private.task_follow_up_notes item where item.kind = p_kind
    and item.review_on is not distinct from p_review_on
    and (item.check_in_reminder_id = p_task_id or item.subscription_id = p_task_id or item.work_schedule_request_id = p_task_id);
  return coalesce(result, jsonb_build_object('text', '', 'version', 0));
end;
$$;

create function public.save_visible_task_notes(
  p_kind text, p_task_id uuid, p_review_on date, p_text text, p_expected_version bigint
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare item private.task_follow_up_notes%rowtype;
begin
  if not private.lock_portal_role_actor() then
    raise exception 'Active portal access is required for task notes.' using errcode = '42501';
  end if;
  if p_text is null or char_length(p_text) > 5000 or p_expected_version is null
    or p_expected_version < 0 or p_expected_version >= 9007199254740991 then
    raise exception 'The task notes input is invalid.' using errcode = '22023';
  end if;
  perform private.require_task_notes_scope(p_kind, p_task_id, p_review_on, null);
  if p_kind = 'check_in' then
    perform 1 from private.employee_check_in_reminders task where task.id = p_task_id for update;
  elsif p_kind = 'subscription_review' then
    perform 1 from private.subscription_register task where task.id = p_task_id for update;
  else
    perform 1 from private.employee_work_schedule_change_requests task where task.id = p_task_id for update;
  end if;
  perform private.require_task_notes_scope(p_kind, p_task_id, p_review_on, null);
  select existing.* into item from private.task_follow_up_notes existing where existing.kind = p_kind
    and existing.review_on is not distinct from p_review_on
    and (existing.check_in_reminder_id = p_task_id or existing.subscription_id = p_task_id or existing.work_schedule_request_id = p_task_id)
    for update;
  if coalesce(item.version, 0) <> p_expected_version then
    raise exception 'Task notes have changed.' using errcode = '40001';
  end if;
  if item.id is null then
    insert into private.task_follow_up_notes(
      kind, check_in_reminder_id, subscription_id, review_on, work_schedule_request_id, notes, updated_by_user_id
    ) values (
      p_kind, case when p_kind = 'check_in' then p_task_id end,
      case when p_kind = 'subscription_review' then p_task_id end, p_review_on,
      case when p_kind = 'work_schedule' then p_task_id end, p_text, (select auth.uid())
    ) returning * into item;
  else
    update private.task_follow_up_notes existing set notes = p_text, version = existing.version + 1,
      updated_at = clock_timestamp(), updated_by_user_id = (select auth.uid())
    where existing.id = item.id and existing.version = p_expected_version returning * into item;
  end if;
  return jsonb_build_object('text', item.notes, 'version', item.version);
end;
$$;

revoke all on function private.require_task_notes_scope(text, uuid, date, uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_visible_task_notes(text, uuid, date, uuid) from public, anon, authenticated, service_role;
revoke all on function public.save_visible_task_notes(text, uuid, date, text, bigint) from public, anon, authenticated, service_role;
grant execute on function public.get_visible_task_notes(text, uuid, date, uuid) to authenticated;
grant execute on function public.save_visible_task_notes(text, uuid, date, text, bigint) to authenticated;

update private.confirmed_test_purge_schema set schema_hash = private.confirmed_test_purge_schema_hash() where singleton;
commit;
