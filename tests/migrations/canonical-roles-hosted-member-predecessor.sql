-- CI structure-only reproduction of the approved unrecorded hosted predecessor.
-- Source roles-live-type-member-readonly.private.json SHA256 730525a40f27bd38f80f5dbdb34afd81c58f03a3818b83cbfff5ebd7cd18e733.
-- COORD-20261006-ROLES-LIVE-GUARD-DECISION-1; replaced by the unchanged canonical policy in 104000.
do $$ begin assert current_database() ~ '^mam_test_' and inet_server_addr() is null; end $$;
CREATE OR REPLACE FUNCTION private.is_internal_org_member()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;
