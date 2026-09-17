begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:people-operational-tab-access:20260917', 0)
  );

  if to_regclass('public.profiles') is null
    or to_regclass('public.internal_org_people') is null
    or to_regprocedure('private.has_current_portal_access()') is null
    or to_regprocedure('private.is_active_linked_internal_employee(uuid)') is null
    or to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regprocedure('public.current_portal_account()') is null
    or to_regprocedure('public.can_manage_portal_accounts()') is null
    or to_regprocedure('public.can_access_non_roster_system_admin_workspace()') is null
    or to_regprocedure('public.can_view_employee_check_in_workspace()') is null
    or to_regprocedure('public.can_view_employee_directory()') is null
    or to_regprocedure('public.can_change_employee_view()') is null
    or to_regprocedure('public.can_view_subscription_register()') is null
    or to_regprocedure('public.can_access_own_subscriptions()') is null
    or to_regprocedure('public.get_portal_workspace_capabilities()') is null then
    raise exception 'People operational tab prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Organisation structure and the complete subscription register are internal
-- operational surfaces. Grant read access from the controlled portal role,
-- never from an editable job title, reporting line or display name. Penny and
-- Steven already carry the controlled System Admin role, so they follow the
-- same durable rule rather than receiving name-based exceptions.
create function private.can_view_people_operational_tabs()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_system_portal_account_admin()
    or (
      (select auth.uid()) is not null
      and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
      and private.has_current_portal_access()
      and private.is_active_linked_internal_employee((select auth.uid()))
      and exists (
        select 1
        from public.profiles profile
        where profile.id = (select auth.uid())
          and profile.app_role in ('manager', 'hr')
          and profile.account_status = 'active'
          and profile.login_name is not null
      )
    );
$$;

comment on function private.can_view_people_operational_tabs() is
  'Returns true for the active System Admin or an active linked manager/HR portal account. It is role-based and never matches names or organisation titles.';

create function public.can_view_organisation_chart()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_view_people_operational_tabs();
$$;

comment on function public.can_view_organisation_chart() is
  'Returns whether the current active System Admin, manager or HR account may open the complete organisation chart.';

-- Managers and HR receive the same credential-free register projection as a
-- System Admin, but every write RPC continues to require the separate
-- can_manage_subscriptions() capability. Ordinary employees retain only the
-- self-scoped subscription projection used inside their own Directory card.
create or replace function public.can_view_subscription_register()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_view_people_operational_tabs();
$$;

comment on function public.can_view_subscription_register() is
  'Returns whether the current active System Admin, manager or HR account may read the credential-free company subscription register; mutation authority remains separate.';

-- Ordinary employees still need the safe team Directory. Restrict their
-- direct public-table projection to the same branch that UI displays: their
-- immediate reporting root and its active descendants. Complete-tree viewers
-- keep the full active projection. The security-definer helper is private so a
-- browser cannot supply another employee or manager as the scope root.
create function private.list_current_employee_people_branch_node_ids()
returns table (node_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive caller as (
    select
      person.id as person_id,
      coalesce(person.parent_id, person.id) as root_id
    from public.internal_org_people person
    join public.profiles profile on profile.id = person.auth_user_id
    where person.auth_user_id = (select auth.uid())
      and person.node_kind = 'person'
      and person.is_active
      and profile.account_status = 'active'
      and profile.login_name is not null
      and private.has_current_portal_access()
      and private.is_active_linked_internal_employee((select auth.uid()))
    limit 1
  ), branch as (
    select
      root.id as node_id,
      array[root.id]::uuid[] as lineage
    from caller
    join public.internal_org_people root on root.id = caller.root_id
    where root.is_active

    union all

    select
      child.id,
      branch.lineage || child.id
    from branch
    join public.internal_org_people child on child.parent_id = branch.node_id
    where child.is_active
      and not child.id = any(branch.lineage)
  )
  select caller.person_id
  from caller
  union
  select branch.node_id
  from branch;
$$;

comment on function private.list_current_employee_people_branch_node_ids() is
  'Returns the current active linked employee''s own safe Directory branch without accepting a client-supplied identity.';

-- RLS callers need one executable predicate, while the set-returning scope
-- helper remains private. The supplied node ID cannot widen scope: the
-- function derives the current actor and returns only a boolean for that row.
create function public.can_view_internal_org_node(p_node_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_node_id is not null
    and (
      private.can_view_people_operational_tabs()
      or exists (
        select 1
        from private.list_current_employee_people_branch_node_ids() visible
        where visible.node_id = p_node_id
      )
    );
$$;

comment on function public.can_view_internal_org_node(uuid) is
  'RLS predicate for one active organisation row: complete-tree roles see all rows and an ordinary employee sees only their server-derived team branch.';

drop policy if exists internal_org_people_select_member
  on public.internal_org_people;
drop policy if exists internal_org_people_select_people_workspace
  on public.internal_org_people;

create policy internal_org_people_select_people_workspace
  on public.internal_org_people for select
  to authenticated
  using (
    is_active
    and public.can_view_internal_org_node(id)
  );

-- Add the new organisation capability to the existing request-start DTO so
-- the Server Component can choose the client surface from one database-owned
-- authorization result.
drop function public.get_portal_workspace_capabilities();

create function public.get_portal_workspace_capabilities()
returns table (
  auth_user_id uuid,
  person_id uuid,
  account_status text,
  can_manage_accounts boolean,
  can_access_non_roster_system_admin_workspace boolean,
  can_view_check_in_workspace boolean,
  can_view_employee_directory boolean,
  can_view_organisation_chart boolean,
  can_change_employee_view boolean,
  can_view_subscription_register boolean,
  can_access_own_subscriptions boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    account.auth_user_id,
    account.person_id,
    account.account_status,
    public.can_manage_portal_accounts(),
    public.can_access_non_roster_system_admin_workspace(),
    public.can_view_employee_check_in_workspace(),
    public.can_view_employee_directory(),
    public.can_view_organisation_chart(),
    public.can_change_employee_view(),
    public.can_view_subscription_register(),
    public.can_access_own_subscriptions()
  from public.current_portal_account() account;
$$;

comment on function public.get_portal_workspace_capabilities() is
  'Returns the active account identity and all page-start capabilities, including complete organisation-chart visibility, in one authenticated database roundtrip.';

revoke all on function private.can_view_people_operational_tabs()
  from public, anon, authenticated;
revoke all on function private.list_current_employee_people_branch_node_ids()
  from public, anon, authenticated;
revoke all on function public.can_view_organisation_chart()
  from public, anon, authenticated;
revoke all on function public.can_view_internal_org_node(uuid)
  from public, anon, authenticated;
revoke all on function public.get_portal_workspace_capabilities()
  from public, anon, authenticated;

grant execute on function public.can_view_organisation_chart()
  to authenticated;
grant execute on function public.can_view_internal_org_node(uuid)
  to authenticated;
grant execute on function public.get_portal_workspace_capabilities()
  to authenticated;

commit;
