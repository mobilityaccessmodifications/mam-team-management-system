import hashlib
import importlib.util
import tempfile
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'deploy/uat/bootstrap-source/bootstrap.py'


class SourceBootstrapTests(unittest.TestCase):
    def module(self):
        spec = importlib.util.spec_from_file_location('uat_source_bootstrap', CLI)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_target_gate_refuses_foreign_socket_database_and_unowned_marker(self):
        module = self.module()
        self.assertTrue(callable(getattr(module, 'owned_target', None)), 'Missing fail-closed owned-target gate')
        with tempfile.TemporaryDirectory(prefix='uat-source-target-', dir=os.environ['TMPDIR']) as directory:
            root = Path(directory)
            candidate = root/'mam-openclaw-pg.ABC123'
            candidate.mkdir()
            marker = {'owner':'mam-local-tests-v1', 'socket':str(candidate), 'port':55439}
            (candidate/'mam-test-cluster.json').write_text(json.dumps(marker))
            allowed = [{'socket':str(candidate), 'database':'mam_test_uat_target', 'marker':marker}]
            for socket, database, owned in [
                ('postgresql://localhost/production', 'mam_test_uat_target', allowed),
                (str(candidate), 'postgres', allowed),
                (str(candidate), 'mam_test_unknown', allowed),
                (str(candidate), 'mam_test_uat_target', []),
                (str(candidate), 'mam_test_uat_target', allowed),
            ]:
                with self.subTest(socket=socket, database=database):
                    with self.assertRaisesRegex(ValueError, 'owned|ownership|socket|synthetic'):
                        module.owned_target(socket, database, owned)

    def test_schema_artifact_excludes_fake_auth_data_and_history_but_keeps_real_app_bodies(self):
        module = self.module()
        self.assertTrue(callable(getattr(module, 'validate_schema_sql', None)), 'Missing schema-only artifact validator')
        valid = '''-- schema-only
SET search_path = '';
CREATE SCHEMA private;
CREATE TABLE public.profiles(id uuid REFERENCES auth.users(id));
CREATE FUNCTION private.example() RETURNS void LANGUAGE plpgsql AS $body$
BEGIN INSERT INTO public.profiles VALUES(auth.uid()); END
$body$;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON TABLE public.profiles TO authenticated;
'''
        self.assertGreater(module.validate_schema_sql(valid), 0)
        for prohibited in [
            'CREATE SCHEMA auth;',
            'CREATE SCHEMA "auth";',
            'CREATE TABLE auth.users(id uuid);',
            'CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$select null::uuid$$;',
            'CREATE OR REPLACE FUNCTION "auth"."jwt"() RETURNS jsonb LANGUAGE sql AS $$select null$$;',
            'ALTER TABLE auth.users ADD COLUMN deleted_at timestamptz;',
            'CREATE TABLE auth.sessions(id uuid);',
            "INSERT INTO public.profiles(id) VALUES(gen_random_uuid());",
            "COPY public.profiles(id) FROM stdin;",
            "UPDATE private.confirmed_test_purge_schema SET schema_hash='anything';",
            'DELETE FROM public.profiles;',
            "INSERT INTO supabase_migrations.schema_migrations VALUES('20261016');",
            'CREATE SCHEMA supabase_migrations;',
            'DO $$BEGIN EXECUTE \'CREATE SCHEMA auth\'; END$$;',
            r'\connect production'+'\n',
        ]:
            with self.subTest(sql=prohibited[:80]):
                with self.assertRaisesRegex(ValueError, 'schema-only|Auth|history|psql|scope'):
                    module.validate_schema_sql(valid + prohibited)

    def test_replay_admission_requires_real_success_complete_order_and_source_bindings(self):
        module = self.module()
        self.assertTrue(callable(getattr(module, 'admit_replay', None)), 'Missing full-replay admission gate')
        with tempfile.TemporaryDirectory(prefix='uat-source-receipt-', dir=os.environ['TMPDIR']) as directory:
            root = Path(directory)
            output = root/'out.log'
            error = root/'err.log'
            output.write_text('PASS: executed all 195 ordered migrations without changing their bytes\n')
            error.write_text('')
            def binding(p):
                raw = p.read_bytes()
                return {'path':str(p), 'bytes':len(raw), 'sha256':hashlib.sha256(raw).hexdigest()}
            receipt = {'actualExitCode':0,'command':['node','scripts/test-migration-replay.mjs','/foreign','mam_test_unknown'], 'cwd':str(ROOT), 'stdout':binding(output),'stderr':binding(error)}
            capture = {'sourceHashesBefore':{},'sourceHashesAfter':{}}
            sources = {'inputs':{'scripts/test-migration-replay.mjs':{'sha256':'a'*64}},'common':{},'migrations':[]}
            with self.assertRaisesRegex(ValueError, 'replay|Replay|source|Source'):
                module.admit_replay(receipt, capture, sources, '/foreign', 'mam_test_unknown')
            receipt['actualExitCode'] = 1
            with self.assertRaisesRegex(ValueError, 'replay|Replay|source|Source'):
                module.admit_replay(receipt, capture, sources, '/foreign', 'mam_test_unknown')

    def test_build_rejects_unowned_or_unproven_sources_before_writing_artifacts(self):
        module = self.module()
        self.assertTrue(callable(getattr(module, 'build', None)), 'Missing executable schema artifact builder')
        with tempfile.TemporaryDirectory(prefix='uat-source-build-', dir=os.environ['TMPDIR']) as directory:
            output = Path(directory)/'artifact'
            with self.assertRaisesRegex(ValueError, 'owned|ownership|socket|replay'):
                module.build('/foreign', 'mam_test_uat_source', [], {}, {}, output)
            self.assertFalse(output.exists(), 'Unadmitted source must not create a schema artifact')

    def test_installer_rejects_foreign_target_and_unbound_package_before_dispatch(self):
        module = self.module()
        self.assertTrue(callable(getattr(module, 'install', None)), 'Missing guarded SQL-only installer and readback')
        with tempfile.TemporaryDirectory(prefix='uat-source-install-', dir=os.environ['TMPDIR']) as directory:
            with self.assertRaisesRegex(ValueError, 'owned|ownership|socket'):
                module.install('/foreign', 'production', [], Path(directory), '0'*64, '0'*64, Path(directory)/'logs')
            self.assertFalse((Path(directory)/'logs').exists())

    def test_dump_normalization_omits_only_initdb_public_create_not_function_body(self):
        module = self.module()
        self.assertTrue(callable(getattr(module, 'application_dump', None)), 'Missing guarded initdb-public normalization')
        raw = '''-- untouched header
CREATE SCHEMA private;
CREATE SCHEMA public;
CREATE FUNCTION private.literal() RETURNS text LANGUAGE sql AS $body$
select 'CREATE SCHEMA public;';
$body$;
-- untouched footer
'''
        expected = raw.replace('\nCREATE SCHEMA public;\n','\n',1)
        self.assertEqual(module.application_dump(raw),expected)
        with self.assertRaisesRegex(ValueError,'public'):
            module.application_dump(raw.replace('\nCREATE SCHEMA public;\n','\n'))

    def test_source_spellings_restore_between_and_row_distinct_without_changing_guards(self):
        module = self.module()
        self.assertTrue(callable(getattr(module,'restore_source_spellings',None)), 'Missing source-bound dump roundtrip restoration')
        constraint = {'relation':'private.leave_accrual_policies','name':'leave_accrual_policies_weekdays_check','definition':'CHECK ((((cardinality(weekdays) >= 1) AND (cardinality(weekdays) <= 7)) AND (weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7])))'}
        sql = 'CREATE TABLE private.leave_accrual_policies (weekdays integer[], CONSTRAINT leave_accrual_policies_weekdays_check '+constraint['definition']+');\n'
        model = {'constraints':[constraint],'triggers':[],'relations':[]}
        restored,evidence = module.restore_source_spellings(sql,model)
        self.assertIn('cardinality(weekdays) BETWEEN 1 AND 7',restored)
        self.assertIn('weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]',restored)
        self.assertEqual(len(evidence),1)
        with self.assertRaisesRegex(ValueError,'source|Source|constraint'):
            module.restore_source_spellings(sql.replace('>= 1','>= 0'),model)

    def test_new_target_preflight_rejects_unknown_namespaces_and_provider_business_rows(self):
        module=self.module()
        with tempfile.TemporaryDirectory(prefix='uat-source-fresh-gate-',dir=os.environ['TMPDIR']) as directory:
            module.write_installer(Path(directory),{'relations':[]},{'triggers':[],'policies':[]},{'tables':[]},16)
            sql=(Path(directory)/'preflight.sql').read_text()
            self.assertIn('Unreviewed schema in new UAT target',sql)
            self.assertIn('Existing provider business rows',sql)
            self.assertIn("('auth','schema_migrations'),('storage','migrations')",sql)

    def test_source_manifest_binds_the_195_unchanged_migrations_and_common_inputs(self):
        self.assertTrue(CLI.is_file(), 'Missing executable UAT source-schema builder')
        result = subprocess.run([sys.executable, str(CLI), 'sources'], cwd=ROOT,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads(result.stdout)
        self.assertEqual(manifest['base'], 'ff9da87f8d4c5b9b98e7d499e2b21cc91fc09541')
        migrations = manifest['migrations']
        self.assertEqual(len(migrations), 195)
        self.assertEqual(len({entry['path'] for entry in migrations}), 195)
        self.assertEqual([entry['path'] for entry in migrations], sorted(entry['path'] for entry in migrations))
        for entry in migrations:
            raw = (ROOT / entry['path']).read_bytes()
            original = subprocess.check_output(['git', 'show', manifest['base'] + ':' + entry['path']], cwd=ROOT)
            self.assertEqual(raw, original)
            self.assertEqual(hashlib.sha256(raw).hexdigest(), entry['sha256'])
            self.assertEqual(len(raw), entry['bytes'])
        common = json.loads((ROOT / 'qa-evidence/uat-20261016/common-source-pins.json').read_text())
        self.assertEqual(manifest['common'], common['files'])
        self.assertIn('scripts/test-migration-replay.mjs', manifest['inputs'])
        self.assertIn('scripts/local-test-postgres.mjs', manifest['inputs'])
        self.assertIn('tests/migrations/0001-supabase-platform.sql', manifest['inputs'])
        self.assertIn('tests/migrations/effective-contract.sql', manifest['inputs'])


if __name__ == '__main__':
    unittest.main()
