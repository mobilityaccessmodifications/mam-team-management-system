begin;

do $$
begin
  if to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regprocedure('private.list_visible_employee_check_in_person_ids()') is null then
    raise exception 'System Admin Check-in scope prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Keep the set-based fast path aligned with the page/calendar capability:
-- a controlled System Admin has global Check-in scope even when intentionally
-- kept outside the employee roster.
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
      private.is_system_portal_account_admin()
      or private.is_internal_org_hr()
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
    select actor.person_id
    from actor
    join caller on true
    where private.is_internal_org_member()
      and private.is_active_portal_account(caller.user_id)

    union

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
  'Returns active Check-in scope once per request, including global System Admin/HR/grant scope and active manager subtrees.';

revoke all on function private.list_visible_employee_check_in_person_ids()
  from public, anon, authenticated;

commit;
