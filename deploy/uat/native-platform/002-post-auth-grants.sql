\set ON_ERROR_STOP on
\set ECHO none
\set VERBOSITY terse
\set SHOW_CONTEXT never
BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $guard$
DECLARE
  required record;
  relation record;
  occupied boolean;
BEGIN
  IF current_database() <> 'mam_uat_people_hub'
     OR current_setting('server_version_num')::integer / 10000 <> 16
     OR current_user <> 'postgres' OR session_user <> 'postgres'
     OR current_setting('role') <> 'none' OR pg_is_in_recovery()
     OR NOT (SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres') THEN
    RAISE EXCEPTION 'UAT PostgreSQL 16 postgres grant context required' USING ERRCODE = '55000';
  END IF;
  IF current_setting('request.jwt.claim', true) IS NOT NULL
     OR current_setting('request.jwt.claims', true) IS NOT NULL
     OR current_setting('request.jwt.claim.sub', true) IS NOT NULL
     OR current_setting('request.jwt.claim.role', true) IS NOT NULL
     OR current_setting('request.jwt.claim.email', true) IS NOT NULL THEN
    RAISE EXCEPTION 'JWT request context is not an installation context' USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'authenticator', 'supabase_auth_admin', 'supabase_storage_admin')) <> 6
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'authenticator', 'supabase_auth_admin', 'supabase_storage_admin')
       AND (rolsuper OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication
         OR rolbypassrls IS DISTINCT FROM (rolname = 'service_role')
         OR rolcanlogin IS DISTINCT FROM (rolname IN ('authenticator', 'supabase_auth_admin'))))
     OR (SELECT count(*) FROM pg_auth_members WHERE pg_get_userbyid(member) = 'authenticator') <> 3
     OR EXISTS (SELECT 1 FROM pg_auth_members
       WHERE (pg_get_userbyid(roleid) IN ('anon', 'authenticated', 'service_role', 'authenticator', 'supabase_auth_admin', 'supabase_storage_admin')
          OR pg_get_userbyid(member) IN ('anon', 'authenticated', 'service_role', 'authenticator', 'supabase_auth_admin', 'supabase_storage_admin'))
       AND NOT (pg_get_userbyid(member) = 'authenticator' AND pg_get_userbyid(roleid) IN ('anon', 'authenticated', 'service_role') AND NOT admin_option AND NOT inherit_option AND set_option)) THEN
    RAISE EXCEPTION 'Unsafe platform roles or memberships' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth' AND pg_get_userbyid(nspowner) = 'supabase_auth_admin')
     OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'public', 'auth', 'storage', 'extensions'))
     OR EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace)
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace)
     OR EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'Native Auth owner and pre-application target required' USING ERRCODE = '55000';
  END IF;
  FOR required IN SELECT * FROM (VALUES ('uid', 'uuid'::regtype), ('jwt', 'jsonb'::regtype), ('role', 'text'::regtype)) AS helpers(name, result_type) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = 'auth' AND p.proname = required.name AND p.pronargs = 0 AND p.prokind = 'f'
        AND p.prorettype = required.result_type AND NOT p.proretset AND NOT p.prosecdef
        AND p.provolatile = 's' AND l.lanname = 'sql' AND pg_get_userbyid(p.proowner) = 'supabase_auth_admin') THEN
      RAISE EXCEPTION 'Missing or incompatible provider Auth helper' USING ERRCODE = '55000';
    END IF;
  END LOOP;
  FOR required IN SELECT unnest(ARRAY['users', 'identities', 'sessions', 'schema_migrations']) AS name LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'auth' AND c.relname = required.name AND c.relkind = 'r' AND pg_get_userbyid(c.relowner) = 'supabase_auth_admin') THEN
      RAISE EXCEPTION 'Missing provider-owned Auth relation' USING ERRCODE = '55000';
    END IF;
  END LOOP;
  FOR required IN SELECT * FROM (VALUES
    ('users', 'id', 'uuid'), ('users', 'email', 'text'),
    ('users', 'email_confirmed_at', 'timestamp with time zone'),
    ('users', 'raw_app_meta_data', 'jsonb'), ('users', 'raw_user_meta_data', 'jsonb'),
    ('users', 'is_anonymous', 'boolean'), ('users', 'encrypted_password', 'text'),
    ('users', 'banned_until', 'timestamp with time zone'), ('users', 'created_at', 'timestamp with time zone'),
    ('users', 'updated_at', 'timestamp with time zone'), ('users', 'deleted_at', 'timestamp with time zone'),
    ('sessions', 'id', 'uuid'), ('sessions', 'user_id', 'uuid'),
    ('sessions', 'created_at', 'timestamp with time zone'), ('sessions', 'not_after', 'timestamp with time zone')
  ) AS columns(relation_name, name, type_name) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'auth' AND c.relname = required.relation_name AND a.attname = required.name AND a.attnum > 0 AND NOT a.attisdropped
        AND (format_type(a.atttypid, a.atttypmod) = required.type_name OR (required.type_name = 'text' AND a.atttypid = 'varchar'::regtype))) THEN
      RAISE EXCEPTION 'Missing provider Auth dependency column' USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM auth.schema_migrations) THEN
    RAISE EXCEPTION 'Provider migrations must have run before grants' USING ERRCODE = '55000';
  END IF;
  FOR relation IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'auth' AND c.relkind IN ('r', 'p') AND c.relname <> 'schema_migrations' LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM auth.%I)', relation.relname) INTO occupied;
    IF occupied THEN
      RAISE EXCEPTION 'Initial Auth business tables must be empty' USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM storage.buckets) OR EXISTS (SELECT 1 FROM storage.objects) THEN
    RAISE EXCEPTION 'Initial Storage compatibility tables must be empty' USING ERRCODE = '55000';
  END IF;
END
$guard$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt(), auth.role() TO anon, authenticated, service_role;
COMMIT;
