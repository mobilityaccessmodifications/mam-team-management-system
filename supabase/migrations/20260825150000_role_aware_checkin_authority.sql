begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:role-aware-checkin-authority:20260825', 0)
  );

  if to_regclass('public.profiles') is null
    or to_regclass('public.internal_org_people') is null
    or to_regclass('private.employee_check_in_access_grants') is null
    or to_regclass('private.employee_check_in_reminders') is null
    or to_regprocedure('private.has_current_portal_access()') is null
    or to_regprocedure('private.is_active_portal_account(uuid)') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regprocedure('private.sync_employee_check_in_reminders(uuid,boolean,boolean)') is null then
    raise exception 'Role-aware Check-in authority prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Directory, Check-in register and outbound reminder delivery must use the
-- nearest authorised reporting manager, not merely the nearest person node.
-- The external-org-unit label remains an HR-only fallback when no authorised
-- internal person exists; it has no manager_id and therefore cannot receive a
-- manager reminder.
create or replace function private.resolve_internal_org_employee_manager(
  p_person_id uuid
)
returns table (
  manager_id uuid,
  manager_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive ancestors as (
    select
      parent.id,
      parent.full_name,
      parent.parent_id,
      parent.node_kind,
      parent.auth_user_id,
      parent.is_active,
      1::integer as depth
    from public.internal_org_people person
    join public.internal_org_people parent on parent.id = person.parent_id
    where person.id = p_person_id

    union all

    select
      parent.id,
      parent.full_name,
      parent.parent_id,
      parent.node_kind,
      parent.auth_user_id,
      parent.is_active,
      ancestors.depth + 1
    from public.internal_org_people parent
    join ancestors on parent.id = ancestors.parent_id
  ), authorised_manager as (
    select ancestor.*
    from ancestors ancestor
    join public.profiles profile
      on profile.id = ancestor.auth_user_id
    where ancestor.node_kind = 'person'
      and ancestor.is_active
      and ancestor.auth_user_id is not null
      and profile.app_role in ('manager', 'system_admin')
      and profile.account_status = 'active'
      and profile.login_name is not null
    order by ancestor.depth, ancestor.id
    limit 1
  )
  select
    (select manager.id from authorised_manager manager) as manager_id,
    coalesce(
      (select manager.full_name from authorised_manager manager),
      (
        select root.manager_label
        from ancestors ancestor
        join private.employee_roster_external_manager_roots root
          on root.org_unit_id = ancestor.id
        where ancestor.node_kind = 'org_unit'
        order by ancestor.depth, ancestor.id
        limit 1
      )
    ) as manager_name;
$$;

comment on function private.resolve_internal_org_employee_manager(uuid) is
  'Returns the nearest active manager/system-admin profile in the reporting tree, or the HR-only external org-unit label when no authorised internal person exists.';

-- A global System Admin is always a global Check-in reviewer. Managers use
-- their own reporting subtree only; a global grant must never widen a manager
-- into an all-company Check-in reviewer.
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
    and exists (
      select 1
      from public.profiles profile
      where profile.id = p_user_id
        and profile.app_role = 'system_admin'
        and profile.account_status = 'active'
        and profile.login_name is not null
    );
$$;

comment on function private.has_configured_global_employee_check_in_access(uuid) is
  'Checks whether a supplied active System Admin has global Check-in scope. Manager and explicit global-grant rows never create global scope.';

-- This scope is shared by Check-in Calendar, the register and Tasks. The
-- caller's own dynamic subtree is available only to an active linked manager
-- or System Admin. Explicit subtree grants use the same role boundary.
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
    join public.profiles profile
      on profile.id = person.auth_user_id
    join session on person.auth_user_id = session.user_id
    where session.is_valid
      and private.is_active_linked_internal_employee(session.user_id)
      and profile.app_role in ('manager', 'system_admin')
      and profile.account_status = 'active'
      and profile.login_name is not null
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
    join public.profiles reviewer_profile
      on reviewer_profile.id = access_grant.reviewer_user_id
    join public.internal_org_people root_person
      on root_person.id = access_grant.scope_root_person_id
    where session.is_valid
      and private.is_active_linked_internal_employee(session.user_id)
      and reviewer_profile.app_role in ('manager', 'system_admin')
      and reviewer_profile.account_status = 'active'
      and reviewer_profile.login_name is not null
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

comment on function private.list_visible_employee_check_in_person_ids() is
  'Returns global System Admin scope or active descendants of an active linked manager/system-admin; employee-role structural parents cannot obtain Check-in scope.';

-- Change Profile is a signed-in Super Admin test projection. The selected
-- profile determines only the simulated scope: manager => own subtree,
-- system_admin => global, every other role => no Check-in scope. The caller's
-- real System Admin authority remains the only mutation/preview gate.
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

  if not found then
    raise exception 'The selected employee is unavailable.' using errcode = '23503';
  end if;

  select exists (
    select 1
    from public.profiles profile
    join public.internal_org_people target
      on target.auth_user_id = profile.id
    where profile.id = v_target_auth_user_id
      and profile.app_role in ('manager', 'system_admin')
      and profile.account_status = 'active'
      and profile.login_name is not null
      and target.id = p_person_id
      and target.node_kind = 'person'
      and target.is_active
      and private.is_active_linked_internal_employee(profile.id)
  ) into v_target_can_access;

  select exists (
    select 1
    from public.profiles profile
    where profile.id = v_target_auth_user_id
      and profile.app_role = 'system_admin'
      and profile.account_status = 'active'
      and profile.login_name is not null
  ) into v_target_is_global;

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

comment on function public.list_employee_check_in_workspace_for_preview(uuid) is
  'Super Admin-only Change Profile projection: selected manager gets their active subtree, selected System Admin gets global scope, other roles get no Check-in records.';

-- Calendar preview uses the same selected-role rule as the workspace preview.
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

  if not found then
    raise exception 'The selected employee is unavailable.' using errcode = '23503';
  end if;

  select exists (
    select 1
    from public.profiles profile
    join public.internal_org_people target
      on target.auth_user_id = profile.id
    where profile.id = v_target_auth_user_id
      and profile.app_role in ('manager', 'system_admin')
      and profile.account_status = 'active'
      and profile.login_name is not null
      and target.id = p_person_id
      and target.node_kind = 'person'
      and target.is_active
      and private.is_active_linked_internal_employee(profile.id)
  ) into v_target_can_access;

  select exists (
    select 1
    from public.profiles profile
    where profile.id = v_target_auth_user_id
      and profile.app_role = 'system_admin'
      and profile.account_status = 'active'
      and profile.login_name is not null
  ) into v_target_is_global;

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
  'Super Admin-only Change Profile Calendar projection: selected manager gets their active subtree, selected System Admin gets global scope, other roles get no Check-in records.';

-- Reconcile the explicitly approved authority roles before installing the
-- Check-in reminder role-change trigger. Matching requires a live, linked
-- person record and an active portal account; a title, email or unlinked
-- duplicate cannot silently acquire authority. The existing profile/Auth and
-- leave-approval triggers keep their own invariants in sync as each safe role
-- update is applied. Jiwesh is intentionally demoted because he is not in the
-- approved manager list; this does not alter any org-tree relationship.
do $$
declare
  target record;
begin
  for target in
    with desired(full_name) as (
      values
        ('luke symes'),
        ('sujant chettri'),
        ('serene sharma'),
        ('kieran kose'),
        ('europe karki'),
        ('todd rogerson'),
        ('penny makris'),
        ('steven makris'),
        ('jiwesh jaiswal')
    )
    select
      desired.full_name,
      count(profile.id) as matched_count
    from desired
    left join public.internal_org_people person
      on lower(btrim(person.full_name)) = desired.full_name
      and person.node_kind = 'person'
      and person.is_active
      and person.auth_user_id is not null
    left join public.profiles profile
      on profile.id = person.auth_user_id
      and profile.account_status = 'active'
      and profile.login_name is not null
    group by desired.full_name
  loop
    if target.matched_count <> 1 then
      raise exception
        'Role target % must resolve to exactly one active linked person; found %.',
        target.full_name,
        target.matched_count
        using errcode = 'P0001';
    end if;
  end loop;
end;
$$;

with desired(full_name, app_role) as (
  values
    ('luke symes', 'manager'::text),
    ('sujant chettri', 'manager'::text),
    ('serene sharma', 'manager'::text),
    ('kieran kose', 'manager'::text),
    ('europe karki', 'manager'::text),
    ('todd rogerson', 'system_admin'::text),
    ('penny makris', 'system_admin'::text),
    ('steven makris', 'system_admin'::text),
    ('jiwesh jaiswal', 'employee'::text)
), selected as (
  select
    desired.full_name,
    desired.app_role,
    person.auth_user_id as profile_id
  from desired
  join public.internal_org_people person
    on lower(btrim(person.full_name)) = desired.full_name
  join public.profiles profile
    on profile.id = person.auth_user_id
  where person.node_kind = 'person'
    and person.is_active
    and person.auth_user_id is not null
    and profile.account_status = 'active'
    and profile.login_name is not null
)
update public.profiles profile
set app_role = selected.app_role,
    updated_at = clock_timestamp()
from selected
where profile.id = selected.profile_id
  and profile.app_role is distinct from selected.app_role;

-- The approved manager roster is exact. Remove stale manager authority from
-- every other account, including inactive or unlinked accounts that could
-- otherwise regain manager scope after a later relink/reactivation. This does
-- not touch System Admin break-glass accounts.
with approved_manager_profile_ids as (
  select person.auth_user_id as profile_id
  from public.internal_org_people person
  join public.profiles profile on profile.id = person.auth_user_id
  where lower(btrim(person.full_name)) in (
      'luke symes',
      'sujant chettri',
      'serene sharma',
      'kieran kose',
      'europe karki'
    )
    and person.node_kind = 'person'
    and person.is_active
    and person.auth_user_id is not null
    and profile.account_status = 'active'
    and profile.login_name is not null
)
update public.profiles profile
set app_role = 'employee',
    updated_at = clock_timestamp()
where profile.app_role = 'manager'
  and not exists (
    select 1
    from approved_manager_profile_ids approved
    where approved.profile_id = profile.id
  );

-- Role changes can change every descendant's current manager recipient. Keep
-- reminder rows aligned immediately, while the sync function's July cutoff and
-- status guards prevent any pre-July completed milestone from reopening.
create or replace function private.sync_employee_check_in_reminders_after_profile_role_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person_id uuid;
begin
  for v_person_id in
    select person.id
    from public.internal_org_people person
    where person.node_kind = 'person'
      and person.is_active
  loop
    perform private.sync_employee_check_in_reminders(v_person_id, true, false);
  end loop;

  return new;
end;
$$;

drop trigger if exists profiles_sync_employee_check_in_reminders_after_role_change
  on public.profiles;
create trigger profiles_sync_employee_check_in_reminders_after_role_change
after insert or update of app_role, account_status, login_name
on public.profiles
for each row execute function private.sync_employee_check_in_reminders_after_profile_role_change();

-- Re-evaluate all current active roster reminders once after the resolver is
-- upgraded. No status path in sync_employee_check_in_reminders reopens a
-- completed pre-July milestone.
do $$
declare
  person record;
begin
  for person in
    select id
    from public.internal_org_people
    where node_kind = 'person'
      and is_active
  loop
    perform private.sync_employee_check_in_reminders(person.id, true, false);
  end loop;
end;
$$;

revoke all on function private.resolve_internal_org_employee_manager(uuid)
  from public, anon, authenticated;
revoke all on function private.has_configured_global_employee_check_in_access(uuid)
  from public, anon, authenticated;
revoke all on function private.list_visible_employee_check_in_person_ids()
  from public, anon, authenticated;
revoke all on function private.sync_employee_check_in_reminders_after_profile_role_change()
  from public, anon, authenticated;
revoke all on function public.list_employee_check_in_workspace_for_preview(uuid)
  from public, anon, authenticated;
revoke all on function public.list_employee_check_in_calendar_entries_for_preview(uuid)
  from public, anon, authenticated;
grant execute on function public.list_employee_check_in_workspace_for_preview(uuid)
  to authenticated, service_role;
grant execute on function public.list_employee_check_in_calendar_entries_for_preview(uuid)
  to authenticated, service_role;

commit;
