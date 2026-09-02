begin;

do $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('mam:least-privilege-subscription-access:20260902', 0)
  );

  if to_regprocedure('private.is_system_portal_account_admin()') is null
    or to_regprocedure('public.can_view_subscription_register()') is null
    or to_regprocedure('public.list_subscriptions()') is null then
    raise exception 'Subscription access prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- Cost, ownership and complete membership lists are company-wide private
-- operational data. Until the business approves a narrower manager projection,
-- expose the full register only to the all-module System Admin role. Employees
-- retain the separate self-only subscription projection.
create or replace function public.can_view_subscription_register()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_system_portal_account_admin();
$$;

comment on function public.can_view_subscription_register() is
  'Returns whether the current active System Admin may read the company-wide subscription register. Managers remain denied until a scoped projection is approved.';

commit;
