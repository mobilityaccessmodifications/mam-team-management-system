import argparse
import hashlib
import json
import pathlib
import re
import shlex
import subprocess
import sys
import unittest
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'deploy/uat/native-platform'
TARGET = 'mam_uat_people_hub'
ROLES = ['anon', 'authenticated', 'service_role', 'authenticator', 'supabase_auth_admin', 'supabase_storage_admin']
OPTIONS = argparse.Namespace()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class OwnedPostgres:
    def __init__(self, label):
        self.root = OPTIONS.scratch / ('np' + uuid.uuid4().hex[:10])
        self.root.mkdir(mode=0o700)
        self.socket = self.root / 's'
        self.socket.mkdir(mode=0o700)
        self.data = self.root / 'data'
        self.env = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'LANG': 'C', 'HOME': str(self.root), 'PGPASSFILE': str(self.root / 'absent-pgpass'), 'PGSERVICEFILE': str(self.root / 'absent-pgservice')}
        self.auth_password = uuid.uuid4().hex + uuid.uuid4().hex
        self.rest_password = uuid.uuid4().hex + uuid.uuid4().hex
        self.secrets = [self.auth_password, self.rest_password]
        self.sensitive_fragments = [secret[start:start + 16] for secret in self.secrets for start in range(0, len(secret), 16)]
        self.calls = 0
        self.started = False
        self.bootstrap_user = 'sql_only_bootstrap' if label == 'test_rejects_non_super_postgres' else 'postgres'
        self.evidence = OPTIONS.evidence_dir / label
        self.evidence.mkdir(parents=True, exist_ok=False)
        (self.root / 'owner.json').write_text(json.dumps({'task': 'uat-native-platform-sql-only', 'label': label, 'data': str(self.data), 'socket': str(self.socket)}))

    def run(self, executable, args, sql=None, extra_env=None):
        self.calls += 1
        stem = self.evidence / ('%03d-%s' % (self.calls, executable))
        env = dict(self.env)
        env.update(extra_env or {})
        argv = [str(OPTIONS.pg_bin / executable), *args]
        result = subprocess.run(argv, input=sql, text=True, capture_output=True, env=env, timeout=40)
        stem.with_suffix('.stdout.log').write_text(result.stdout)
        stem.with_suffix('.stderr.log').write_text(result.stderr)
        if sql is not None:
            stem.with_suffix('.input.sql').write_text(sql)
        stem.with_suffix('.receipt.json').write_text(json.dumps({'argv': argv, 'exitCode': result.returncode, 'stdoutSha256': hashlib.sha256(result.stdout.encode()).hexdigest(), 'stderrSha256': hashlib.sha256(result.stderr.encode()).hexdigest(), 'inputSha256': hashlib.sha256(sql.encode()).hexdigest() if sql is not None else None}, indent=2) + '\n')
        if any(fragment in result.stdout + result.stderr for fragment in self.sensitive_fragments):
            raise AssertionError('Synthetic password appeared in captured process output; inspect restricted evidence locally')
        return result

    def start(self):
        version = self.run('postgres', ['--version'])
        assert version.returncode == 0 and re.search(r'PostgreSQL\) 16\.', version.stdout), 'Actual PostgreSQL 16 required'
        initialized = self.run('initdb', ['-D', str(self.data), '-U', self.bootstrap_user, '-A', 'trust', '--no-locale', '-E', 'UTF8'])
        assert initialized.returncode == 0, 'Owned initdb failed; inspect retained evidence'
        settings = "-h '' -p 55436 -k %s -c unix_socket_permissions=0700 -c log_statement=none -c log_min_error_statement=panic" % shlex.quote(str(self.socket))
        started = self.run('pg_ctl', ['-D', str(self.data), '-l', str(self.root / 'server.log'), '-o', settings, '-t', '20', '-w', 'start'])
        self.started = started.returncode == 0
        assert self.started, 'Owned socket-only server failed; inspect retained server log'
        assert self.sql("select current_setting('listen_addresses') = '' and inet_server_addr() is null;", database='postgres', user=self.bootstrap_user).stdout.strip() == 't'
        if self.bootstrap_user != 'postgres':
            assert self.sql('create role postgres login nosuperuser;', database='postgres', user=self.bootstrap_user).returncode == 0
        assert self.sql('create database mam_uat_people_hub owner postgres;', database='postgres', user=self.bootstrap_user).returncode == 0

    def sql(self, text, database=TARGET, user='postgres', passwords=True, env=None):
        injected = {'MAM_UAT_AUTH_DB_PASSWORD': self.auth_password, 'MAM_UAT_REST_DB_PASSWORD': self.rest_password} if passwords else {}
        injected.update(env or {})
        return self.run('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', str(self.socket), '-p', '55436', '-U', user, '-d', database, '-f', '-'], text, injected)

    def stop(self):
        if self.started or (self.data / 'postmaster.pid').exists():
            stopped = self.run('pg_ctl', ['-D', str(self.data), '-m', 'fast', '-t', '20', '-w', 'stop'])
            assert stopped.returncode == 0, 'Owned server did not stop'
            self.started = False
        status = self.run('pg_ctl', ['-D', str(self.data), 'status'])
        assert status.returncode == 3 and not (self.socket / '.s.PGSQL.55436').exists(), 'Owned server stop readback failed'
        server_log = self.root / 'server.log'
        if server_log.exists():
            raw = server_log.read_text()
            (self.evidence / 'server.log').write_text(raw)
            assert not any(fragment in raw for fragment in self.sensitive_fragments), 'Synthetic password fragment appeared in server log'
        (self.evidence / 'cluster.json').write_text(json.dumps({'root': str(self.root), 'stopped': not self.started, 'dataRetained': self.data.exists(), 'tcpListeners': False, 'classification': 'SQL_ONLY_SYNTHETIC_NOT_NATIVE'}, indent=2) + '\n')


class PlatformSql(unittest.TestCase):
    def setUp(self):
        self.pg = OwnedPostgres(self._testMethodName)
        self.addCleanup(self.pg.stop)
        self.pg.start()

    def source(self, name):
        path = SOURCE / name
        self.assertTrue(path.is_file(), 'Missing reviewed platform source: ' + name)
        return path.read_text()

    def success(self, result):
        self.assertEqual(result.returncode, 0, 'Command failed; inspect task-owned raw logs')
        return result.stdout.strip()

    def test_init_creates_only_platform_roles_and_empty_storage(self):
        before = self.success(self.pg.sql("select row(rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls)::text from pg_roles where rolname='postgres';"))
        self.success(self.pg.sql(self.source('001-pre-auth.sql')))
        result = json.loads(self.success(self.pg.sql("select json_build_object('roles',(select json_agg(json_build_object('name',rolname,'super',rolsuper,'inherit',rolinherit,'createDb',rolcreatedb,'createRole',rolcreaterole,'replication',rolreplication,'bypass',rolbypassrls,'login',rolcanlogin) order by rolname) from pg_roles where rolname in ('anon','authenticated','service_role','authenticator','supabase_auth_admin','supabase_storage_admin')),'authObjects',(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='auth'),'authHelpers',(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth'),'buckets',(select count(*) from storage.buckets),'objects',(select count(*) from storage.objects));")))
        self.assertEqual({row['name'] for row in result['roles']}, set(ROLES))
        for row in result['roles']:
            for flag in ['super', 'inherit', 'createDb', 'createRole', 'replication']:
                self.assertFalse(row[flag], row['name'] + ':' + flag)
            self.assertEqual(row['bypass'], row['name'] == 'service_role')
            self.assertEqual(row['login'], row['name'] in ['authenticator', 'supabase_auth_admin'])
        self.assertEqual([result[k] for k in ['authObjects', 'authHelpers', 'buckets', 'objects']], [0, 0, 0, 0])
        after = self.success(self.pg.sql("select row(rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls)::text from pg_roles where rolname='postgres';"))
        self.assertEqual(before, after)
        members = json.loads(self.success(self.pg.sql("select json_agg(json_build_object('role',pg_get_userbyid(roleid),'member',pg_get_userbyid(member),'admin',admin_option,'inherit',inherit_option,'set',set_option) order by pg_get_userbyid(roleid)) from pg_auth_members where pg_get_userbyid(member)='authenticator';")))
        self.assertEqual(members, [{'role': name, 'member': 'authenticator', 'admin': False, 'inherit': False, 'set': True} for name in ['anon', 'authenticated', 'service_role']])
        self.assertEqual(self.success(self.pg.sql("select (select pg_get_userbyid(nspowner) from pg_namespace where nspname='auth')='supabase_auth_admin' and (select pg_get_userbyid(nspowner) from pg_namespace where nspname='storage')='supabase_storage_admin' and (select n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto')='extensions' and (select relrowsecurity from pg_class where oid='storage.objects'::regclass);")), 't')
        self.assertEqual(self.success(self.pg.sql("set role service_role; select current_user;", user='authenticator')), 'service_role')
        self.assertNotEqual(self.pg.sql("set role postgres;", user='authenticator').returncode, 0)
        self.assertNotEqual(self.pg.sql("set role supabase_auth_admin;", user='authenticator').returncode, 0)
        self.assertEqual(self.success(self.pg.sql("select storage.foldername('a/b/file.docx')::text;")), '{a,b}')
        columns = json.loads(self.success(self.pg.sql("select json_object_agg(relname, columns) from (select c.relname,json_agg(a.attname::text order by a.attnum) columns from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid where n.nspname='storage' and c.relkind='r' and a.attnum>0 and not a.attisdropped group by c.relname) q;")))
        self.assertEqual(columns, {'buckets': ['id', 'name', 'public', 'file_size_limit', 'allowed_mime_types'], 'objects': ['id', 'bucket_id', 'name', 'owner', 'owner_id', 'metadata', 'created_at', 'updated_at']})
        for name, table in [('service_role', 'storage.buckets'), ('service_role', 'storage.objects'), ('authenticated', 'storage.objects')]:
            self.assertEqual(self.success(self.pg.sql("select bool_and(has_table_privilege('" + name + "','" + table + "', privilege)) from unnest(array['SELECT','INSERT','UPDATE','DELETE']) privilege;")), 't')
        self.assertEqual(self.success(self.pg.sql("select not has_table_privilege('anon','storage.objects','SELECT') and not has_table_privilege('authenticated','storage.buckets','SELECT') and not has_schema_privilege('authenticator','storage','USAGE') and not has_schema_privilege('authenticated','auth','USAGE');")), 't')
        self.success(self.pg.sql('create table public.sql_only_default_acl_probe(id serial); create function public.sql_only_default_acl_probe() returns integer language sql as $$select 1$$;'))
        for name in ['anon', 'authenticated', 'service_role']:
            self.assertEqual(self.success(self.pg.sql("select has_table_privilege('" + name + "','public.sql_only_default_acl_probe','SELECT') and has_sequence_privilege('" + name + "','public.sql_only_default_acl_probe_id_seq','USAGE') and has_function_privilege('" + name + "','public.sql_only_default_acl_probe()','EXECUTE');")), 't')
        self.assertEqual(self.success(self.pg.sql('select count(*) from pg_publication;')), '0')

    def test_post_auth_grants_only_after_provider_shaped_preconditions(self):
        self.success(self.pg.sql(self.source('001-pre-auth.sql')))
        self.success(self.pg.sql((ROOT / 'tests/uat-native-platform-fixture.sql').read_text()))
        provider = "select encode(sha256(convert_to(string_agg(pg_get_functiondef(p.oid)||pg_get_userbyid(p.proowner), E'\\n' order by p.proname),'UTF8')),'hex') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth';"
        before = self.success(self.pg.sql(provider))
        self.success(self.pg.sql(self.source('002-post-auth-grants.sql')))
        self.assertEqual(before, self.success(self.pg.sql(provider)))
        for name in ['anon', 'authenticated', 'service_role']:
            with self.subTest(role=name):
                self.success(self.pg.sql('set role ' + name + '; select auth.uid(),auth.jwt(),auth.role();', user='authenticator'))
                self.assertNotEqual(self.pg.sql('set role ' + name + '; select id from auth.users;', user='authenticator').returncode, 0)
                self.assertNotEqual(self.pg.sql('set role ' + name + '; insert into auth.sessions(id) values(gen_random_uuid());', user='authenticator').returncode, 0)
        self.assertEqual(self.success(self.pg.sql("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth';")), '3')

    def test_readback_is_bounded_read_only_metadata(self):
        self.success(self.pg.sql(self.source('001-pre-auth.sql')))
        self.success(self.pg.sql((ROOT / 'tests/uat-native-platform-fixture.sql').read_text()))
        self.success(self.pg.sql(self.source('002-post-auth-grants.sql')))
        first = self.success(self.pg.sql(self.source('003-readback.sql')))
        second = self.success(self.pg.sql(self.source('003-readback.sql')))
        self.assertEqual(first, second)
        observed = json.loads(first)
        self.assertEqual(observed['database'], TARGET)
        self.assertEqual(observed['postgresMajor'], 16)
        self.assertTrue(observed['readOnly'])
        self.assertEqual(set(observed['rowCounts']), {'auth.users', 'auth.identities', 'auth.sessions', 'auth.schema_migrations', 'storage.buckets', 'storage.objects'})
        self.assertEqual(observed['rowCounts']['auth.schema_migrations'], 1)
        self.assertTrue(all(value == 0 for key, value in observed['rowCounts'].items() if key != 'auth.schema_migrations'))
        for role in observed['roles']:
            self.assertIs(type(role['passwordConfigured']), bool)
            self.assertEqual(role['passwordConfigured'], role['name'] in ['authenticator', 'supabase_auth_admin'])
        self.assertEqual(len(observed['helpers']), 4)
        self.assertTrue(all(re.fullmatch('[0-9a-f]{64}', helper['sha256']) for helper in observed['helpers']))
        self.assertNotIn('definition', first)
        self.assertNotIn('SQL_ONLY_NOT_A_NATIVE_MIGRATION', first)

    def state(self):
        return self.success(self.pg.sql("""select encode(sha256(convert_to(jsonb_build_object(
          'roles',(select jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolcanlogin,rolreplication,rolbypassrls) order by rolname) from pg_roles),
          'schemas',(select jsonb_agg(jsonb_build_array(nspname,pg_get_userbyid(nspowner),nspacl::text) order by nspname) from pg_namespace),
          'classes',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind,pg_get_userbyid(c.relowner),c.relacl::text,c.relrowsecurity) order by n.nspname,c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('auth','storage','extensions','public')),
          'functions',(select jsonb_agg(jsonb_build_array(n.nspname,p.oid::regprocedure::text,pg_get_userbyid(p.proowner),p.prosrc,p.proacl::text) order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('auth','storage','extensions','public')),
          'memberships',(select jsonb_agg(jsonb_build_array(roleid,member,admin_option,inherit_option,set_option) order by roleid,member) from pg_auth_members),
          'defaults',(select jsonb_agg(jsonb_build_array(defaclrole,defaclnamespace,defaclobjtype,defaclacl::text) order by defaclrole,defaclnamespace,defaclobjtype) from pg_default_acl),
          'extensions',(select jsonb_agg(jsonb_build_array(extname,extversion,extowner,extnamespace) order by extname) from pg_extension)
        )::text,'UTF8')),'hex');"""))

    def reject_init(self, setup='', prefix='', database=TARGET, user='postgres', passwords=True, env=None, source=None, expected='Platform initialization requires'):
        if setup:
            self.success(self.pg.sql(setup))
        before = self.state()
        result = self.pg.sql(prefix + (source or self.source('001-pre-auth.sql')), database=database, user=user, passwords=passwords, env=env)
        self.assertEqual(result.returncode, 3, 'Expected psql script rejection; inspect raw logs')
        self.assertIn(expected, result.stderr)
        self.assertEqual(before, self.state(), 'Rejected initialization changed catalog/ACL state')
        return result

    def post_fixture(self):
        self.success(self.pg.sql(self.source('001-pre-auth.sql')))
        self.success(self.pg.sql((ROOT / 'tests/uat-native-platform-fixture.sql').read_text()))

    def reject_post(self, mutation, expected='Missing or incompatible provider Auth helper'):
        self.post_fixture()
        self.success(self.pg.sql(mutation))
        before = self.state()
        result = self.pg.sql(self.source('002-post-auth-grants.sql'))
        self.assertEqual(result.returncode, 3)
        self.assertIn(expected, result.stderr)
        self.assertEqual(before, self.state(), 'Rejected post-Auth grants changed catalog/ACL state')

    def test_rejects_wrong_database_before_password_import(self):
        result = self.reject_init(database='postgres', passwords=False, expected='Fresh UAT PostgreSQL 16 postgres target required')
        self.assertIn('Fresh UAT PostgreSQL 16 postgres target required', result.stderr)
        self.assertNotIn('MAM_UAT_AUTH_DB_PASSWORD', result.stderr)

    def test_rejects_unreviewed_major_predicate_on_actual_pg16(self):
        source = self.source('001-pre-auth.sql')
        self.assertEqual(source.count("::integer / 10000 <> 16"), 1)
        self.reject_init(source=source.replace('::integer / 10000 <> 16', '::integer / 10000 <> 17'), expected='Fresh UAT PostgreSQL 16 postgres target required')

    def test_rejects_non_postgres_session(self):
        self.reject_init(setup='create role sql_only_executor login;', user='sql_only_executor', expected='Fresh UAT PostgreSQL 16 postgres target required')

    def test_rejects_non_super_postgres(self):
        result = self.reject_init(expected='Fresh UAT PostgreSQL 16 postgres target required')
        self.assertIn('Fresh UAT PostgreSQL 16 postgres target required', result.stderr)

    def test_rejects_jwt_context_even_empty(self):
        for setting in ['request.jwt.claim', 'request.jwt.claims', 'request.jwt.claim.sub', 'request.jwt.claim.role', 'request.jwt.claim.email']:
            with self.subTest(setting=setting):
                self.reject_init(prefix="set " + setting + " = '';\n", expected='JWT request context is not an installation context')

    def test_rejects_existing_platform_role(self):
        self.reject_init(setup='create role anon nologin;')

    def test_rejects_unknown_schema(self):
        self.reject_init(setup='create schema sql_only_unknown;')

    def test_rejects_other_database_in_dedicated_cluster(self):
        self.reject_init(setup='create database sql_only_other;')

    def test_rejects_public_create_grant(self):
        self.reject_init(setup='grant create on schema public to public;')

    def test_rejects_public_business_table(self):
        self.reject_init(setup='create table public.sql_only_business(id integer);')

    def test_rejects_public_business_function(self):
        self.reject_init(setup='create function public.sql_only_business() returns integer language sql as $$select 1$$;')

    def test_rejects_public_business_type(self):
        self.reject_init(setup="create type public.sql_only_business as enum('fixture');")

    def test_rejects_public_collation(self):
        self.reject_init(setup='create collation public.sql_only_collation from "C";')

    def test_rejects_repeat_without_changing_roles_or_acls(self):
        self.success(self.pg.sql(self.source('001-pre-auth.sql')))
        self.reject_init()

    def test_rejects_missing_passwords_without_ddl_or_echo(self):
        for env in [{}, {'MAM_UAT_AUTH_DB_PASSWORD': self.pg.auth_password}, {'MAM_UAT_REST_DB_PASSWORD': self.pg.rest_password}]:
            with self.subTest(inputCount=len(env)):
                self.reject_init(passwords=False, env=env, expected='Rejected UAT database password input')

    def test_rejects_empty_short_non_urlsafe_and_equal_passwords(self):
        for first, second in [('', self.pg.rest_password), ('short', self.pg.rest_password), (self.pg.auth_password + "'", self.pg.rest_password), (self.pg.auth_password, self.pg.auth_password), ('x' * 129, self.pg.rest_password)]:
            with self.subTest(inputLengths=[len(first), len(second)]):
                self.reject_init(passwords=False, env={'MAM_UAT_AUTH_DB_PASSWORD': first, 'MAM_UAT_REST_DB_PASSWORD': second}, expected='Rejected UAT database password input')

    def test_mid_transaction_error_rolls_back_roles_namespaces_and_default_acls(self):
        source = self.source('001-pre-auth.sql')
        self.assertEqual(source.count('COMMIT;'), 1)
        self.reject_init(source=source.replace('COMMIT;', "DO $$BEGIN RAISE EXCEPTION 'SQL_ONLY injected failure'; END$$;\nCOMMIT;"), expected='SQL_ONLY injected failure')

    def test_post_auth_missing_helpers_writes_nothing(self):
        self.success(self.pg.sql(self.source('001-pre-auth.sql')))
        before = self.state()
        result = self.pg.sql(self.source('002-post-auth-grants.sql'))
        self.assertEqual(result.returncode, 3)
        self.assertIn('Missing or incompatible provider Auth helper', result.stderr)
        self.assertEqual(before, self.state())

    def test_post_auth_wrong_helper_type_rejected(self):
        self.reject_post('drop function auth.uid(); set role supabase_auth_admin; create function auth.uid() returns text language sql stable as $$select null::text$$; reset role;')

    def test_post_auth_wrong_helper_owner_rejected(self):
        self.reject_post('alter function auth.uid() owner to postgres;')

    def test_post_auth_security_definer_helper_rejected(self):
        self.reject_post('alter function auth.uid() security definer;')

    def test_post_auth_wrong_table_owner_rejected(self):
        self.reject_post('alter table auth.sessions owner to postgres;', expected='Missing provider-owned Auth relation')

    def test_post_auth_missing_dependency_column_rejected(self):
        self.reject_post('alter table auth.sessions drop column not_after;', expected='Missing provider Auth dependency column')

    def test_post_auth_empty_migration_ledger_rejected(self):
        self.reject_post('truncate auth.schema_migrations;', expected='Provider migrations must have run before grants')

    def test_post_auth_existing_user_rejected(self):
        self.reject_post('insert into auth.users(id) values(gen_random_uuid());', expected='Initial Auth business tables must be empty')

    def test_post_auth_existing_session_rejected(self):
        self.reject_post('insert into auth.sessions(id) values(gen_random_uuid());', expected='Initial Auth business tables must be empty')

    def test_post_auth_other_provider_business_rows_rejected(self):
        self.reject_post('set role supabase_auth_admin; create table auth.sql_only_provider_business(id integer); insert into auth.sql_only_provider_business values(1); reset role;', expected='Initial Auth business tables must be empty')

    def test_post_auth_unsafe_membership_rejected(self):
        self.reject_post('grant supabase_auth_admin to authenticator;', expected='Unsafe platform roles or memberships')

    def test_post_auth_mid_transaction_error_rolls_back_schema_and_helper_grants(self):
        self.post_fixture()
        before = self.state()
        source = self.source('002-post-auth-grants.sql')
        self.assertEqual(source.count('COMMIT;'), 1)
        result = self.pg.sql(source.replace('COMMIT;', "DO $$BEGIN RAISE EXCEPTION 'SQL_ONLY injected grant failure'; END$$;\nCOMMIT;"))
        self.assertEqual(result.returncode, 3)
        self.assertIn('SQL_ONLY injected grant failure', result.stderr)
        self.assertEqual(before, self.state())

    def test_bootstrap_finite_preflight_on_sql_only_shape(self):
        self.assertIsNotNone(OPTIONS.bootstrap_preflight, 'Supply reviewed preflight explicitly; no private QA path is hardcoded')
        self.assertEqual(digest(OPTIONS.bootstrap_preflight), OPTIONS.bootstrap_preflight_sha256)
        self.post_fixture()
        self.success(self.pg.sql(self.source('002-post-auth-grants.sql')))
        self.success(self.pg.sql("set mam.uat.bootstrap_target='mam_uat_people_hub'; set mam.uat.bootstrap_mode='native-reviewed';\n" + OPTIONS.bootstrap_preflight.read_text()))


def main():
    global OPTIONS
    parser = argparse.ArgumentParser()
    parser.add_argument('--pg-bin', type=pathlib.Path, required=True)
    parser.add_argument('--scratch', type=pathlib.Path, required=True)
    parser.add_argument('--evidence-dir', type=pathlib.Path, required=True)
    parser.add_argument('--only')
    parser.add_argument('--bootstrap-preflight', type=pathlib.Path)
    parser.add_argument('--bootstrap-preflight-sha256')
    OPTIONS = parser.parse_args()
    OPTIONS.scratch = OPTIONS.scratch.resolve(strict=True)
    OPTIONS.evidence_dir.mkdir(parents=True, exist_ok=True)
    snapshot = OPTIONS.evidence_dir / 'source-snapshot'
    snapshot.mkdir(exist_ok=True)
    paths = [pathlib.Path(__file__), ROOT / 'tests/uat-native-platform-fixture.sql', ROOT / 'tests/uat-native-platform.test.mjs', SOURCE / 'README.md', *SOURCE.glob('*.sql')]
    if OPTIONS.bootstrap_preflight is not None:
        assert digest(OPTIONS.bootstrap_preflight) == OPTIONS.bootstrap_preflight_sha256, 'Unreviewed finite bootstrap preflight'
        (snapshot / 'bootstrap-preflight.sql').write_bytes(OPTIONS.bootstrap_preflight.read_bytes())
        (OPTIONS.evidence_dir / 'bootstrap-input.json').write_text(json.dumps({'path': str(OPTIONS.bootstrap_preflight), 'sha256': OPTIONS.bootstrap_preflight_sha256}, indent=2) + '\n')
    hashes = {}
    for path in paths:
        hashes[str(path.relative_to(ROOT))] = digest(path)
        (snapshot / path.name).write_bytes(path.read_bytes())
    (OPTIONS.evidence_dir / 'source-hashes.json').write_text(json.dumps(hashes, indent=2) + '\n')
    suite = unittest.TestSuite([PlatformSql(OPTIONS.only)]) if OPTIONS.only else unittest.defaultTestLoader.loadTestsFromTestCase(PlatformSql)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    for path in paths:
        assert digest(path) == hashes[str(path.relative_to(ROOT))], 'Source changed during SQL-only tests'
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    sys.exit(main())
