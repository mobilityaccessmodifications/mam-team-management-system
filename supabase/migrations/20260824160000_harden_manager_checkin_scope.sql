begin;

do $$
begin
  if to_regclass('public.profiles') is null
    or to_regclass('public.internal_org_people') is null
    or to_regclass('private.employee_check_in_access_grants') is null
    or to_regprocedure('private.has_current_portal_access()') is null
    or to_regprocedure('private.is_active_portal_account(uuid)') is null then
    raise exception 'Manager Check-in scope hardening prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Manager access uses the controlled active portal-account to active
-- employee-record link. It never depends on mutable Auth metadata, email
-- domain membership, or a job-title string.
create or replace function private.is_active_linked_internal_employee(
  p_user_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_user_id, (select auth.uid())) is not null
    and exists (
      select 1
      from public.profiles profile
      join public.internal_org_people person
        on person.auth_user_id = profile.id
      where profile.id = coalesce(p_user_id, (select auth.uid()))
        and profile.account_status = 'active'
        and profile.login_name is not null
        and person.node_kind = 'person'
        and person.is_active
    );
$$;

-- The only built-in global reviewer is the user-confirmed Super Admin login
-- named "admin". Other all-staff reviewers must hold a controlled private
-- global-grant record.
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
          and profile.login_name = 'admin'
          and profile.app_role = 'system_admin'
          and profile.account_status = 'active'
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

create or replace function private.has_global_employee_check_in_scope()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_current_portal_access()
    and (select auth.uid()) is not null
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and private.has_configured_global_employee_check_in_access((select auth.uid()));
$$;

-- This single scope is shared by Calendar, the safe Check-in workspace and
-- Tasks. A manager receives active descendants only; signing in never adds the
-- manager themself to the scope.
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
  session as (
    select caller.user_id,
      private.has_current_portal_access()
      and caller.user_id is not null
      and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
        as is_valid
    from caller
  ),
  actor as (
    select person.id as person_id
    from public.internal_org_people person
    join session on person.auth_user_id = session.user_id
    where session.is_valid
      and private.is_active_linked_internal_employee(session.user_id)
      and person.node_kind = 'person'
      and person.is_active
    limit 1
  ),
  global_scope as (
    select private.has_global_employee_check_in_scope() as is_global
  ),
  scoped_roots as (
    select actor.person_id
    from actor

    union

    select access_grant.scope_root_person_id
    from private.employee_check_in_access_grants access_grant
    join session on access_grant.reviewer_user_id = session.user_id
    join public.internal_org_people root_person
      on root_person.id = access_grant.scope_root_person_id
    where session.is_valid
      and private.is_active_linked_internal_employee(session.user_id)
      and access_grant.scope_kind = 'subtree'
      and access_grant.revoked_at is null
      and root_person.node_kind = 'person'
      and root_person.is_active
      and root_person.auth_user_id = session.user_id
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
  cross join session
  cross join global_scope
  where session.is_valid
    and person.node_kind = 'person'
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

create or replace function private.has_employee_check_in_workspace_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_global_employee_check_in_scope()
    or exists (select 1 from private.list_visible_employee_check_in_person_ids());
$$;

create or replace function private.can_view_employee_check_in(p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_employee_check_in_workspace_access()
    and exists (
      select 1
      from private.list_visible_employee_check_in_person_ids() visible_person
      where visible_person.person_id = p_person_id
    );
$$;

-- Global reviewers retain historical Check-in dates in Calendar. Managers see
-- only open milestones for people in their current reporting subtree.
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
  from private.employee_check_in_reminders reminder
  join public.internal_org_people person on person.id = reminder.person_id
  where person.node_kind = 'person'
    and person.is_active
    and reminder.reminder_sequence = 'initial'
    and reminder.delivery_status not in ('superseded', 'cancelled')
    and private.can_view_employee_check_in(person.id)
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

-- Change Profile is Super Admin-only. Its preview uses the same controlled
-- account and grant rules as the live manager Calendar and Tasks.
create or replace function public.list_employee_check_in_workspace_for_preview(p_person_id uuid)
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
declare
  v_target_auth_user_id uuid;
  v_target_can_access boolean := false;
  v_target_is_global boolean := false;
begin
  if not private.is_system_portal_account_admin() then
    raise exception 'Only a Super Admin may preview check-in scope.' using errcode = '42501';
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
    person.id,
    person.full_name,
    person.position_title,
    person.company_key,
    person.started_date,
    coalesce(schedule.reminders, '[]'::jsonb)
  from public.internal_org_people person
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
  where v_target_can_access
    and person.node_kind = 'person'
    and person.is_active
    and (
      v_target_is_global
      or exists (
        select 1
        from descendants
        where descendants.id = person.id
          and descendants.depth > 0
      )
    )
  order by lower(person.full_name), person.id;
end;
$$;

comment on function private.is_active_linked_internal_employee(uuid) is
  'Checks the controlled active portal-account to active employee-record relationship used for manager Check-in scope.';
comment on function private.has_configured_global_employee_check_in_access(uuid) is
  'Checks whether a supplied account is the configured Super Admin login or a named active global Check-in reviewer.';
comment on function private.has_global_employee_check_in_scope() is
  'Checks the current signed-in account’s global Check-in scope.';
comment on function private.list_visible_employee_check_in_person_ids() is
  'Returns only the configured global scope or current active manager descendants for safe Check-in projections.';

revoke all on function private.is_active_linked_internal_employee(uuid) from public, anon, authenticated;
revoke all on function private.has_configured_global_employee_check_in_access(uuid) from public, anon, authenticated;
revoke all on function private.has_global_employee_check_in_scope() from public, anon, authenticated;
revoke all on function private.list_visible_employee_check_in_person_ids() from public, anon, authenticated;
revoke all on function private.has_employee_check_in_workspace_access() from public, anon, authenticated;
revoke all on function private.can_view_employee_check_in(uuid) from public, anon, authenticated;
revoke all on function public.list_employee_check_in_calendar_entries() from public, anon, authenticated;

grant execute on function public.list_employee_check_in_calendar_entries() to authenticated;
grant execute on function public.list_employee_check_in_workspace_for_preview(uuid) to authenticated, service_role;

commit;
