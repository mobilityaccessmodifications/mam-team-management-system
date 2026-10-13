import copy
from unittest.mock import patch as patch_environment
import importlib.util
import os
import subprocess
import tempfile
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'scripts/deploy-annual-continuous-accrual.py'


class AnnualContinuousReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('annual_continuous_release', HELPER)
        assert spec is not None and spec.loader is not None
        cls.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.helper)

    def test_exact_candidate_scope(self):
        h = self.helper
        source = h.read_migration()
        specs = h.function_specs(source)
        self.assertEqual(len(specs), 13)
        self.assertEqual(sum(v['before'] is None for v in specs.values()), 4)
        self.assertEqual(h.digest(source), h.MIGRATION_SHA)

    def test_rejects_duplicate_and_nonfinite_pins(self):
        h = self.helper
        for raw in ['{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}', '{"a":-Infinity}']:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                h.decode(raw)

    def test_raw_bytes_are_not_normalized(self):
        h = self.helper
        source = h.read_migration()
        self.assertNotEqual(h.digest(source), h.digest(source.replace('\n', '\r\n')))
        with self.assertRaises(ValueError):
            h.validate_migration(source.replace('\n', '\r\n'))

    def test_core_predecessor_pins_must_match(self):
        h = self.helper
        source = h.read_migration()
        before = {'functions': {s: {'sha256': item['before']} for s, item in h.function_specs(source).items() if item['before'] is not None}}
        before['functions']['private.confirmed_test_purge_schema_hash()'] = {'sha256': '3385d5a0140df3995e3196ffea442b4829f9a5357de3ccf5a8d521fbe9011a54'}
        h.validate_predecessors(source, before)
        for signature in before['functions']:
            altered = copy.deepcopy(before)
            altered['functions'][signature]['sha256'] = '0' * 64
            with self.subTest(signature=signature), self.assertRaises(ValueError):
                h.validate_predecessors(source, altered)

    def test_outer_boundaries_keep_quoted_commit(self):
        h = self.helper
        sql = "begin;\nselect 'commit;';\ncommit;\n"
        self.assertEqual(h.transaction_body(sql), "select 'commit;';")
        with self.assertRaises(ValueError):
            h.transaction_body(sql.replace('begin;', 'BEGIN;'))

    def test_strict_hash_arguments_before_network(self):
        h = self.helper
        for core, pins in [('0' * 63, '0' * 64), ('0' * 64, 'G' * 64), (None, None)]:
            with self.subTest(core=core, pins=pins), self.assertRaises(ValueError):
                h.read_candidate(core, pins)

    def test_clean_source_rejects_uncommitted_candidate(self):
        h = self.helper
        with tempfile.NamedTemporaryFile(prefix='.annual-custody-', dir=ROOT, delete=False) as file:
            marker = Path(file.name)
        try:
            status = subprocess.check_output(['git', 'status', '--porcelain', '--', marker.name], cwd=ROOT, text=True)
            self.assertIn(marker.name, status)
            with patch_environment.dict(os.environ, {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}, clear=True):
                with self.assertRaisesRegex(ValueError, 'Clean reviewed release checkout required'):
                    h.clean_source()
        finally:
            marker.unlink()

    def test_clean_source_rejects_directory_and_git_overrides(self):
        h = self.helper
        previous = Path.cwd()
        try:
            os.chdir(ROOT.parent)
            with self.assertRaisesRegex(ValueError, 'approved repository root'):
                h.clean_source()
        finally:
            os.chdir(previous)
        key = 'GIT_DIR'
        old = os.environ.get(key)
        try:
            os.environ[key] = 'synthetic-untrusted-directory'
            with self.assertRaisesRegex(ValueError, 'Inherited Git overrides'):
                h.clean_source()
        finally:
            if old is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old

    def test_dispatch_journal_is_private_exclusive_and_query_bound(self):
        h = self.helper
        with tempfile.TemporaryDirectory(prefix='annual-journal-', dir=os.environ['TMPDIR']) as directory:
            with patch_environment.dict(os.environ, {'MAM_ANNUAL_CONTINUOUS_JOURNAL_DIR': directory}):
                h.dispatch_journal('synthetic transaction', 'a' * 64, 'b' * 64, 'c' * 40)
                file = Path(directory) / (h.VERSION + '-' + 'b' * 64 + '.dispatch.json')
                record = h.decode(file.read_bytes())
                self.assertEqual(record['rawQuerySha256'], h.digest('synthetic transaction'))
                self.assertFalse(record['automaticRetry'])
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)
                with self.assertRaises(FileExistsError):
                    h.dispatch_journal('different transaction', 'a' * 64, 'b' * 64, 'c' * 40)


if __name__ == '__main__':
    unittest.main()
