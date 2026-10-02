import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / 'scripts/deploy-payroll-closing-diagnostic.py'
CORE = '686ad41be98237ed7da92d46a9c476877c65d67aae96964100017ead684a0e2c'
PINS = '715b38257e974f02ed8abae37df969b42091c8c11d3c1120a801bd0da2de09ea'


def load():
    spec = importlib.util.spec_from_file_location('payroll_diagnostic', PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DiagnosticTests(unittest.TestCase):
    def test_additive_diagnostic_preserves_entire_reviewed_transaction(self):
        self.assertTrue(PATH.exists(), 'Failing release has no guarded schema-difference diagnostic')
        module = load()
        original = module.load_original()
        raw = original['load_candidate'](CORE)
        pins = json.loads(original['PINS'].read_bytes())
        self.assertEqual(hashlib.sha256(original['PINS'].read_bytes()).hexdigest(), PINS)
        transaction = original['build_transaction'](raw, pins['before'], pins['after'])
        generated = module.build_diagnostic_transaction(raw, pins['before'], pins['after'])
        diagnostic = module.normalization_diagnostic(raw)
        self.assertEqual(generated.replace(diagnostic, '', 1), transaction)
        self.assertEqual(generated.count(diagnostic), 1)
        self.assertIn('PAYROLL_NORMALIZATION_DIAGNOSTIC', diagnostic)
        self.assertIn("raise log", diagnostic.lower())
        self.assertNotIn('jsonb_agg(definition', diagnostic)
        self.assertLess(generated.index(diagnostic), generated.index('do $payroll_purge_after$'))
        self.assertIn("raise exception 'Unreviewed schema change during payroll migration'", generated)

    def test_cli_rejects_unreviewed_query_before_provider_access(self):
        module = load()
        self.assertTrue(hasattr(module, 'main'), 'No exact-query-bound diagnostic release entrypoint')
        original = module.load_original()
        api = Mock(side_effect=AssertionError('Provider must not be called'))
        argv = ['diagnostic', 'apply', '0' * 40, CORE, PINS, '0' * 64]
        with patch.object(module, 'load_original', return_value=original), patch.dict(original['main'].__globals__, api=api), patch.object(sys, 'argv', argv):
            with self.assertRaisesRegex(ValueError, 'Reviewed diagnostic query differs'):
                module.main()
        api.assert_not_called()

    def test_cli_delegates_exactly_one_bound_write_and_restores_scope(self):
        module = load()
        original = module.load_original()
        scope = original['main'].__globals__
        raw = original['load_candidate'](CORE)
        pins = json.loads(original['PINS'].read_bytes())
        transaction = module.build_diagnostic_transaction(raw, pins['before'], pins['after'])
        sha = hashlib.sha256(transaction.encode()).hexdigest()
        head = '0' * 40
        argv = ['diagnostic', 'apply', head, CORE, PINS, sha]
        builder = scope['build_transaction']
        query = Mock(return_value=[])
        with patch.object(module, 'load_original', return_value=original), patch.dict(scope, api=Mock(return_value={'id': original['PROJECT'], 'organization_id': original['ORG']}), query=query, read_catalog=Mock(side_effect=[pins['before'], pins['after']])), patch.object(scope['subprocess'], 'check_output', side_effect=[head + '\n', '']), patch.object(scope['subprocess'], 'run', return_value=Mock(returncode=0)), patch.object(sys, 'argv', argv), contextlib.redirect_stdout(io.StringIO()) as output:
            module.main()
            self.assertIs(scope['build_transaction'], builder)
            self.assertEqual(sys.argv, argv)
        self.assertEqual(query.call_count, 2)
        self.assertTrue(query.call_args_list[0].args[0].startswith('begin read only;'))
        self.assertEqual(query.call_args_list[1].args, (transaction,))
        self.assertTrue(json.loads(output.getvalue())['readbackVerified'])

    def test_uncertain_transport_has_no_automatic_retry(self):
        module = load()
        original = module.load_original()
        scope = original['main'].__globals__
        pins = json.loads(original['PINS'].read_bytes())
        raw = original['load_candidate'](CORE)
        transaction = module.build_diagnostic_transaction(raw, pins['before'], pins['after'])
        sha = hashlib.sha256(transaction.encode()).hexdigest()
        head = '0' * 40
        argv = ['diagnostic', 'apply', head, CORE, PINS, sha]
        builder = scope['build_transaction']
        query = Mock(side_effect=[[], OSError('Synthetic lost response')])
        with patch.object(module, 'load_original', return_value=original), patch.dict(scope, api=Mock(return_value={'id': original['PROJECT'], 'organization_id': original['ORG']}), query=query, read_catalog=Mock(return_value=pins['before'])), patch.object(scope['subprocess'], 'check_output', side_effect=[head + '\n', '']), patch.object(scope['subprocess'], 'run', return_value=Mock(returncode=0)), patch.object(sys, 'argv', argv):
            with self.assertRaisesRegex(OSError, 'Synthetic lost response'):
                module.main()
            self.assertIs(scope['build_transaction'], builder)
            self.assertEqual(sys.argv, argv)
        self.assertEqual(query.call_count, 2)
        self.assertEqual(query.call_args_list[1].args, (transaction,))

    def test_core_corruption_is_not_normalized(self):
        module = load()
        original = module.load_original()
        raw = original['load_candidate'](CORE)
        for changed in (raw + '\n', raw.replace('\n', '\r\n'), raw.replace('except all', 'except')):
            with self.subTest(source=hashlib.sha256(changed.encode()).hexdigest()):
                with self.assertRaisesRegex(ValueError, 'Unreviewed diagnostic core source'):
                    module.normalization_diagnostic(changed)


if __name__ == '__main__':
    unittest.main()
