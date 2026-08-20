begin;

-- Portal-account administration can expose or change every employee's access
-- to the system. An active account-admin enrolment (or a system_admin profile)
-- is therefore necessary but never sufficient: the acting user must also pass
-- the same internal HR check that protects the private employee directory.
--
-- `private.is_internal_org_hr()` is intentionally used rather than duplicating
-- its allowlist/app-metadata rules. It already requires an active, non-anonymous
-- portal account when portal accounts are enforced, and it does not call this
-- function, so this creates no authorization recursion.
create or replace function private.is_portal_account_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_internal_org_hr()
    and (select auth.uid()) is not null
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and private.is_active_portal_account()
    and (
      exists (
        select 1
        from private.portal_account_admins administrator
        where administrator.auth_user_id = (select auth.uid())
          and administrator.revoked_at is null
      )
      or exists (
        select 1
        from public.profiles profile
        where profile.id = (select auth.uid())
          and profile.app_role = 'system_admin'
      )
    );
$$;

comment on function private.is_portal_account_admin() is
  'Returns true only for an active, non-anonymous internal HR user who is also an enrolled portal account administrator or an explicitly configured system administrator.';

-- Preserve the private helper boundary. Public RPCs retain their authenticated
-- grants and each calls this function internally; clients cannot invoke the
-- private authorization helper directly.
revoke all on function private.is_portal_account_admin()
  from public, anon, authenticated;

commit;
