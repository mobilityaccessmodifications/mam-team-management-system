begin;

-- The authoritative employee roster may deliberately exclude the platform
-- administrator. Keep that account out of the employee tree while allowing
-- the already-authorised system administrator to retain access to HR tools.
-- This is intentionally narrower than a generic unlinked-account exception:
-- the caller must remain an active portal-account administrator, have the
-- controlled system_admin role, and have no directory node at all.
create function public.can_access_non_roster_system_admin_workspace()
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
    )
    and not exists (
      select 1
      from public.internal_org_people person
      where person.auth_user_id = (select auth.uid())
    );
$$;

comment on function public.can_access_non_roster_system_admin_workspace() is
  'True only for the active, authorised system administrator intentionally kept outside the employee roster. Ordinary portal users must remain linked to an active person.';

revoke all on function public.can_access_non_roster_system_admin_workspace()
  from public, anon, authenticated;
grant execute on function public.can_access_non_roster_system_admin_workspace()
  to authenticated;

commit;
