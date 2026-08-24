begin;

do $$
begin
  if to_regprocedure('private.is_portal_account_admin()') is null
    or to_regclass('public.profiles') is null then
    raise exception 'System administrator capability prerequisites are missing.' using errcode = '55000';
  end if;
end;
$$;

-- A single durable predicate is used by Change profile and all later
-- System Admin-only RPCs. The broader portal-account administrator capability
-- remains insufficient: the current active profile must explicitly carry the
-- controlled system_admin role.
create function private.is_system_portal_account_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_portal_account_admin()
    and exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.app_role = 'system_admin'
        and profile.login_name is not null
        and profile.account_status = 'active'
    );
$$;

comment on function private.is_system_portal_account_admin() is
  'True only for the current active, controlled System Admin portal account; used internally by Change profile and System Admin-only operations.';

revoke all on function private.is_system_portal_account_admin()
  from public, anon, authenticated;

commit;
