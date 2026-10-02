create table private.portal_account_test_sessions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  ticket_hash text NOT NULL,
  target_user_id uuid NOT NULL,
  target_account_version bigint NOT NULL,
  issued_by uuid NOT NULL,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  redeemed_at timestamp with time zone,
  activated_at timestamp with time zone,
  auth_session_id uuid,
  session_expires_at timestamp with time zone,
  revoked_at timestamp with time zone,
  CONSTRAINT portal_account_test_sessions_auth_session_id_key UNIQUE (auth_session_id),
  CONSTRAINT portal_account_test_sessions_check CHECK ((expires_at > created_at)),
  CONSTRAINT portal_account_test_sessions_check1 CHECK ((expires_at <= (created_at + '00:05:00'::interval))),
  CONSTRAINT portal_account_test_sessions_check2 CHECK (((redeemed_at IS NULL) OR ((redeemed_at >= created_at) AND (redeemed_at <= expires_at)))),
  CONSTRAINT portal_account_test_sessions_check3 CHECK ((((activated_at IS NULL) AND (auth_session_id IS NULL) AND (session_expires_at IS NULL)) OR ((activated_at IS NOT NULL) AND (auth_session_id IS NOT NULL) AND (session_expires_at IS NOT NULL) AND (redeemed_at IS NOT NULL) AND (activated_at >= redeemed_at) AND (session_expires_at > activated_at) AND (session_expires_at <= (activated_at + '00:15:00'::interval))))),
  CONSTRAINT portal_account_test_sessions_check4 CHECK (((revoked_at IS NULL) OR (revoked_at >= created_at))),
  CONSTRAINT portal_account_test_sessions_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT portal_account_test_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT portal_account_test_sessions_target_account_version_check CHECK ((target_account_version > 0)),
  CONSTRAINT portal_account_test_sessions_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT portal_account_test_sessions_ticket_hash_check CHECK ((ticket_hash ~ '^[0-9a-f]{64}$'::text)),
  CONSTRAINT portal_account_test_sessions_ticket_hash_key UNIQUE (ticket_hash)
);
alter table private.portal_account_test_sessions enable row level security;
revoke all on private.portal_account_test_sessions from public,anon,authenticated,service_role;
CREATE TRIGGER reject_retired_test_identity_reference BEFORE INSERT OR UPDATE ON private.portal_account_test_sessions FOR EACH ROW EXECUTE FUNCTION private.reject_retired_test_identity_reference();
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

