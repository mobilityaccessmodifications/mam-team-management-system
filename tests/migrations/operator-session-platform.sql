-- Owned synthetic platform adaptation only, never a production migration.
-- This reproduces the separately published, approved native Auth-session
-- helper (definition SHA74010df8...) missing from historical local replay.
-- No real actors, actual sessions, credentials or claims are stored here.
do $$ begin
  assert current_database() ~ '^mam_test_';
  assert inet_server_addr() is null;
end $$;
create table auth.sessions (
  id uuid primary key, user_id uuid not null references auth.users(id),
  created_at timestamptz not null, not_after timestamptz
);
alter table auth.users add column deleted_at timestamptz;
create table private.portal_account_test_sessions (
  target_user_id uuid,auth_session_id uuid,activated_at timestamptz,
  revoked_at timestamptz,session_expires_at timestamptz
);
alter table private.portal_account_test_sessions enable row level security;
revoke all on private.portal_account_test_sessions from public,anon,authenticated,service_role;
grant all on private.portal_account_test_sessions to postgres;
CREATE OR REPLACE FUNCTION private.is_active_portal_account(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.profiles profile
    where profile.id = coalesce(p_user_id, (select auth.uid()))
      and profile.login_name is not null
      and profile.account_status = 'active'
      and (
        p_user_id is not null
        or (
          date_trunc('second', profile.credentials_valid_after) <= coalesce(
            to_timestamp(nullif((select auth.jwt()) ->> 'iat', '')::double precision),
            '-infinity'::timestamptz
          )
          and (
            not exists (
              select 1
              from private.portal_account_test_sessions test_session
              where test_session.target_user_id = profile.id
                and test_session.auth_session_id::text = nullif((select auth.jwt()) ->> 'session_id', '')
            )
            or exists (
              select 1
              from private.portal_account_test_sessions test_session
              where test_session.target_user_id = profile.id
                and test_session.auth_session_id::text = nullif((select auth.jwt()) ->> 'session_id', '')
                and test_session.activated_at is not null
                and test_session.revoked_at is null
                and test_session.session_expires_at > statement_timestamp()
            )
          )
        )
      )
  );
$function$
;
