begin;

do $$
begin
  if to_regprocedure('private.has_employee_check_in_workspace_access()') is null
    or to_regprocedure('public.list_employee_check_in_workspace()') is null
    or to_regprocedure('public.list_my_employee_check_in_tasks()') is null
    or to_regclass('private.employee_check_in_reminders') is null
    or to_regclass('private.employee_check_in_access_grants') is null then
    raise exception 'Set-based Check-in scope prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Build the caller's effective scope once per request. The previous list
-- queries invoked can_view_employee_check_in(person.id) for every employee,
-- rebuilding an ancestor CTE each time. This private helper preserves the
-- exact HR/global/subtree/current-manager rules while traversing the current
-- organisation tree once.
create or replace function private.list_visible_employee_check_in_person_ids()
returns table (person_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive
  caller as (
    select (select auth.uid()) as user_id
  ),
  actor as (
    select person.id as person_id
    from public.internal_org_people person
    join caller on person.auth_user_id = caller.user_id
    where person.node_kind = 'person'
      and person.is_active
    limit 1
  ),
  global_scope as (
    select
      private.is_internal_org_hr()
      or exists (
        select 1
        from private.employee_check_in_access_grants access_grant
        join caller on access_grant.reviewer_user_id = caller.user_id
        where access_grant.scope_kind = 'global'
          and access_grant.revoked_at is null
          and private.is_internal_org_member()
          and private.is_active_portal_account(caller.user_id)
      ) as is_global
  ),
  scoped_roots as (
    -- An active manager can see their active descendants.
    select actor.person_id
    from actor
    join caller on true
    where private.is_internal_org_member()
      and private.is_active_portal_account(caller.user_id)

    union

    -- A scoped reviewer grant is valid only while its root remains the
    -- current active employee linked to the signed-in reviewer.
    select access_grant.scope_root_person_id
    from private.employee_check_in_access_grants access_grant
    join caller on access_grant.reviewer_user_id = caller.user_id
    join public.internal_org_people root_person
      on root_person.id = access_grant.scope_root_person_id
    where access_grant.scope_kind = 'subtree'
      and access_grant.revoked_at is null
      and root_person.node_kind = 'person'
      and root_person.is_active
      and root_person.auth_user_id = caller.user_id
      and private.is_internal_org_member()
      and private.is_active_portal_account(caller.user_id)
  ),
  descendants as (
    select scoped_roots.person_id as root_person_id,
           scoped_roots.person_id as node_id,
           0::integer as depth
    from scoped_roots

    union all

    select descendants.root_person_id,
           child.id as node_id,
           descendants.depth + 1
    from descendants
    join public.internal_org_people child on child.parent_id = descendants.node_id
    where child.is_active
  )
  select person.id
  from public.internal_org_people person
  cross join global_scope
  where person.node_kind = 'person'
    and person.is_active
    and (
      global_scope.is_global
      or exists (
        select 1
        from descendants
        where descendants.node_id = person.id
          and descendants.depth > 0
      )
    );
$$;

comment on function private.list_visible_employee_check_in_person_ids() is
  'Returns the current caller’s effective active Check-in person scope once per query; used only by guarded public Check-in projections.';

-- The private helper is not an API endpoint.
revoke all on function private.list_visible_employee_check_in_person_ids() from public, anon, authenticated;

create or replace function public.list_employee_check_in_workspace()
returns table (
  person_id uuid,
  full_name text,
  position_title text,
  company_key text,
  start_date date,
  reminders jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_employee_check_in_workspace_access() then
    raise exception 'Check-in workspace access is required.' using errcode = '42501';
  end if;

  return query
  select
    person.id,
    person.full_name,
    person.position_title,
    person.company_key,
    person.started_date,
    coalesce(schedule.reminders, '[]'::jsonb)
  from private.list_visible_employee_check_in_person_ids() visible_person
  join public.internal_org_people person on person.id = visible_person.person_id
  left join lateral (
    select jsonb_agg(
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
      order by reminder.due_date, reminder.reminder_sequence
    ) as reminders
    from private.employee_check_in_reminders reminder
    where reminder.person_id = person.id
      and reminder.delivery_status not in ('superseded', 'cancelled')
  ) schedule on true
  order by lower(person.full_name), person.id;
end;
$$;

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
  from private.list_visible_employee_check_in_person_ids() visible_person
  join public.internal_org_people person on person.id = visible_person.person_id
  join private.employee_check_in_reminders reminder
    on reminder.person_id = person.id
  where reminder.reminder_sequence = 'initial'
    and reminder.delivery_status in ('scheduled', 'claimed', 'delivered', 'needs_review')
  group by person.id, person.full_name, person.position_title, person.company_key
  order by lower(person.full_name), person.id;
end;
$$;

revoke all on function public.list_employee_check_in_workspace() from public, anon;
revoke all on function public.list_my_employee_check_in_tasks() from public, anon;
grant execute on function public.list_employee_check_in_workspace() to authenticated, service_role;
grant execute on function public.list_my_employee_check_in_tasks() to authenticated, service_role;

commit;
