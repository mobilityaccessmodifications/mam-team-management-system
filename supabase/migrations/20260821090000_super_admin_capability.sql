begin;

-- A controlled system administrator is the highest portal role.  Keep this
-- database-backed check separate from user-editable metadata so the same
-- authority consistently unlocks the HR directory, organisation editor and
-- account administration.  The existing Change View RPC remains
-- system-admin-only; this does not grant that capability to HR users.
create or replace function private.is_internal_org_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) is false
    and (
      lower(coalesce((select auth.jwt()) -> 'app_metadata' ->> 'org_role', ''))
        in ('employee', 'manager', 'hr', 'system_admin')
      or exists (
        select 1
        from private.internal_org_member_allowlist membership_rule
        join auth.users member on member.id = (select auth.uid())
        where membership_rule.revoked_at is null
          and member.email_confirmed_at is not null
          and (
            membership_rule.auth_user_id = member.id
            or (
              membership_rule.auth_user_id is null
              and membership_rule.email = lower(coalesce(member.email, ''))
            )
          )
      )
      or exists (
        select 1
        from private.internal_org_domain_allowlist domain_rule
        join auth.users member on member.id = (select auth.uid())
        where domain_rule.revoked_at is null
          and member.email_confirmed_at is not null
          and domain_rule.domain = lower(split_part(coalesce(member.email, ''), '@', 2))
      )
      or exists (
        select 1
        from public.profiles profile
        join auth.users member on member.id = profile.id
        where profile.id = (select auth.uid())
          and profile.app_role = 'system_admin'
          and profile.account_status = 'active'
          and profile.login_name is not null
          and member.email_confirmed_at is not null
      )
    );
$$;

create or replace function private.is_internal_org_hr()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) is false
    and (
      lower(coalesce((select auth.jwt()) -> 'app_metadata' ->> 'org_role', ''))
        in ('hr', 'system_admin')
      or exists (
        select 1
        from private.internal_org_hr_allowlist hr_rule
        join auth.users member on member.id = (select auth.uid())
        where hr_rule.revoked_at is null
          and member.email_confirmed_at is not null
          and hr_rule.auth_user_id = member.id
      )
      or exists (
        select 1
        from public.profiles profile
        join auth.users member on member.id = profile.id
        where profile.id = (select auth.uid())
          and profile.app_role = 'system_admin'
          and profile.account_status = 'active'
          and profile.login_name is not null
          and member.email_confirmed_at is not null
      )
    );
$$;

comment on function private.is_internal_org_member() is
  'Authorizes internal directory reads from controlled app metadata, confirmed allowlists, or an active confirmed system administrator. Never reads user_metadata.';

comment on function private.is_internal_org_hr() is
  'Authorizes HR capabilities from controlled app metadata, the private confirmed HR allowlist, or an active confirmed system administrator. Never reads user_metadata.';

revoke all on function private.is_internal_org_member() from public, anon, authenticated;
revoke all on function private.is_internal_org_hr() from public, anon, authenticated;

commit;
