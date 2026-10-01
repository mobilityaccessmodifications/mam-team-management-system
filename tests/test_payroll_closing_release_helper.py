import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('closing_helper', ROOT / 'scripts/deploy-payroll-closing-carryforward.py')
assert spec is not None and spec.loader is not None
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ReleaseHelperTests(unittest.TestCase):
    def test_full_security_query_is_exact_reviewed_core_expression(self):
        raw = m.load_candidate('686ad41be98237ed7da92d46a9c476877c65d67aae96964100017ead684a0e2c')
        expression = '(select jsonb_build_object(\n'+raw.split('      (select jsonb_build_object(\n',1)[1].split(' as extra_catalog;',1)[0]
        self.assertEqual(raw.count(expression),3)
        self.assertEqual(m.full_security_query(raw),'SELECT '+expression+' AS metadata;')
        self.assertEqual(m.full_security_query(),m.full_security_query(raw))
        for changed in (raw.replace("'storage','auth'","'storage'"), raw.replace("'roles'","'wrong'"), raw+'\nSELECT 1;', raw.replace('\n','\r\n')):
            with self.subTest(source=hashlib.sha256(changed.encode()).hexdigest()):
                with self.assertRaisesRegex(ValueError,'Unreviewed full security metadata source'):
                    m.full_security_query(changed)
        pins = json.loads(m.PINS.read_bytes())
        pins['migrationSha256'] = '0'*64
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as directory:
            manifest = Path(directory)/'pins.json'
            manifest.write_text(json.dumps(pins))
            with patch.object(m,'PINS',manifest):
                with self.assertRaisesRegex(ValueError,'Unreviewed full security metadata source'):
                    m.full_security_query()

    def test_purge_contract_is_certified_without_oid_pins(self):
        reviewed = '686ad41be98237ed7da92d46a9c476877c65d67aae96964100017ead684a0e2c'
        m.load_candidate(reviewed)
        query = m.catalog_query()
        self.assertIn("'purgeGuard'", query)
        self.assertIn('private.confirmed_test_purge_schema_hash()', query)
        self.assertIn('private.confirmed_test_purge_schema', m.BEFORE_TABLES)
        self.assertIn('private.confirmed_test_identity_purges', m.BEFORE_TABLES)
        self.assertIn('private.reject_retired_test_identity_reference()', m.BEFORE_FUNCTIONS)
        self.assertIn('private.confirmed_test_purge_census(uuid,uuid)', m.BEFORE_FUNCTIONS)


    def test_transaction_rechecks_purge_receipts(self):
        reviewed = '686ad41be98237ed7da92d46a9c476877c65d67aae96964100017ead684a0e2c'
        raw = m.load_candidate(reviewed)
        ledger = [dict(version='20261001140000',name='synthetic',sourceHash='0'*64)]
        before = dict(ledger=ledger,functions=json.loads(m.PINS.read_bytes())['before']['functions'],tables={})
        after = dict(before,ledger=ledger+[dict(version=m.VERSION,name=m.NAME,sourceHash=m.digest(json.dumps([raw],ensure_ascii=False,separators=(',',':'))))])
        transaction = m.build_transaction(raw,before,after)
        self.assertIn('closing_release_purge_receipts_hash',transaction)
        self.assertIn('closing_release_purge_catalog_hash',transaction)
        self.assertIn('Purge receipt or post-transition catalog drift',transaction)
        final = transaction[transaction.rindex('do $closing_release_purge$'):]
        self.assertIn('extra_catalog from pg_temp.payroll_purge_transition',final)
        self.assertIn(m.full_security_query(raw).removeprefix('SELECT ').removesuffix(' AS metadata;'),final)
        self.assertGreater(transaction.rindex('do $closing_release_purge$'),transaction.rindex('insert into supabase_migrations.schema_migrations'))

    def test_deferred_effects_run_before_all_final_assertions(self):
        raw = m.load_candidate('686ad41be98237ed7da92d46a9c476877c65d67aae96964100017ead684a0e2c')
        pins = json.loads(m.PINS.read_bytes())
        transaction = m.build_transaction(raw,pins['before'],pins['after'])
        boundary = transaction.rindex('insert into supabase_migrations.schema_migrations')
        final = transaction[boundary:]
        self.assertEqual(final.count('\nset constraints all immediate;\n'),1)
        drained = final.index('\nset constraints all immediate;\n')
        self.assertLess(drained,final.index('do $closing_release$'))
        self.assertLess(drained,final.index('do $closing_release_purge$'))
        self.assertLess(drained,final.rindex('\ncommit;'))

    def test_inspect_rejects_adopted_core_predecessor_mismatch(self):
        import re
        raw = m.load_candidate('686ad41be98237ed7da92d46a9c476877c65d67aae96964100017ead684a0e2c')
        block = raw.split('do $payroll_purge_before$',1)[1].split('end $payroll_purge_before$;',1)[0]
        signatures = [signature for signature,_ in re.findall(r"\('([^']+)','([0-9a-f]{64})'\)",block)]
        self.assertEqual(len(signatures),14)
        for signature in signatures:
            with self.subTest(signature=signature):
                pins = json.loads(m.PINS.read_bytes())
                pins['before']['functions'][signature]['sha256'] = '0'*64
                with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as directory:
                    manifest = Path(directory)/'pins.json'
                    manifest.write_text(json.dumps(pins))
                    with patch.object(m,'PINS',manifest), patch.object(m,'api',return_value={'id':m.PROJECT,'organization_id':m.ORG}), patch.object(m,'query',return_value=[]), patch.object(m,'read_catalog',return_value=pins['before']), patch.object(sys,'argv',['helper','inspect']), contextlib.redirect_stdout(io.StringIO()):
                        with self.assertRaisesRegex(ValueError,'Core predecessor definition pin drift'):
                            m.main()

    def test_candidate_requires_exact_raw_bytes(self):
        reviewed = '686ad41be98237ed7da92d46a9c476877c65d67aae96964100017ead684a0e2c'
        raw = m.MIGRATION.read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), reviewed)
        self.assertEqual(m.load_candidate(reviewed).encode(), raw)
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as directory:
            candidate = Path(directory) / m.MIGRATION.name
            candidate.write_bytes(raw.replace(b'\n', b'\r\n'))
            with patch.object(m, 'MIGRATION', candidate):
                with self.assertRaisesRegex(ValueError, 'Reviewed migration bytes differ'):
                    m.load_candidate(reviewed)

    def test_pin_manifest_requires_exact_raw_bytes_before_write(self):
        raw = m.MIGRATION.read_bytes()
        original = m.PINS.read_bytes()
        pins = json.loads(original)
        calls = []
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as directory:
            root = Path(directory)
            manifest = root / 'pins.json'
            manifest.write_bytes(original.replace(b'\n', b'\r\n'))
            original_cwd = Path.cwd()
            try:
                os.chdir(root)
                with patch.object(m, 'ROOT', root), patch.object(m, 'PINS', manifest), patch.object(m, 'api', return_value={'id':m.PROJECT,'organization_id':m.ORG}), patch.object(m, 'read_catalog', side_effect=[pins['before'], pins['after']]), patch.object(m, 'query', side_effect=lambda sql: calls.append(sql) or []), patch.object(m.subprocess, 'check_output', side_effect=[m.BASE_HEAD+'\n', '']), patch.object(m.subprocess, 'run') as run, patch.object(sys, 'argv', ['helper','apply',m.BASE_HEAD,hashlib.sha256(raw).hexdigest(),hashlib.sha256(original).hexdigest()]), contextlib.redirect_stdout(io.StringIO()):
                    run.return_value.returncode = 0
                    with self.assertRaisesRegex(ValueError, 'Reviewed pin manifest differs'):
                        m.main()
                self.assertTrue(all(sql.lower().startswith('begin read only;') for sql in calls))
            finally:
                os.chdir(original_cwd)

    def test_unknown_pending_predecessor_is_rejected_before_write(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as directory:
            root = Path(directory)
            migrations = root / 'supabase/migrations'
            migrations.mkdir(parents=True)
            expected = []
            for path in sorted((ROOT / 'supabase/migrations').glob('*.sql')):
                shutil.copyfile(path, migrations / path.name)
                if path != m.MIGRATION:
                    version, name = path.stem.split('_', 1)
                    expected.append(dict(file=path.name, version=version, name=name, sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
            candidate = migrations / m.MIGRATION.name
            raw = candidate.read_text()
            pins = json.loads(m.PINS.read_text())
            pins['migrationSha256'] = m.digest(raw)
            pins['localPredecessors'] = expected
            pins['after']['ledger'][-1]['sourceHash'] = m.digest(json.dumps([raw], ensure_ascii=False, separators=(',', ':')))
            manifest = root / 'pins.json'
            manifest.write_text(json.dumps(pins))
            (migrations / '20261001135000_unknown_pending.sql').write_text('begin;\nselect 1;\ncommit;\n')
            calls = []
            def query(sql):
                calls.append(sql)
                return []
            original_cwd = Path.cwd()
            try:
                os.chdir(root)
                with patch.object(m, 'ROOT', root), patch.object(m, 'MIGRATION', candidate), patch.object(m, 'PINS', manifest), patch.object(m, 'api', return_value={'id':m.PROJECT,'organization_id':m.ORG}), patch.object(m, 'read_catalog', side_effect=[pins['before'], pins['after']]), patch.object(m, 'query', side_effect=query), patch.object(m.subprocess, 'check_output', side_effect=[(m.BASE_HEAD+'\n'), '']), patch.object(m.subprocess, 'run') as run, patch.object(sys, 'argv', ['helper','apply',m.BASE_HEAD,m.digest(raw),m.digest(manifest.read_text())]), contextlib.redirect_stdout(io.StringIO()):
                    run.return_value.returncode = 0
                    with self.assertRaisesRegex(ValueError, 'Local predecessor source/catalog drift'):
                        m.main()
                self.assertTrue(all(sql.lower().startswith('begin read only;') for sql in calls))
            finally:
                os.chdir(original_cwd)


if __name__ == '__main__':
    unittest.main()
