begin;

-- Every active manager/leader gets the safe Check-in Tasks surface from the
-- current organisation tree. Explicit grants remain supported for global
-- reviewers, while this dynamic branch means a newly appointed manager does
-- not need a manual permission ticket before seeing their own team tasks.
create or replace function private.has_employee_check_in_workspace_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
with recursive actor as (
  select person.id
  from public.internal_org_people person
  where person.auth_user_id = (select auth.uid())
    and person.node_kind = 'person'
    and person.is_active
  limit 1
), descendants as (
  select child.id
  from public.internal_org_people child
  join actor on child.parent_id = actor.id
  where child.node_kind = 'person'
    and child.is_active

  union all

  select child.id
  from public.internal_org_people child
  join descendants parent on child.parent_id = parent.id
  where child.node_kind = 'person'
    and child.is_active
)
select private.has_current_portal_access()
  and (select auth.uid()) is not null
  and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and (
    private.is_internal_org_hr()
    or (
      private.is_internal_org_member()
      and private.is_active_portal_account((select auth.uid()))
      and (
        exists (
          select 1
          from private.employee_check_in_access_grants access_grant
          where access_grant.reviewer_user_id = (select auth.uid())
            and access_grant.revoked_at is null
            and (
              access_grant.scope_kind = 'global'
              or exists (
                select 1
                from public.internal_org_people root_person
                where root_person.id = access_grant.scope_root_person_id
                  and root_person.node_kind = 'person'
                  and root_person.is_active
                  and root_person.auth_user_id = (select auth.uid())
              )
            )
        )
        or exists (select 1 from descendants)
      )
    )
  );
$$;

create or replace function private.can_view_employee_check_in(p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
with recursive target_ancestors as (
  select target.id, target.parent_id, 0::integer as depth
  from public.internal_org_people target
  where target.id = p_person_id
    and target.node_kind = 'person'
    and target.is_active

  union all

  select parent.id, parent.parent_id, target_ancestors.depth + 1
  from public.internal_org_people parent
  join target_ancestors on target_ancestors.parent_id = parent.id
  where parent.is_active
), actor as (
  select person.id
  from public.internal_org_people person
  where person.auth_user_id = (select auth.uid())
    and person.node_kind = 'person'
    and person.is_active
  limit 1
)
select private.has_employee_check_in_workspace_access()
  and exists (select 1 from target_ancestors where depth = 0)
  and (
    private.is_internal_org_hr()
    or exists (
      select 1
      from private.employee_check_in_access_grants access_grant
      where access_grant.reviewer_user_id = (select auth.uid())
        and access_grant.revoked_at is null
        and private.is_active_portal_account(access_grant.reviewer_user_id)
        and (
          access_grant.scope_kind = 'global'
          or (
            access_grant.scope_kind = 'subtree'
            and exists (
              select 1
              from public.internal_org_people root_person
              where root_person.id = access_grant.scope_root_person_id
                and root_person.node_kind = 'person'
                and root_person.is_active
                and root_person.auth_user_id = (select auth.uid())
            )
            and exists (
              select 1
              from target_ancestors ancestor
              where ancestor.id = access_grant.scope_root_person_id
                and ancestor.depth > 0
            )
          )
        )
    )
    or (
      private.is_internal_org_member()
      and private.is_active_portal_account((select auth.uid()))
      and exists (
        select 1
        from target_ancestors ancestor
        join actor on actor.id = ancestor.id
        where ancestor.depth > 0
      )
    )
  );
$$;

comment on function private.has_employee_check_in_workspace_access() is
  'Allows HR, explicit reviewers, and active managers with current active descendants to access safe Check-in workspace data.';

comment on function private.can_view_employee_check_in(uuid) is
  'Scopes safe Check-in workspace rows to HR, explicit grants, or the current active manager ancestor chain.';

commit;
