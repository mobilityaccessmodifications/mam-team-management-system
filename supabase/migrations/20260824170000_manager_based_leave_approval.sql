begin;

-- Leave approval follows the reporting tree, not job-title text or a team
-- label. A linked, active profile with app_role = manager is the capability
-- switch. The nearest such manager is the primary reviewer; global grants
-- (Penny/Steven and other explicitly configured all-company reviewers) stay
-- available as secondary reviewers.

create or replace function private.sync_leave_manager_approval_grant_for_person(
  p_person_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_label text;
  v_is_manager boolean := false;
  v_actor_id uuid;
begin
  select
    person.auth_user_id,
    coalesce(
      nullif(btrim(profile.preferred_name), ''),
      nullif(btrim(profile.full_name), ''),
      nullif(btrim(person.full_name), '')
    ),
    profile.app_role = 'manager'
      and profile.account_status = 'active'
      and profile.login_name is not null
      and person.is_active
  into v_user_id, v_label, v_is_manager
  from public.internal_org_people person
  left join public.profiles profile
    on profile.id = person.auth_user_id
  where person.id = p_person_id
    and person.node_kind = 'person';

  if v_user_id is null or not v_is_manager then
    if v_user_id is not null then
      v_actor_id := coalesce((select auth.uid()), v_user_id);
      update private.leave_approval_grants approval_grant
      set revoked_at = coalesce(approval_grant.revoked_at, clock_timestamp()),
          revoked_by = coalesce(approval_grant.revoked_by, v_actor_id)
      where approval_grant.reviewer_user_id = v_user_id
        and approval_grant.scope_kind = 'subtree'
        and approval_grant.scope_root_person_id = p_person_id
        and approval_grant.revoked_at is null;
    end if;
    return;
  end if;

  -- Reviving an existing row keeps its stable grant ID for request snapshots.
  update private.leave_approval_grants approval_grant
  set reviewer_label = coalesce(v_label, 'Manager'),
      priority = 10,
      revoked_at = null,
      revoked_by = null
  where approval_grant.reviewer_user_id = v_user_id
    and approval_grant.scope_kind = 'subtree'
    and approval_grant.scope_root_person_id = p_person_id;

  if not found then
    insert into private.leave_approval_grants (
      reviewer_user_id,
      scope_kind,
      scope_root_person_id,
      reviewer_label,
      priority
    )
    values (
      v_user_id,
      'subtree',
      p_person_id,
      coalesce(v_label, 'Manager'),
      10
    );
  end if;
end;
$$;

comment on function private.sync_leave_manager_approval_grant_for_person(uuid) is
  'Synchronises the stable private subtree grant that represents an active manager profile. The grant is revoked when the profile loses manager permission or the person is inactive.';

create or replace function private.sync_leave_manager_approval_grant_after_profile_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person_id uuid;
begin
  select person.id
  into v_person_id
  from public.internal_org_people person
  where person.auth_user_id = new.id
    and person.node_kind = 'person'
  order by person.is_active desc, person.updated_at desc, person.id
  limit 1;

  if v_person_id is not null then
    perform private.sync_leave_manager_approval_grant_for_person(v_person_id);
  end if;
  return new;
end;
$$;

create or replace function private.sync_leave_manager_approval_grant_after_org_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
    and old.auth_user_id is distinct from new.auth_user_id
    and old.auth_user_id is not null then
    update private.leave_approval_grants approval_grant
    set revoked_at = coalesce(approval_grant.revoked_at, clock_timestamp()),
        revoked_by = coalesce(approval_grant.revoked_by, (select auth.uid()), old.auth_user_id)
    where approval_grant.reviewer_user_id = old.auth_user_id
      and approval_grant.scope_kind = 'subtree'
      and approval_grant.scope_root_person_id = new.id
      and approval_grant.revoked_at is null;
  end if;

  perform private.sync_leave_manager_approval_grant_for_person(new.id);
  return new;
end;
$$;

drop trigger if exists profiles_sync_leave_manager_approval_grant
  on public.profiles;
create trigger profiles_sync_leave_manager_approval_grant
after insert or update of app_role, account_status, login_name, preferred_name, full_name
on public.profiles
for each row execute function private.sync_leave_manager_approval_grant_after_profile_change();

drop trigger if exists internal_org_people_sync_leave_manager_approval_grant
  on public.internal_org_people;
create trigger internal_org_people_sync_leave_manager_approval_grant
after insert or update of auth_user_id, is_active, full_name
on public.internal_org_people
for each row
when (new.node_kind = 'person')
execute function private.sync_leave_manager_approval_grant_after_org_change();

-- Seed/revive the manager grants for the current live tree. This also makes
-- future role changes automatic through the two triggers above.
do $$
declare
  person record;
begin
  for person in
    select id
    from public.internal_org_people
    where node_kind = 'person'
  loop
    perform private.sync_leave_manager_approval_grant_for_person(person.id);
  end loop;
end;
$$;

-- The current approval configuration is now hierarchy-based. Team grants are
-- retained as historical configuration but no longer route new leave: a
-- non-manager title/team cannot intercept a request before its nearest manager.
create or replace function private.resolve_leave_approval_grants(p_person_id uuid)
returns table (
  grant_id uuid,
  reviewer_user_id uuid,
  reviewer_label text,
  scope_kind text,
  scope_priority integer,
  scope_depth integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive ancestors as (
    select person.id, person.parent_id, 0::integer as depth
    from public.internal_org_people person
    where person.id = p_person_id
      and person.node_kind = 'person'
      and person.is_active

    union all

    select parent.id, parent.parent_id, ancestors.depth + 1
    from public.internal_org_people parent
    join ancestors on ancestors.parent_id = parent.id
    where parent.is_active
  )
  select
    approval_grant.id,
    approval_grant.reviewer_user_id,
    approval_grant.reviewer_label,
    approval_grant.scope_kind,
    approval_grant.priority::integer,
    coalesce(
      (
        select min(ancestor.depth)
        from ancestors ancestor
        where ancestor.id = approval_grant.scope_root_person_id
      ),
      2147483647
    )
  from private.leave_approval_grants approval_grant
  where approval_grant.revoked_at is null
    and private.is_active_portal_account(approval_grant.reviewer_user_id)
    and (
      approval_grant.scope_kind = 'global'
      or (
        approval_grant.scope_kind = 'subtree'
        and exists (
          select 1
          from public.internal_org_people root_person
          join public.profiles manager_profile
            on manager_profile.id = root_person.auth_user_id
          where root_person.id = approval_grant.scope_root_person_id
            and root_person.node_kind = 'person'
            and root_person.is_active
            and root_person.auth_user_id = approval_grant.reviewer_user_id
            and manager_profile.app_role = 'manager'
            and manager_profile.account_status = 'active'
            and manager_profile.login_name is not null
        )
        and exists (
          select 1
          from ancestors ancestor
          where ancestor.id = approval_grant.scope_root_person_id
        )
      )
    );
$$;

comment on function private.resolve_leave_approval_grants(uuid) is
  'Returns global reviewers plus active manager-profile subtree reviewers. The nearest manager is selected by scope depth; team labels and non-manager roles never intercept leave approval.';

-- Existing assignments keep their request snapshot, but only manager-profile
-- subtree/team grants or explicit global grants remain live reviewer authority.
create or replace function private.is_current_leave_request_reviewer(
  p_leave_request_id uuid,
  p_reviewer_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_reviewer_user_id is not null
    and private.is_active_portal_account(p_reviewer_user_id)
    and exists (
      select 1
      from private.leave_request_reviewer_assignments assignment
      left join private.leave_approval_grants approval_grant
        on approval_grant.id = assignment.source_grant_id
      where assignment.leave_request_id = p_leave_request_id
        and assignment.reviewer_user_id = p_reviewer_user_id
        and (
          (
            assignment.assignment_kind = 'legacy'
            and (
              exists (
                select 1
                from public.profiles manager_profile
                where manager_profile.id = p_reviewer_user_id
                  and manager_profile.app_role = 'manager'
                  and manager_profile.account_status = 'active'
              )
              or exists (
                select 1
                from private.leave_approval_grants global_grant
                where global_grant.reviewer_user_id = p_reviewer_user_id
                  and global_grant.scope_kind = 'global'
                  and global_grant.revoked_at is null
              )
            )
          )
          or (
            approval_grant.id is not null
            and approval_grant.revoked_at is null
            and approval_grant.reviewer_user_id = p_reviewer_user_id
            and approval_grant.scope_kind = assignment.assignment_kind
            and (
              approval_grant.scope_kind = 'global'
              or exists (
                select 1
                from public.profiles manager_profile
                where manager_profile.id = p_reviewer_user_id
                  and manager_profile.app_role = 'manager'
                  and manager_profile.account_status = 'active'
              )
            )
          )
        )
    );
$$;

comment on function private.is_current_leave_request_reviewer(uuid, uuid) is
  'Checks the request snapshot and requires either an active manager profile or an explicit global reviewer grant. Non-manager team assignments cannot approve.';

create or replace function public.can_review_leave_workspace()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_current_portal_access()
    and (select auth.uid()) is not null
    and (
      private.is_internal_org_hr()
      or exists (
        select 1
        from public.profiles manager_profile
        where manager_profile.id = (select auth.uid())
          and manager_profile.app_role = 'manager'
          and manager_profile.account_status = 'active'
          and private.is_internal_org_member()
      )
      or exists (
        select 1
        from private.leave_approval_grants approval_grant
        left join public.profiles reviewer_profile
          on reviewer_profile.id = approval_grant.reviewer_user_id
        where approval_grant.reviewer_user_id = (select auth.uid())
          and approval_grant.revoked_at is null
          and (
            approval_grant.scope_kind = 'global'
            or reviewer_profile.app_role = 'manager'
          )
          and private.is_internal_org_member()
          and private.is_active_portal_account(approval_grant.reviewer_user_id)
      )
      or exists (
        select 1
        from private.leave_request_reviewer_assignments assignment
        where private.is_internal_org_member()
          and private.is_current_leave_request_reviewer(assignment.leave_request_id, (select auth.uid()))
      )
    );
$$;

comment on function public.can_review_leave_workspace() is
  'Returns whether the caller is HR, an active manager-profile account, an explicit global reviewer, or a current request reviewer.';

-- Keep the email route aligned with the approval route. The first active
-- person in the tree is not necessarily authorised to approve; skip ordinary
-- employees and stop at the first active manager profile instead.
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
    join public.profiles manager_profile
      on manager_profile.id = ancestor.auth_user_id
    where ancestor.node_kind = 'person'
      and ancestor.is_active
      and ancestor.auth_user_id is not null
      and manager_profile.app_role = 'manager'
      and manager_profile.account_status = 'active'
      and manager_profile.login_name is not null
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
  'Service-role-only resolver for leave notification delivery. It returns the nearest active manager-profile account and its HR-recorded work email, skipping ordinary employees in the reporting chain.';

-- Re-route all still-pending requests to the nearest current manager. Decided
-- history is untouched; global reviewers remain as secondary access where
-- they were already assigned.
create or replace function private.reroute_pending_leave_requests_to_current_manager()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  candidate record;
  v_updated integer := 0;
begin
  for candidate in
    select
      request.id as request_id,
      manager.grant_id,
      manager.reviewer_user_id,
      manager.reviewer_label
    from public.leave_requests request
    join public.internal_org_people employee
      on employee.auth_user_id = request.user_id
      and employee.node_kind = 'person'
      and employee.is_active
    cross join lateral (
      select resolved.*
      from private.resolve_leave_approval_grants(employee.id) resolved
      where resolved.scope_kind = 'subtree'
      order by resolved.scope_depth, resolved.scope_priority, resolved.grant_id
      limit 1
    ) manager
    where request.status = 'submitted'
      and request.approval_required
  loop
    update public.leave_requests request
    set manager_user_id = candidate.reviewer_user_id,
        manager_name_snapshot = candidate.reviewer_label,
        updated_at = clock_timestamp()
    where request.id = candidate.request_id;

    delete from private.leave_request_reviewer_assignments assignment
    where assignment.leave_request_id = candidate.request_id
      and assignment.assignment_kind <> 'global';

    update private.leave_request_reviewer_assignments assignment
    set is_primary = false
    where assignment.leave_request_id = candidate.request_id;

    insert into private.leave_request_reviewer_assignments (
      leave_request_id,
      reviewer_user_id,
      source_grant_id,
      assignment_kind,
      reviewer_label,
      is_primary
    )
    values (
      candidate.request_id,
      candidate.reviewer_user_id,
      candidate.grant_id,
      'subtree',
      candidate.reviewer_label,
      true
    )
    on conflict (leave_request_id, reviewer_user_id) do update
      set source_grant_id = excluded.source_grant_id,
          assignment_kind = excluded.assignment_kind,
          reviewer_label = excluded.reviewer_label,
          is_primary = true,
          assigned_at = clock_timestamp();

    v_updated := v_updated + 1;
  end loop;

  return v_updated;
end;
$$;

comment on function private.reroute_pending_leave_requests_to_current_manager() is
  'Moves only submitted, undecided requests to the nearest active manager-profile reviewer and leaves decided history unchanged.';

-- Luke is the Process Analyst manager requested for the current reporting
-- line. The role is data, not a title inference, so a future promotion of any
-- other employee can use the same app_role switch.
update public.profiles profile
set app_role = 'manager',
    updated_at = clock_timestamp()
where profile.id = (
  select person.auth_user_id
  from public.internal_org_people person
  where person.node_kind = 'person'
    and person.is_active
    and lower(btrim(person.full_name)) = 'luke symes'
    and person.auth_user_id is not null
  order by person.updated_at desc, person.id
  limit 1
)
and profile.account_status = 'active';

select private.reroute_pending_leave_requests_to_current_manager();

revoke all on function private.sync_leave_manager_approval_grant_for_person(uuid)
  from public, anon, authenticated;
revoke all on function private.sync_leave_manager_approval_grant_after_profile_change()
  from public, anon, authenticated;
revoke all on function private.sync_leave_manager_approval_grant_after_org_change()
  from public, anon, authenticated;
revoke all on function private.reroute_pending_leave_requests_to_current_manager()
  from public, anon, authenticated;

commit;
