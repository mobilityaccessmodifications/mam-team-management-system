SET ROLE supabase_auth_admin;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email text,
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_anonymous boolean,
  encrypted_password text,
  banned_until timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  deleted_at timestamptz
);
CREATE TABLE auth.identities (id uuid PRIMARY KEY, user_id uuid);
CREATE TABLE auth.sessions (id uuid PRIMARY KEY, user_id uuid, created_at timestamptz, not_after timestamptz);
CREATE TABLE auth.schema_migrations (version varchar(255) PRIMARY KEY);
INSERT INTO auth.schema_migrations VALUES ('SQL_ONLY_NOT_A_NATIVE_MIGRATION');
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT NULL::jsonb $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULL::text $$;
RESET ROLE;
