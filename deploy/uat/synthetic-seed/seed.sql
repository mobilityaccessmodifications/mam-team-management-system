BEGIN;
SET LOCAL search_path = '';
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
__CONTEXT__
DO $seed_lock$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('mam:uat-native-initial-seed', 0)) THEN
    RAISE EXCEPTION 'Initial UAT seed already in progress' USING ERRCODE = '55000';
  END IF;
END
$seed_lock$;
LOCK TABLE auth.users, auth.sessions, public.profiles, public.internal_org_people,
  private.openclaw_leave_release_gate, private.notification_delivery_control,
  private.subscription_request_config, private.confirmed_test_purge_schema
  IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE uat_seed_fixture (
  ordinal integer PRIMARY KEY, fixture_key text UNIQUE NOT NULL,
  auth_user_id uuid UNIQUE NOT NULL, email text UNIQUE NOT NULL,
  full_name text NOT NULL, app_role text NOT NULL,
  person_id uuid UNIQUE, company_key text, parent_id uuid
) ON COMMIT DROP;
INSERT INTO pg_temp.uat_seed_fixture VALUES
__VALUES__;
CREATE TEMP TABLE uat_seed_controls ON COMMIT DROP AS
__CONTROLS__;
DO $seed_preflight$
BEGIN
  IF (SELECT count(*) FROM pg_temp.uat_seed_fixture) <> 10
     OR EXISTS (SELECT 1 FROM pg_temp.uat_seed_fixture f
        WHERE NOT private.is_valid_portal_login(f.email)
           OR f.app_role NOT IN ('employee','manager','account','admin','system_admin')
           OR f.person_id = f.auth_user_id
           OR EXISTS (SELECT 1 FROM pg_temp.uat_seed_fixture a WHERE a.auth_user_id = f.person_id))
     OR EXISTS (SELECT 1 FROM pg_temp.uat_seed_fixture f WHERE f.parent_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pg_temp.uat_seed_fixture m
          WHERE m.person_id = f.parent_id AND m.person_id <> f.person_id
            AND m.company_key = f.company_key AND m.app_role = 'manager'))
  THEN
    RAISE EXCEPTION 'Invalid closed synthetic directory' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles)
     OR EXISTS (SELECT 1 FROM public.internal_org_people)
     OR EXISTS (SELECT 1 FROM private.performance_reviews)
     OR EXISTS (SELECT 1 FROM private.performance_review_events)
     OR EXISTS (SELECT 1 FROM private.performance_review_operations)
     OR (SELECT count(*) FROM auth.users) <> 10
     OR EXISTS (SELECT 1 FROM auth.sessions)
     OR (SELECT count(*) FROM auth.users u JOIN pg_temp.uat_seed_fixture f
          ON u.id = f.auth_user_id AND u.email = f.email
          WHERE u.email_confirmed_at IS NOT NULL AND u.is_anonymous IS FALSE
            AND u.deleted_at IS NULL AND u.last_sign_in_at IS NULL
            AND nullif(u.encrypted_password, '') IS NOT NULL
            AND u.created_at IS NOT NULL AND u.created_at <= clock_timestamp()
            AND (u.banned_until IS NULL OR u.banned_until <= clock_timestamp())
            AND u.raw_app_meta_data->>'provider' = 'email'
            AND u.raw_app_meta_data->'providers' = '["email"]'::jsonb
            AND NOT u.raw_app_meta_data ? 'org_role') <> 10
  THEN
    RAISE EXCEPTION 'Ten new confirmed password identities and empty application required' USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM private.openclaw_leave_release_gate) <> 1
     OR NOT EXISTS (SELECT 1 FROM private.openclaw_leave_release_gate WHERE singleton AND NOT enabled)
     OR (SELECT count(*) FROM private.notification_delivery_control) <> 1
     OR NOT EXISTS (SELECT 1 FROM private.notification_delivery_control
       WHERE singleton AND NOT ready AND legacy_import_sha256 IS NULL
         AND legacy_import_count IS NULL AND legacy_imported_at IS NULL)
     OR (SELECT count(*) FROM private.subscription_request_config) <> 1
     OR NOT EXISTS (SELECT 1 FROM private.subscription_request_config
       WHERE singleton AND NOT enabled AND approver_user_id IS NULL AND approver_person_id IS NULL)
     OR (SELECT count(*) FROM private.confirmed_test_purge_schema) <> 1
     OR NOT EXISTS (SELECT 1 FROM private.confirmed_test_purge_schema WHERE singleton AND schema_hash IS NOT NULL)
  THEN
    RAISE EXCEPTION 'Fresh inert UAT controls required' USING ERRCODE = '55000';
  END IF;
END
$seed_preflight$;
INSERT INTO public.profiles
  (id, full_name, app_role, login_name, account_status, must_change_password,
   disabled_at, credentials_valid_after, account_version, timezone)
SELECT auth_user_id, full_name, app_role, email, 'active', false,
       NULL, clock_timestamp(), 1, 'Australia/Melbourne'
FROM pg_temp.uat_seed_fixture ORDER BY ordinal;
DO $seed_people$
DECLARE fixture record;
BEGIN
  FOR fixture IN SELECT * FROM pg_temp.uat_seed_fixture WHERE person_id IS NOT NULL ORDER BY ordinal LOOP
    INSERT INTO public.internal_org_people
      (id, node_kind, company_key, full_name, position_title, auth_user_id, parent_id,
       started_date, sort_order, is_active, version, created_by, updated_by)
    VALUES (fixture.person_id, 'person', fixture.company_key, fixture.full_name,
      'Synthetic UAT role', fixture.auth_user_id, fixture.parent_id,
      NULL, 0, true, 1, NULL, NULL);
  END LOOP;
END
$seed_people$;
SET CONSTRAINTS ALL IMMEDIATE;
CREATE TEMP TABLE uat_seed_verified ON COMMIT DROP AS
__VERIFY__;
DO $seed_verified$
BEGIN
  IF (SELECT count(*) FROM pg_temp.uat_seed_verified) <> 10
     OR EXISTS (SELECT 1 FROM pg_temp.uat_seed_verified WHERE NOT row_matches)
     OR (SELECT count(*) FROM public.profiles) <> 10
     OR (SELECT count(*) FROM public.internal_org_people) <> 9
     OR EXISTS (SELECT 1 FROM private.performance_reviews)
     OR EXISTS (SELECT 1 FROM private.performance_review_events)
     OR EXISTS (SELECT 1 FROM private.performance_review_operations)
     OR EXISTS (SELECT 1 FROM auth.sessions)
  THEN
    RAISE EXCEPTION 'Initial synthetic directory readback mismatch' USING ERRCODE = '55000';
  END IF;
  IF (SELECT state FROM pg_temp.uat_seed_controls) IS DISTINCT FROM (__CONTROLS_SCALAR__) THEN
    RAISE EXCEPTION 'Inert UAT controls changed' USING ERRCODE = '55000';
  END IF;
END
$seed_verified$;
COMMIT;
