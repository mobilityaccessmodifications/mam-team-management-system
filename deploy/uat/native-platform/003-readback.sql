\set ON_ERROR_STOP on
\set ECHO none
\set VERBOSITY terse
\set SHOW_CONTEXT never
BEGIN READ ONLY;
SET LOCAL search_path = pg_catalog;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
DO $guard$
BEGIN
  IF current_database() <> 'mam_uat_people_hub'
     OR current_setting('server_version_num')::integer / 10000 <> 16
     OR current_user <> 'postgres' OR session_user <> 'postgres'
     OR current_setting('role') <> 'none'
     OR NOT (SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres') THEN
    RAISE EXCEPTION 'UAT PostgreSQL 16 postgres readback context required' USING ERRCODE = '55000';
  END IF;
END
$guard$;
SELECT jsonb_build_object(
  'database', current_database(),
  'postgresMajor', current_setting('server_version_num')::integer / 10000,
  'readOnly', current_setting('transaction_read_only') = 'on',
  'roles', (SELECT jsonb_agg(jsonb_build_object(
    'name', r.rolname, 'super', r.rolsuper, 'inherit', r.rolinherit, 'createDb', r.rolcreatedb,
    'createRole', r.rolcreaterole, 'login', r.rolcanlogin, 'replication', r.rolreplication,
    'bypassRls', r.rolbypassrls,
    'passwordConfigured', EXISTS (SELECT 1 FROM pg_authid a WHERE a.oid = r.oid AND a.rolpassword IS NOT NULL)
  ) ORDER BY r.rolname) FROM pg_roles r WHERE r.rolname IN ('postgres', 'anon', 'authenticated', 'service_role', 'authenticator', 'supabase_auth_admin', 'supabase_storage_admin')),
  'memberships', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'role', pg_get_userbyid(roleid), 'member', pg_get_userbyid(member),
    'admin', admin_option, 'inherit', inherit_option, 'set', set_option
  ) ORDER BY pg_get_userbyid(member), pg_get_userbyid(roleid)), '[]'::jsonb) FROM pg_auth_members
    WHERE pg_get_userbyid(roleid) IN ('anon', 'authenticated', 'service_role', 'authenticator', 'supabase_auth_admin', 'supabase_storage_admin')
       OR pg_get_userbyid(member) IN ('anon', 'authenticated', 'service_role', 'authenticator', 'supabase_auth_admin', 'supabase_storage_admin')),
  'schemas', (SELECT jsonb_agg(jsonb_build_object('name', nspname, 'owner', pg_get_userbyid(nspowner), 'acl', nspacl::text) ORDER BY nspname)
    FROM pg_namespace WHERE nspname IN ('public', 'auth', 'storage', 'extensions')),
  'relations', (SELECT jsonb_agg(jsonb_build_object('name', n.nspname || '.' || c.relname, 'owner', pg_get_userbyid(c.relowner), 'kind', c.relkind, 'rls', c.relrowsecurity, 'acl', c.relacl::text) ORDER BY n.nspname, c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE (n.nspname = 'auth' AND c.relname IN ('users', 'identities', 'sessions', 'schema_migrations'))
       OR (n.nspname = 'storage' AND c.relname IN ('buckets', 'objects'))),
  'columns', (SELECT jsonb_agg(jsonb_build_object('relation', n.nspname || '.' || c.relname, 'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'notNull', a.attnotnull) ORDER BY n.nspname, c.relname, a.attnum)
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE a.attnum > 0 AND NOT a.attisdropped AND (
      (n.nspname = 'auth' AND c.relname = 'users' AND a.attname IN ('id', 'email', 'email_confirmed_at', 'raw_app_meta_data', 'raw_user_meta_data', 'is_anonymous', 'encrypted_password', 'banned_until', 'created_at', 'updated_at', 'deleted_at'))
      OR (n.nspname = 'auth' AND c.relname = 'sessions' AND a.attname IN ('id', 'user_id', 'created_at', 'not_after'))
      OR (n.nspname = 'storage' AND c.relname = 'buckets' AND a.attname IN ('id', 'name', 'public', 'file_size_limit', 'allowed_mime_types'))
      OR (n.nspname = 'storage' AND c.relname = 'objects' AND a.attname IN ('id', 'bucket_id', 'name', 'owner', 'owner_id', 'metadata', 'created_at', 'updated_at')))),
  'helpers', (SELECT jsonb_agg(jsonb_build_object(
    'identity', p.oid::regprocedure::text, 'owner', pg_get_userbyid(p.proowner),
    'returns', format_type(p.prorettype, NULL), 'acl', p.proacl::text,
    'sha256', encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex')
  ) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE (n.nspname = 'auth' AND p.proname IN ('uid', 'jwt', 'role') AND p.pronargs = 0 AND p.prokind = 'f')
       OR (n.nspname = 'storage' AND p.oid = to_regprocedure('storage.foldername(text)'))),
  'defaultAcl', (SELECT coalesce(jsonb_agg(jsonb_build_object('owner', pg_get_userbyid(d.defaclrole), 'schema', n.nspname, 'kind', d.defaclobjtype, 'acl', d.defaclacl::text) ORDER BY n.nspname, pg_get_userbyid(d.defaclrole), d.defaclobjtype), '[]'::jsonb)
    FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace WHERE n.nspname IN ('public', 'auth', 'storage', 'extensions')),
  'pgcrypto', (SELECT jsonb_build_object('version', e.extversion, 'schema', n.nspname, 'owner', pg_get_userbyid(e.extowner)) FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pgcrypto'),
  'rowCounts', jsonb_build_object(
    'auth.users', (SELECT count(*) FROM auth.users), 'auth.identities', (SELECT count(*) FROM auth.identities),
    'auth.sessions', (SELECT count(*) FROM auth.sessions), 'auth.schema_migrations', (SELECT count(*) FROM auth.schema_migrations),
    'storage.buckets', (SELECT count(*) FROM storage.buckets), 'storage.objects', (SELECT count(*) FROM storage.objects))
);
COMMIT;
