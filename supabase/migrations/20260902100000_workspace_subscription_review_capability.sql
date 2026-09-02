begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:workspace-subscription-review-capability:20260902', 0)
  );

  if to_regprocedure('public.current_portal_account()') is null
    or to_regprocedure('public.get_portal_workspace_capabilities()') is null
    or to_regprocedure('public.can_manage_portal_accounts()') is null
    or to_regprocedure('public.can_access_non_roster_system_admin_workspace()') is null
    or to_regprocedure('public.can_view_employee_check_in_workspace()') is null
    or to_regprocedure('public.can_view_employee_directory()') is null
    or to_regprocedure('public.can_change_employee_view()') is null
    or to_regprocedure('public.can_view_subscription_register()') is null
    or to_regprocedure('public.can_access_own_subscriptions()') is null
    or to_regprocedure('public.can_view_subscription_review_calendar()') is null then
    raise exception 'Workspace subscription-review capability prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Keep the established capability RPC intact for already deployed callers.
-- This version adds the owner-scoped subscription review calendar capability
-- without reintroducing scattered page-start permission roundtrips.
create function public.get_portal_workspace_capabilities_v2()
returns table (
  auth_user_id uuid,
  person_id uuid,
  account_status text,
  can_manage_accounts boolean,
  can_access_non_roster_system_admin_workspace boolean,
  can_view_check_in_workspace boolean,
  can_view_employee_directory boolean,
  can_change_employee_view boolean,
  can_view_subscription_register boolean,
  can_access_own_subscriptions boolean,
  can_view_subscription_review_calendar boolean
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
    public.can_change_employee_view(),
    public.can_view_subscription_register(),
    public.can_access_own_subscriptions(),
    public.can_view_subscription_review_calendar()
  from public.current_portal_account() account;
$$;

comment on function public.get_portal_workspace_capabilities_v2() is
  'Returns the active account identity and page-start workspace capabilities, including owner-scoped subscription review calendar access.';

revoke all on function public.get_portal_workspace_capabilities_v2()
  from public, anon, authenticated;

grant execute on function public.get_portal_workspace_capabilities_v2()
  to authenticated;

commit;
