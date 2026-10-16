\set ON_ERROR_STOP on
\set ECHO none
\set VERBOSITY terse
\set SHOW_CONTEXT never
BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF current_database() <> 'mam_uat_people_hub'
     OR current_setting('server_version_num')::integer / 10000 <> 16
     OR current_user <> 'postgres' OR session_user <> 'postgres'
     OR current_setting('role') <> 'none' OR pg_is_in_recovery()
     OR NOT (SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres')
     OR (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) <> 'postgres' THEN
    RAISE EXCEPTION 'Fresh UAT PostgreSQL 16 postgres target required' USING ERRCODE = '55000';
  END IF;
  IF current_setting('request.jwt.claim', true) IS NOT NULL
     OR current_setting('request.jwt.claims', true) IS NOT NULL
     OR current_setting('request.jwt.claim.sub', true) IS NOT NULL
     OR current_setting('request.jwt.claim.role', true) IS NOT NULL
     OR current_setting('request.jwt.claim.email', true) IS NOT NULL THEN
    RAISE EXCEPTION 'JWT request context is not an installation context' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname <> 'postgres' AND rolname !~ '^pg_')
     OR EXISTS (SELECT 1 FROM pg_auth_members WHERE pg_get_userbyid(roleid) !~ '^pg_' OR pg_get_userbyid(member) !~ '^pg_')
     OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'public'))
     OR NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'public' AND pg_get_userbyid(nspowner) IN ('postgres', 'pg_database_owner'))
     OR EXISTS (SELECT 1 FROM pg_database WHERE datname NOT IN ('postgres', 'template0', 'template1', 'mam_uat_people_hub'))
     OR EXISTS (SELECT 1 FROM pg_depend WHERE refclassid = 'pg_namespace'::regclass AND refobjid = 'public'::regnamespace)
     OR EXISTS (SELECT 1 FROM pg_namespace n, LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
       WHERE n.nspname = 'public' AND (a.grantee NOT IN (0, n.nspowner) OR (a.grantee = 0 AND (a.privilege_type <> 'USAGE' OR a.is_grantable))))
     OR EXISTS (SELECT 1 FROM pg_default_acl)
     OR EXISTS (SELECT 1 FROM pg_event_trigger)
     OR EXISTS (SELECT 1 FROM pg_publication)
     OR EXISTS (SELECT 1 FROM pg_foreign_server)
     OR EXISTS (SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql' OR extnamespace <> 'pg_catalog'::regnamespace OR pg_get_userbyid(extowner) <> 'postgres') THEN
    RAISE EXCEPTION 'Platform initialization requires a fresh dedicated cluster and empty application database' USING ERRCODE = '55000';
  END IF;
END
$guard$;

SET LOCAL log_statement = 'none';
SET LOCAL log_min_error_statement = 'panic';
SET LOCAL log_min_duration_statement = -1;
SET LOCAL log_min_duration_sample = -1;
SET LOCAL log_parameter_max_length = 0;
SET LOCAL log_parameter_max_length_on_error = 0;
SET LOCAL password_encryption = 'scram-sha-256';
\set _uat_auth_password ''
\set _uat_rest_password ''
\getenv _uat_auth_password MAM_UAT_AUTH_DB_PASSWORD
\getenv _uat_rest_password MAM_UAT_REST_DB_PASSWORD
SELECT (:'_uat_auth_password' ~ '^[A-Za-z0-9_-]{43,128}$'
    AND :'_uat_rest_password' ~ '^[A-Za-z0-9_-]{43,128}$'
    AND :'_uat_auth_password' <> :'_uat_rest_password') AS _uat_passwords_valid \gset
\if :_uat_passwords_valid
\else
DO $invalid$ BEGIN RAISE EXCEPTION 'Rejected UAT database password input' USING ERRCODE = '22023'; END $invalid$;
\endif

CREATE ROLE anon NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'_uat_rest_password';
CREATE ROLE supabase_auth_admin LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'_uat_auth_password';
CREATE ROLE supabase_storage_admin NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
\unset _uat_auth_password
\unset _uat_rest_password
\unset _uat_passwords_valid
GRANT anon, authenticated, service_role TO authenticator WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;

CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
ALTER ROLE supabase_auth_admin SET search_path = auth;
CREATE SCHEMA extensions AUTHORIZATION postgres;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE SCHEMA storage AUTHORIZATION supabase_storage_admin;
SET LOCAL ROLE supabase_storage_admin;
CREATE TABLE storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  public boolean DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets(id),
  name text,
  owner uuid,
  owner_id text,
  metadata jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (bucket_id, name)
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1]
$$;
RESET ROLE;
GRANT USAGE ON SCHEMA public, storage, extensions TO anon, authenticated, service_role;
GRANT ALL ON TABLE storage.buckets, storage.objects TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE storage.objects TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
COMMIT;
