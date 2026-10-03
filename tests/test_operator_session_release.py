import copy
import hashlib
import json
from pathlib import Path
import runpy
import unittest

ROOT = Path(__file__).resolve().parents[1]


class OperatorSessionReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = runpy.run_path(str(ROOT / 'scripts/deploy-operator-session-proof.py'))
        cls.sql = cls.m['MIGRATION'].read_text()
        cls.pins = cls.m['read_pins'](hashlib.sha256(cls.m['PINS'].read_bytes()).hexdigest())

    def test_only_declared_two_functions_and_one_ledger_row_are_added(self):
        before, after = self.pins['before'], self.pins['after']
        self.assertEqual(set(after['functions']) - set(before['functions']), set(self.m['NEW_FUNCTIONS']))
        changed = copy.deepcopy(after)
        changed['functions'] = {k: v for k, v in after['functions'].items() if k in before['functions']}
        changed['ledger'] = before['ledger']
        self.assertEqual(before, changed)

    def test_actual_transaction_preserves_outer_source_and_final_security_checks(self):
        transaction = self.m['build_transaction'](self.sql, self.pins)
        self.assertTrue(transaction.startswith('begin;'))
        self.assertTrue(transaction.endswith('commit;'))
        self.assertEqual(transaction.count('insert into supabase_migrations.schema_migrations'), 1)
        drain = transaction.index('set constraints all immediate;')
        self.assertGreater(transaction.index('do $operator_proof_final$'), drain)
        self.assertIn('pg_temp.operator_proof_transition', transaction)
        self.assertIn('extra_catalog', transaction)
        self.assertIn('receipts_hash', transaction)
        self.assertIn('after_hash', transaction)
        self.assertIn("notify pgrst,'reload schema'", transaction)

    def test_declared_predecessor_drift_is_rejected_before_building(self):
        for signature in self.pins['before']['functions']:
            pins = copy.deepcopy(self.pins)
            pins['before']['functions'][signature]['sha256'] = '0' * 64
            with self.assertRaises(ValueError):
                self.m['build_transaction'](self.sql, pins)

    def test_candidate_raw_bytes_and_manifest_target_are_not_normalized(self):
        with self.assertRaises(ValueError):
            self.m['build_transaction'](self.sql.replace('\n', '\r\n'), self.pins)
        for field in ['project', 'organization', 'version', 'baseHead']:
            pins = copy.deepcopy(self.pins)
            pins[field] = 'not-approved'
            with self.assertRaises(ValueError):
                self.m['build_transaction'](self.sql, pins)

    def test_recorded_source_is_read_only_only_when_complete_frame_matches(self):
        good = {'catalog': self.pins['after'], 'ledgerShapes': self.pins['afterLedgerShapes']}
        self.assertTrue(self.m['validate_frame'](good, self.pins, recorded=True))
        for branch in ['catalog', 'ledgerShapes']:
            bad = copy.deepcopy(good)
            if branch == 'catalog':
                bad[branch]['ledger'][-1]['name'] = 'different'
            else:
                bad[branch][-1]['lower'] = 0
            with self.assertRaises(ValueError):
                self.m['validate_frame'](bad, self.pins, recorded=True)


if __name__ == '__main__':
    unittest.main()
