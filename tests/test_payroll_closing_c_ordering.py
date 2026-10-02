import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / 'supabase/migrations/20261001150000_payroll_closing_carryforward.sql'
CORRECTED_SHA = 'c0662cadbc822ef759b9088b1fd39b777cbab09bb27a2bda024b4cd033de6143'


class CollationTests(unittest.TestCase):
    def test_normalization_matches_verified_collector_c_ordering(self):
        raw = CORE.read_bytes()
        sql = raw.decode()
        block = sql.split('do $payroll_purge_after$', 1)[1]
        normalization = block.split('  select array_agg(definition', 1)[1].split('  into normalized_definitions,normalized_hash', 1)[0]
        self.assertEqual(normalization.count('order by definition collate "C"'), 2)
        self.assertIn('normalized_definitions is distinct from baseline.definitions or normalized_hash is distinct from baseline.schema_hash', block)
        self.assertEqual(hashlib.sha256(raw).hexdigest(), CORRECTED_SHA)

    def test_only_exact_corrected_security_source_is_accepted(self):
        spec = importlib.util.spec_from_file_location('c_ordering_helper', ROOT / 'scripts/deploy-payroll-closing-carryforward.py')
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        corrected = CORE.read_text()
        old = corrected.replace('order by definition collate "C"', 'order by definition')
        self.assertEqual(hashlib.sha256(old.encode()).hexdigest(), '686ad41be98237ed7da92d46a9c476877c65d67aae96964100017ead684a0e2c')
        with self.assertRaisesRegex(ValueError, 'Unreviewed full security metadata source'):
            module.full_security_query(old)
        self.assertTrue(module.full_security_query(corrected).startswith('SELECT (select jsonb_build_object('))

    def test_corrected_transaction_records_only_corrected_raw_source(self):
        spec = importlib.util.spec_from_file_location('c_ordering_helper', ROOT / 'scripts/deploy-payroll-closing-carryforward.py')
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        source = CORE.read_text()
        pins = json.loads(module.PINS.read_bytes())
        self.assertEqual(pins['migrationSha256'], CORRECTED_SHA)
        source_hash = module.digest(json.dumps([source], ensure_ascii=False, separators=(',', ':')))
        self.assertEqual(pins['after']['ledger'][-1]['sourceHash'], source_hash)
        transaction = module.build_transaction(source, pins['before'], pins['after'])
        self.assertEqual(transaction.count('ARRAY[' + module.literal(source) + ']'), 1)
        corrupted = json.loads(json.dumps(pins['after']))
        corrupted['ledger'][-1]['sourceHash'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'Target ledger pin does not match candidate bytes'):
            module.build_transaction(source, pins['before'], corrupted)


if __name__ == '__main__':
    unittest.main()
