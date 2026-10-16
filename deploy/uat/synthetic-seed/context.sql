DO $seed_context$
BEGIN
  IF current_database() <> 'mam_uat_people_hub'
     OR current_setting('server_version_num')::integer / 10000 <> 16
     OR session_user <> 'postgres' OR current_user <> 'postgres'
     OR pg_is_in_recovery()
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper)
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['request.jwt.claims','request.jwt.claim',
          'request.jwt.claim.sub','request.jwt.claim.role','request.jwt.claim.email',
          'request.jwt.claim.iat','request.jwt.claim.exp','request.jwt.claim.iss',
          'request.jwt.claim.aud','request.jwt.claim.session_id','request.jwt.claim.aal',
          'request.jwt.claim.is_anonymous','request.jwt.claim.app_metadata',
          'request.jwt.claim.user_metadata']) AS setting_name
          WHERE nullif(current_setting(setting_name, true), '') IS NOT NULL)
  THEN
    RAISE EXCEPTION 'Unexpected initial UAT seed context' USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.profiles') IS NULL
     OR to_regclass('public.internal_org_people') IS NULL
     OR to_regclass('auth.users') IS NULL OR to_regclass('auth.sessions') IS NULL
     OR to_regclass('private.openclaw_leave_release_gate') IS NULL
     OR to_regclass('private.notification_delivery_control') IS NULL
     OR to_regclass('private.subscription_request_config') IS NULL
     OR to_regclass('private.confirmed_test_purge_schema') IS NULL
     OR to_regclass('private.performance_reviews') IS NULL
     OR to_regclass('private.performance_review_events') IS NULL
     OR to_regclass('private.performance_review_operations') IS NULL
     OR to_regprocedure('private.portal_role_policy(uuid)') IS NULL
     OR to_regprocedure('private.performance_review_actor()') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL
     OR to_regprocedure('auth.jwt()') IS NULL
     OR to_regprocedure('auth.role()') IS NULL
  THEN
    RAISE EXCEPTION 'Reviewed base and performance installation required' USING ERRCODE = '55000';
  END IF;
  IF auth.uid() IS NOT NULL OR nullif(auth.role(), '') IS NOT NULL
     OR coalesce(auth.jwt(), '{}'::jsonb) <> '{}'::jsonb
  THEN
    RAISE EXCEPTION 'Unexpected initial UAT Auth context' USING ERRCODE = '55000';
  END IF;
END
$seed_context$;
