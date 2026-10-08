import copy
import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class AnnualSourceBankReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = runpy.run_path(str(ROOT / 'scripts/deploy-annual-source-bank.py'))

    def setUp(self):
        existing_signatures = ['private.synthetic_old_' + str(index) + '()' for index in range(19)]
        new_signatures = ['private.synthetic_new_' + str(index) + '()' for index in range(7)]
        specifications = ["('" + signature + "',true,'" + '3' * 64 + "','" + '3' * 64 + "',null)" for signature in existing_signatures]
        specifications += ["('" + signature + "',false,null,'" + '6' * 64 + "','{}'::jsonb)" for signature in new_signatures]
        self.sql = "begin;\ncreate function pg_temp.annual_source_security() returns jsonb language sql as $f$ select '{}'::jsonb $f$;\ncreate temporary table annual_source_security_before(value jsonb) on commit drop;\ninsert into annual_source_function_spec values\n" + ',\n'.join(specifications) + ";\ncreate temporary table annual_source_relation_spec(x text);\nselect 'commit;'::text;\ncommit;\n"
        old = dict(version='20261006110000', name='synthetic_predecessor', statementHashes=None,
                   ndims=None, lower=None, upper=None, cardinality=None, isNull=True, rawHash='1' * 64)
        new = dict(version='20261008235900', name=self.m['NAME'], statementHashes=[self.m['digest'](self.sql)],
                   ndims=1, lower=1, upper=1, cardinality=1, isNull=False, rawHash='2' * 64)
        function = dict(sha256='3' * 64, owner='postgres', acl='{postgres=X/postgres}',
                        securityDefiner=True, config=['search_path=""'])
        catalog = dict(purgeGuard=dict(rows=1, matches=True), roles=[], schemas=[], defaultAcl=[],
                       ledger=[dict(version=old['version'], name=old['name'], sourceHash='4' * 64)],
                       functions={'private.confirmed_test_purge_schema_hash()': function},
                       tables={'private.confirmed_test_purge_schema': dict(owner='postgres', rls=True, forceRls=True)})
        for signature in existing_signatures:
            catalog['functions'][signature] = copy.deepcopy(function)
        after = copy.deepcopy(catalog)
        for signature in new_signatures:
            after['functions'][signature] = dict(function, sha256='6' * 64)
        after['ledger'].append(dict(version=new['version'], name=new['name'],
                                    sourceHash=self.m['digest'](json.dumps([self.sql], ensure_ascii=False, separators=(',', ':')))))
        self.pins = dict(project=self.m['PROJECT'], organization=self.m['ORG'], baseHead=self.m['BASE_HEAD'],
                         version=new['version'], migrationSha256=self.m['digest'](self.sql),
                         before=catalog, after=after, beforeLedger=[old], afterLedger=[copy.deepcopy(old), new], localPredecessors=[])

    def test_every_core_before_and_after_definition_pin_is_checked(self):
        for phase in ['before', 'after']:
            for signature in self.pins[phase]['functions']:
                if 'synthetic_' not in signature:
                    continue
                with self.subTest(phase=phase, signature=signature):
                    pins = copy.deepcopy(self.pins)
                    pins[phase]['functions'][signature]['sha256'] = '9' * 64
                    with self.assertRaisesRegex(ValueError, 'definition pin differs'):
                        self.m['validate_candidate'](self.sql, pins)

    def test_core_signature_omissions_additions_duplicates_and_undeclared_change_rejected(self):
        for phase in ['before', 'after']:
            pins = copy.deepcopy(self.pins)
            del pins[phase]['functions']['private.synthetic_old_0()']
            with self.assertRaises(ValueError):
                self.m['validate_candidate'](self.sql, pins)
        pins = copy.deepcopy(self.pins)
        pins['before']['functions']['private.synthetic_new_0()'] = copy.deepcopy(pins['after']['functions']['private.synthetic_new_0()'])
        with self.assertRaises(ValueError):
            self.m['validate_candidate'](self.sql, pins)
        pins = copy.deepcopy(self.pins)
        pins['after']['functions']['private.unknown_function()'] = copy.deepcopy(next(iter(pins['after']['functions'].values())))
        with self.assertRaises(ValueError):
            self.m['validate_candidate'](self.sql, pins)
        pins = copy.deepcopy(self.pins)
        pins['after']['functions']['private.confirmed_test_purge_schema_hash()']['sha256'] = '9' * 64
        with self.assertRaisesRegex(ValueError, 'Unlisted protected function change'):
            self.m['validate_candidate'](self.sql, pins)
        sql = self.sql.replace('private.synthetic_old_1()', 'private.synthetic_old_0()')
        pins = copy.deepcopy(self.pins)
        pins['migrationSha256'] = self.m['digest'](sql)
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            self.m['validate_candidate'](sql, pins)

    def test_candidate_accepts_exact_null_history_and_singleton_target(self):
        self.m['validate_candidate'](self.sql, self.pins)
        empty = dict(version='20261006120000', name='synthetic_empty', statementHashes=[],
                     ndims=None, lower=None, upper=None, cardinality=0, isNull=False, rawHash='5' * 64)
        pins = copy.deepcopy(self.pins)
        pins['beforeLedger'].append(empty)
        pins['afterLedger'].insert(1, empty)
        self.m['validate_candidate'](self.sql, pins)

    def test_duplicate_keys_and_nonfinite_numbers_are_rejected(self):
        for value in ['{"version":"1","version":"2"}', '{"x":NaN}', '{"x":Infinity}', '{"x":-Infinity}']:
            with self.assertRaises(ValueError):
                self.m['decode'](value)

    def test_target_and_raw_migration_are_not_normalized(self):
        with self.assertRaises(ValueError):
            self.m['validate_candidate'](self.sql.replace('\n', '\r\n'), self.pins)
        for key in ['project', 'organization', 'baseHead', 'version']:
            pins = copy.deepcopy(self.pins)
            pins[key] = 'unapproved'
            with self.assertRaises(ValueError):
                self.m['validate_candidate'](self.sql, pins)

    def test_history_replacement_and_array_bound_only_drift_fail(self):
        for key, value in [('name', 'changed'), ('rawHash', '0' * 64), ('isNull', False), ('statementHashes', [])]:
            pins = copy.deepcopy(self.pins)
            pins['afterLedger'][0][key] = value
            with self.assertRaises(ValueError):
                self.m['validate_candidate'](self.sql, pins)
        for key, value in [('lower', 0), ('upper', 0), ('ndims', 2), ('cardinality', 2), ('statementHashes', [self.m['digest'](self.sql.rstrip())])]:
            pins = copy.deepcopy(self.pins)
            pins['afterLedger'][-1][key] = value
            with self.assertRaises(ValueError):
                self.m['validate_candidate'](self.sql, pins)

    def test_missing_raw_statement_field_does_not_become_null(self):
        rows = copy.deepcopy(self.pins['beforeLedger'])
        del rows[0]['statementHashes']
        with self.assertRaises(ValueError):
            self.m['validate_ledger'](rows)
        rows = copy.deepcopy(self.pins['beforeLedger'])
        rows[0]['isNull'] = False
        with self.assertRaises(ValueError):
            self.m['validate_ledger'](rows)

    def test_protected_pin_omissions_and_invalid_collector_rejected(self):
        for key in ['functions', 'tables']:
            pins = copy.deepcopy(self.pins)
            pins['after'][key] = {}
            with self.assertRaises(ValueError):
                self.m['validate_candidate'](self.sql, pins)
        pins = copy.deepcopy(self.pins)
        pins['after']['purgeGuard']['matches'] = False
        with self.assertRaises(ValueError):
            self.m['validate_candidate'](self.sql, pins)

    def test_actual_envelope_preserves_quoted_commit_and_final_security_order(self):
        transaction = self.m['build_transaction'](self.sql, self.pins)
        self.assertTrue(transaction.startswith('begin;'))
        self.assertTrue(transaction.endswith('commit;'))
        self.assertIn("select 'commit;'::text;", transaction)
        self.assertEqual(transaction.count('insert into supabase_migrations.schema_migrations'), 1)
        insert = transaction.index('insert into supabase_migrations.schema_migrations')
        drain = transaction.index('set constraints all immediate;', insert)
        final = transaction.index('do $annual_source_release_final$', drain)
        drop = transaction.index('drop function pg_temp.annual_source_security();', final)
        self.assertLess(insert, drain)
        self.assertLess(drain, final)
        self.assertLess(final, drop)
        self.assertIn('pg_temp.annual_source_security_before', transaction)
        self.assertIn('pg_temp.annual_source_release_receipts', transaction)
        self.assertIn('private.confirmed_test_purge_schema_hash()', transaction)
        self.assertIn("notify pgrst,'reload schema'", transaction)
        self.assertIn("'rawHash'", transaction)
        self.assertIn("'lower'", transaction)

    def test_core_cannot_drop_the_final_security_function(self):
        sql = self.sql.replace('\ncommit;\n', '\ndrop function pg_temp.annual_source_security();\ncommit;\n')
        pins = copy.deepcopy(self.pins)
        pins['migrationSha256'] = self.m['digest'](sql)
        pins['afterLedger'][-1]['statementHashes'] = [self.m['digest'](sql)]
        with self.assertRaises(ValueError):
            self.m['build_transaction'](sql, pins)

    def test_pins_and_source_bytes_require_both_explicit_hashes(self):
        scope = self.m['read_candidate'].__globals__
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'supabase/migrations').mkdir(parents=True)
            (root / 'scripts').mkdir()
            source = root / 'supabase/migrations' / (self.pins['version'] + '_' + self.m['NAME'] + '.sql')
            source.write_bytes(self.sql.encode())
            pinfile = root / 'scripts/pins.json'
            raw = json.dumps(self.pins).encode()
            pinfile.write_bytes(raw)
            pin_sha = self.m['digest'](raw.decode())
            with patch.dict(scope, dict(ROOT=root, PINS=pinfile)):
                self.assertEqual(self.m['read_candidate'](self.pins['migrationSha256'], pin_sha)[0], self.sql)
                for core_sha, pins_sha in [(None, pin_sha), (self.pins['migrationSha256'], None), ('0' * 64, pin_sha), (self.pins['migrationSha256'], '0' * 64)]:
                    with self.assertRaises(ValueError):
                        self.m['read_candidate'](core_sha, pins_sha)
                source.write_bytes(self.sql.replace('\n', '\r\n').encode())
                with self.assertRaises(ValueError):
                    self.m['read_candidate'](self.pins['migrationSha256'], pin_sha)

    def test_dirty_or_wrong_head_stops_before_provider_calls(self):
        scope = self.m['main'].__globals__
        provider_calls = []
        def git(*args, **kwargs):
            command = args[0]
            if command[1:3] == ['rev-parse', 'HEAD']:
                return 'a' * 40 + '\n'
            if command[1:3] == ['status', '--porcelain']:
                return ' M protected-file\n'
            raise AssertionError('Unexpected Git check after dirty source')
        with patch.dict(scope, dict(read_candidate=lambda *args: (self.sql, self.pins),
                                   base_helper=lambda: dict(api=lambda: provider_calls.append(True)))):
            with patch('sys.argv', ['helper', 'apply', 'a' * 40, 'b' * 64, 'c' * 64, '/private/example.json']), patch('subprocess.check_output', side_effect=git):
                with self.assertRaisesRegex(ValueError, 'Clean reviewed'):
                    scope['main']()
        self.assertFalse(provider_calls)

    def test_readback_requires_complete_catalog_and_native_ledger(self):
        frame = dict(catalog=self.pins['after'], rawLedger=self.pins['afterLedger'])
        self.assertTrue(self.m['validate_frame'](frame, self.pins, True))
        for branch in ['catalog', 'rawLedger']:
            bad = copy.deepcopy(frame)
            if branch == 'catalog':
                bad[branch]['functions']['private.confirmed_test_purge_schema_hash()']['acl'] = None
            else:
                bad[branch][-1]['lower'] = 0
            with self.assertRaises(ValueError):
                self.m['validate_frame'](bad, self.pins, True)
        with self.assertRaises(ValueError):
            self.m['validate_frame']({'catalog': frame['catalog']}, self.pins, True)

    def test_journal_is_private_exclusive_and_never_records_sql(self):
        with tempfile.TemporaryDirectory() as directory:
            os.chmod(directory, 0o700)
            path = Path(directory) / 'apply.json'
            self.m['create_journal'](path, 'a' * 40, 'b' * 64, 'c' * 64, 'secret SQL', self.pins['version'])
            raw = path.read_text()
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertNotIn('secret SQL', raw)
            self.assertFalse(json.loads(raw)['automaticRetry'])
            with self.assertRaises(FileExistsError):
                self.m['create_journal'](path, 'a' * 40, 'b' * 64, 'c' * 64, 'secret SQL', self.pins['version'])
            os.chmod(directory, 0o755)
            with self.assertRaises(ValueError):
                self.m['create_journal'](Path(directory) / 'unsafe.json', 'a' * 40, 'b' * 64, 'c' * 64, '', self.pins['version'])

    def test_recorded_apply_uses_reads_only_and_wrong_project_never_dispatches(self):
        queries, frames, journals = [], [], []
        api = lambda: dict(id=self.m['PROJECT'], organization_id=self.m['ORG'])
        query = lambda sql: queries.append(sql) or [{'version': self.pins['version']}]
        scope = self.m['main'].__globals__
        with patch.dict(scope, dict(read_candidate=lambda *args: (self.sql, self.pins),
                                   clean_source=lambda *args: None,
                                   base_helper=lambda: dict(api=api, query=query),
                                   read_frame=lambda pins, recorded: frames.append(recorded),
                                   create_journal=lambda *args: journals.append(args))):
            with patch('sys.argv', ['helper', 'apply', 'a' * 40, 'b' * 64, 'c' * 64, '/private/example.json']), contextlib.redirect_stdout(io.StringIO()):
                scope['main']()
            self.assertEqual(frames, [True])
            self.assertFalse(journals)
            self.assertEqual(len(queries), 1)
            self.assertTrue(queries[0].startswith('begin read only;'))
            queries.clear()
            with patch.dict(scope, dict(base_helper=lambda: dict(api=lambda: dict(id='wrong', organization_id=self.m['ORG']), query=query))):
                with patch('sys.argv', ['helper', 'inspect', 'b' * 64, 'c' * 64]):
                    with self.assertRaises(ValueError):
                        scope['main']()
            self.assertFalse(queries)

    def test_new_apply_dispatches_once_with_journal_and_independent_readback(self):
        scope = self.m['main'].__globals__
        events = []
        def query(sql):
            events.append(('query', sql))
            return []
        overrides = dict(read_candidate=lambda *args: (self.sql, self.pins), clean_source=lambda *args: events.append(('clean',)),
                         base_helper=lambda: dict(api=lambda: dict(id=self.m['PROJECT'], organization_id=self.m['ORG']), query=query),
                         read_frame=lambda pins, recorded: events.append(('frame', recorded)),
                         build_transaction=lambda *args: 'reviewed exact transaction',
                         create_journal=lambda *args: events.append(('journal', args[4])))
        with patch.dict(scope, overrides), patch('sys.argv', ['helper', 'apply', 'a' * 40, 'b' * 64, 'c' * 64, '/private/example.json']), contextlib.redirect_stdout(io.StringIO()):
            scope['main']()
        self.assertEqual([event[0] for event in events], ['clean', 'query', 'frame', 'journal', 'query', 'frame'])
        self.assertEqual(events[-1], ('frame', True))
        self.assertEqual(events[-2], ('query', 'reviewed exact transaction'))
        self.assertEqual(events[-3], ('journal', 'reviewed exact transaction'))

    def test_uncertain_dispatch_is_not_retried(self):
        scope = self.m['main'].__globals__
        writes = []
        def query(sql):
            if sql.startswith('begin read only;'):
                return []
            writes.append(sql)
            raise TimeoutError('Unknown provider result')
        with patch.dict(scope, dict(read_candidate=lambda *args: (self.sql, self.pins), clean_source=lambda *args: None,
                                   base_helper=lambda: dict(api=lambda: dict(id=self.m['PROJECT'], organization_id=self.m['ORG']), query=query),
                                   read_frame=lambda *args: None,
                                   build_transaction=lambda *args: 'one exact write', create_journal=lambda *args: None)), \
                patch('sys.argv', ['helper', 'apply', 'a' * 40, 'b' * 64, 'c' * 64, '/private/example.json']):
            with self.assertRaises(TimeoutError):
                scope['main']()
        self.assertEqual(writes, ['one exact write'])


if __name__ == '__main__':
    unittest.main()
