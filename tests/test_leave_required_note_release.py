import copy
import importlib.util
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'scripts/deploy-leave-required-note.py'


def load_helper():
    assert HELPER.is_file(), 'The guarded required-note release helper is missing'
    spec = importlib.util.spec_from_file_location('required_note_release', HELPER)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    return helper


def predecessor_state(helper):
    return {
        'major': 16, 'dataHash': 'a'*64, 'securityHash': 'b'*64, 'receiptHash': 'c'*64,
        'purgeHash': 'd'*64, 'purgeMatches': True, 'predecessorExact': True, 'targetExact': False,
        'collectorSha256': helper.COLLECTOR_SHA, 'functionSha256': helper.BEFORE_SHA, 'functionMetadata': {},
        'ledger': [
            {'version': '20261012110000', 'name': 'trade_school_leave',
             'dimensions': '[0:0]', 'cardinality': 1, 'sourceSha256': 'e'*64},
            {'version': '20261013170000', 'name': 'subscription_review_tasks',
             'dimensions': '[1:1]', 'cardinality': 1, 'sourceSha256': 'f'*64},
        ],
    }


class RequiredNoteReleaseTests(unittest.TestCase):
    def test_latest_predecessor_is_exact_committed_subscription_review_tasks(self):
        helper = load_helper()
        predecessor = ROOT / 'supabase/migrations/20261013170000_subscription_review_tasks.sql'
        self.assertEqual((helper.PREDECESSOR_VERSION, helper.PREDECESSOR_NAME),
                         ('20261013170000', 'subscription_review_tasks'))
        self.assertEqual(helper.PREDECESSOR, predecessor)
        self.assertEqual(predecessor.read_bytes(), subprocess.check_output(
            ['git', 'show', 'HEAD:supabase/migrations/20261013170000_subscription_review_tasks.sql'], cwd=ROOT))
        source = helper.candidate(helper.sha(helper.MIGRATION.read_bytes()))
        expression = helper.state_expression(source)
        self.assertIn("'predecessorExact',coalesce((select name='subscription_review_tasks' "
                      "and array_dims(statements)='[1:1]' and statements=ARRAY[" +
                      helper.literal(predecessor.read_text()) + "]::text[] "
                      "from supabase_migrations.schema_migrations where version='20261013170000'),false)", expression)
        self.assertEqual(helper.BEFORE_SHA,
                         '6535b99e6244c42999825fd79262d29623e109f7af701810dcf4b6b410ff9819')

    def test_exact_source_transaction_preserves_ledger_and_final_security_guard(self):
        helper = load_helper()
        source = helper.candidate(helper.sha(helper.MIGRATION.read_bytes()))
        before = {
            'major': 16, 'dataHash': 'a'*64, 'securityHash': 'b'*64, 'receiptHash': 'c'*64,
            'purgeHash': 'd'*64, 'purgeMatches': True, 'predecessorExact': True, 'targetExact': False,
            'collectorSha256': helper.COLLECTOR_SHA, 'functionSha256': helper.BEFORE_SHA, 'functionMetadata': {},
            'ledger': [{'version': helper.PREDECESSOR_VERSION, 'name': helper.PREDECESSOR_NAME,
                        'dimensions': '[1:1]', 'cardinality': 1, 'sourceSha256': 'e'*64}],
        }
        transaction = helper.transaction(source, before)
        self.assertTrue(transaction.startswith('begin;'))
        self.assertTrue(transaction.endswith('commit;'))
        self.assertIn(helper.transaction_body(source), transaction)
        self.assertIn(helper.literal(source), transaction)
        ledger = transaction.index('insert into supabase_migrations.schema_migrations')
        self.assertIn('set constraints all immediate;', transaction[ledger:])
        self.assertIn('pg_temp.required_note_assert_delta()', transaction[ledger:])
        self.assertIn('pg_temp.required_note_security()', transaction[ledger:])
        self.assertIn('requiredNoteResultingCatalogSha256', transaction[ledger:])

    def test_validate_before_rejects_nonlatest_raw_ledger(self):
        helper = load_helper()
        source = helper.candidate(helper.sha(helper.MIGRATION.read_bytes()))
        before = predecessor_state(helper)
        helper.validate_before(before, source)
        historical, current = before['ledger']
        newer = dict(current, version='20261013173000')
        for label, rows in [
            ('stale latest', [historical]),
            ('newer latest', [historical, current, newer]),
            ('duplicate version', [historical, current, copy.deepcopy(current)]),
            ('unordered versions', [current, historical]),
            ('target already in ledger', [historical, current, dict(current, version=helper.VERSION)]),
        ]:
            with self.subTest(label=label):
                changed = copy.deepcopy(before)
                changed['ledger'] = rows
                with self.assertRaisesRegex(SystemExit, '^Latest predecessor or absent target differs$'):
                    helper.validate_before(changed, source)
        self.assertEqual(before, predecessor_state(helper))

    def test_validate_before_rejects_invalid_raw_ledger(self):
        helper = load_helper()
        source = helper.candidate(helper.sha(helper.MIGRATION.read_bytes()))
        before = predecessor_state(helper)
        current = before['ledger'][-1]
        for label, rows, message in [
            ('empty ledger', [], 'Unsupported bounded raw ledger'),
            ('overbound ledger', [current]*513, 'Unsupported bounded raw ledger'),
            ('extra row field', [dict(current, unknown=True)], 'Unsupported exact raw ledger'),
            ('missing array dimensions', [{k: v for k, v in current.items() if k != 'dimensions'}], 'Unsupported exact raw ledger'),
            ('nonliteral version', [dict(current, version=20261013170000)], 'Unsupported exact raw ledger'),
            ('malformed raw hash', [dict(current, sourceSha256='f'*63)], 'Unsupported exact raw ledger'),
        ]:
            with self.subTest(label=label):
                changed = copy.deepcopy(before)
                changed['ledger'] = rows
                with self.assertRaisesRegex(SystemExit, '^'+message+'$'):
                    helper.validate_before(changed, source)

    def test_validate_before_requires_exact_predecessor_and_absent_target(self):
        helper = load_helper()
        source = helper.candidate(helper.sha(helper.MIGRATION.read_bytes()))
        before = predecessor_state(helper)
        for field, value, message in [
            ('predecessorExact', False, 'Exact supported predecessor required'),
            ('predecessorExact', None, 'Exact supported predecessor required'),
            ('predecessorExact', 'true', 'Exact supported predecessor required'),
            ('purgeMatches', False, 'Exact supported predecessor required'),
            ('major', 18, 'Exact supported predecessor required'),
            ('targetExact', True, 'Latest predecessor or absent target differs'),
            ('targetExact', None, 'Latest predecessor or absent target differs'),
            ('targetExact', 0, 'Latest predecessor or absent target differs'),
            ('collectorSha256', '0'*64, 'Reviewed predecessor definitions differ'),
            ('functionSha256', '0'*64, 'Reviewed predecessor definitions differ'),
            ('functionMetadata', None, 'Missing exact function authority'),
        ]:
            with self.subTest(field=field, value=value):
                changed = copy.deepcopy(before)
                changed[field] = value
                with self.assertRaisesRegex(SystemExit, '^'+message+'$'):
                    helper.validate_before(changed, source)
        with self.assertRaisesRegex(SystemExit, '^Reviewed source bytes differ$'):
            helper.candidate('0'*64)

    def test_verify_after_preserves_historical_raw_ledger_layout(self):
        helper = load_helper()
        source = helper.candidate(helper.sha(helper.MIGRATION.read_bytes()))
        before = predecessor_state(helper)
        transaction = helper.transaction(source, before)
        self.assertIn(helper.literal(helper.json.dumps(before, separators=(',', ':'), allow_nan=False)), transaction)
        after = copy.deepcopy(before)
        after.update(purgeHash='9'*64, targetExact=True, functionSha256=helper.AFTER_SHA)
        after['ledger'].append({'version': helper.VERSION, 'name': helper.NAME, 'dimensions': '[1:1]',
                                'cardinality': 1, 'sourceSha256': '8'*64})
        helper.verify_after(after, before, source, '9'*64)
        for field, value in [('version', '20261012110001'), ('name', 'changed'), ('dimensions', '[1:1]'),
                             ('cardinality', 2), ('sourceSha256', '7'*64)]:
            with self.subTest(field=field):
                changed = copy.deepcopy(after)
                changed['ledger'][0][field] = value
                with self.assertRaisesRegex(SystemExit, '^Historical raw ledger readback differs$'):
                    helper.verify_after(changed, before, source, '9'*64)
        self.assertEqual(before, predecessor_state(helper))
