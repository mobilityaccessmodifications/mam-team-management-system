import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'scripts/deploy-trade-school-leave.py'


def load_helper():
    if not HELPER.is_file():
        raise AssertionError('Targeted source-bound trade-school release helper is missing')
    spec = importlib.util.spec_from_file_location('trade_release', HELPER)
    assert spec is not None and spec.loader is not None
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    return helper


def synthetic_before(source):
    rows = re.findall(r"\('([^']+)',(true|false),(null|'[0-9a-f]{64}'),'([0-9a-f]{64})',", source)
    return {
        'major': 16, 'dataHash': 'a' * 64, 'securityHash': 'b' * 64, 'receiptHash': 'c' * 64,
        'purgeHash': 'd' * 64, 'purgeMatches': True, 'predecessorExact': True, 'targetExact': False,
        'ledger': [{'version': '20261008150000', 'name': 'annual_source_bank_reconciliation',
                    'dimensions': '[1:1]', 'cardinality': 1, 'sourceSha256': 'e' * 64}],
        'functions': {sig: {'sha256': before.strip("'"), 'metadata': {}, 'portable': {}}
                      if existing == 'true' else None for sig, existing, before, after in rows},
        'columnValid': False, 'enabledCount': 0, 'trigger': None, 'constraints': {},
    }


class TradeSchoolReleaseTests(unittest.TestCase):
    def test_eligibility_audit_constraint_is_in_the_exact_release_scope(self):
        helper = load_helper()
        source = helper.candidate(helper.sha(helper.MIGRATION.read_bytes()))
        constraints = helper.constraint_spec(source)
        self.assertIn('employee_directory_audit_events_changed_fields_check', constraints)
        self.assertIn("'trade_school_enabled'::text", constraints['employee_directory_audit_events_changed_fields_check']['definition'])

    def setUp(self):
        self.no_network = patch('urllib.request.urlopen', side_effect=AssertionError('Offline tests forbid network'))
        self.no_network.start()
        self.addCleanup(self.no_network.stop)

    def test_exact_source_transaction_has_guarded_ledger_and_final_drain(self):
        helper = load_helper()
        source = helper.candidate(helper.sha(helper.MIGRATION.read_bytes()))
        before = synthetic_before(source)
        with patch.object(helper, 'query', return_value=[{'state': before}]) as transport:
            self.assertEqual(helper.read_state(source), before)
        self.assertIn('begin read only;', transport.call_args.args[0])
        self.assertIn("statement_timeout='30s'", transport.call_args.args[0])
        transaction = helper.transaction(source, before)
        self.assertTrue(transaction.startswith('begin;'))
        self.assertTrue(transaction.endswith('commit;'))
        self.assertIn(helper.literal(source), transaction)
        self.assertIn('lock table supabase_migrations.schema_migrations', transaction)
        body = helper.transaction_body(source)
        self.assertIn(body, transaction)
        ledger = transaction.index('insert into supabase_migrations.schema_migrations')
        self.assertIn('set constraints all immediate;', transaction[ledger:])
        self.assertIn('pg_temp.trade_school_assert_delta()', transaction[ledger:])
        self.assertIn('pg_temp.trade_school_security()', transaction[ledger:])
        self.assertIn('tradeSchoolResultingCatalogSha256', transaction[ledger:])
        self.assertLess(transaction.index('set constraints all immediate;', ledger), transaction.index('do $trade_school_release_final$', ledger))


    def test_independent_readback_rejects_every_protected_field(self):
        helper = load_helper()
        source = helper.candidate(helper.sha(helper.MIGRATION.read_bytes()))
        before = synthetic_before(source)
        after = copy.deepcopy(before)
        after.update(purgeHash='f' * 64, columnValid=True, targetExact=True,
                     trigger={'definition': helper.TRIGGER, 'enabled': 'O'}, constraints=helper.constraint_spec(source))
        after['ledger'].append({'version': helper.VERSION, 'name': helper.NAME, 'dimensions': '[1:1]',
                                'cardinality': 1, 'sourceSha256': '1' * 64})
        for sig, spec in helper.function_spec(source).items():
            if spec['before'] is None:
                after['functions'][sig] = {'sha256': spec['after'], 'metadata': {}, 'portable': spec['portable']}
            else:
                after['functions'][sig]['sha256'] = spec['after']
        helper.verify_after(after, before, source, 'f' * 64)
        for field in ['major', 'dataHash', 'securityHash', 'receiptHash', 'purgeHash', 'purgeMatches',
                      'predecessorExact', 'targetExact', 'columnValid', 'enabledCount', 'constraints', 'trigger']:
            drift = copy.deepcopy(after)
            drift[field] = None
            with self.subTest(field=field), self.assertRaises(SystemExit):
                helper.verify_after(drift, before, source, 'f' * 64)
        for sig in helper.SIGNATURES:
            drift = copy.deepcopy(after)
            drift['functions'][sig]['sha256'] = '0' * 64
            with self.subTest(signature=sig), self.assertRaises(SystemExit):
                helper.verify_after(drift, before, source, 'f' * 64)
        drift = copy.deepcopy(after)
        drift['ledger'][0]['dimensions'] = '[0:0]'
        with self.assertRaises(SystemExit):
            helper.verify_after(drift, before, source, 'f' * 64)
        for result in [[], [{}], [{'tradeSchoolResultingCatalogSha256': 'bad'}], [{}, {}]]:
            with self.assertRaises(SystemExit):
                helper.resulting_catalog(result)
        self.assertEqual(helper.resulting_catalog([{'tradeSchoolResultingCatalogSha256': 'f' * 64}]), 'f' * 64)

    def test_apply_has_one_dispatch_independent_readback_and_readonly_idempotence(self):
        helper = load_helper()
        source_sha = helper.sha(helper.MIGRATION.read_bytes())
        source = helper.candidate(source_sha)
        before = synthetic_before(source)
        with tempfile.TemporaryDirectory(prefix='trade-release-unit-') as directory:
            directory = Path(directory)
            snapshot = directory / 'snapshot.json'
            snapshot.write_text(json.dumps(before))
            attestation = directory / 'attestation.json'
            dispatch = directory / 'dispatch.json'
            args = ['apply', '--source-sha', source_sha, '--snapshot', str(snapshot),
                    '--snapshot-sha', helper.sha(snapshot.read_bytes()), '--head', 'a' * 40,
                    '--helper-sha', helper.sha(HELPER.read_bytes()), '--attestation', str(attestation), '--dispatch', str(dispatch)]
            with patch.object(helper, 'clean_source') as clean, \
                 patch.object(helper, 'api', return_value={'id': helper.PROJECT, 'organization_id': helper.ORGANISATION}) as api, \
                 patch.object(helper, 'read_state', side_effect=[before, {'nativeAfter': True}]) as reads, \
                 patch.object(helper, 'query', return_value=[{'tradeSchoolResultingCatalogSha256': 'f' * 64}]) as writes, \
                 patch.object(helper, 'verify_after') as verify, contextlib.redirect_stdout(io.StringIO()):
                helper.main(args)
                self.assertEqual(clean.call_count, 1)
                self.assertEqual(api.call_args.args, ('',))
                self.assertEqual(writes.call_count, 1)
                self.assertEqual(reads.call_count, 2)
                self.assertEqual(writes.call_args.args[0], helper.transaction(source, before))
                self.assertEqual(verify.call_args.args, ({'nativeAfter': True}, before, source, 'f' * 64))
            self.assertTrue(dispatch.is_file())
            receipt = json.loads(attestation.read_bytes())
            self.assertEqual(receipt['transactionSha256'], helper.sha(helper.transaction(source, before).encode()))
            recorded = copy.deepcopy(before)
            recorded['ledger'].append({'version': helper.VERSION})
            with patch.object(helper, 'clean_source'), \
                 patch.object(helper, 'api', return_value={'id': helper.PROJECT, 'organization_id': helper.ORGANISATION}), \
                 patch.object(helper, 'read_state', return_value=recorded), \
                 patch.object(helper, 'query', side_effect=AssertionError('Idempotence must be reads only')), \
                 patch.object(helper, 'verify_after') as verify, contextlib.redirect_stdout(io.StringIO()):
                helper.main(args + ['--attestation-sha', helper.sha(attestation.read_bytes())])
                self.assertEqual(verify.call_count, 1)
            attestation.unlink()
            with patch.object(helper, 'clean_source'), \
                 patch.object(helper, 'api', return_value={'id': helper.PROJECT, 'organization_id': helper.ORGANISATION}), \
                 patch.object(helper, 'read_state', return_value=before), \
                 patch.object(helper, 'query', side_effect=AssertionError('Spent dispatch must not retry')), self.assertRaises(SystemExit):
                helper.main(args)


    def test_clean_git_requires_explicit_head_source_helper_and_exact_target(self):
        helper = load_helper()
        head = 'a' * 40
        def git(args, **kwargs):
            command = args[1:]
            if command == ['rev-parse', 'HEAD']:
                return (head + '\n').encode()
            if command == ['status', '--porcelain']:
                return b''
            if command == ['remote', 'get-url', 'origin']:
                return b'https://github.com/mobilityaccessmodifications/mam-team-management-system.git\n'
            if command == ['show', '-s', '--format=%an <%ae>', 'HEAD']:
                return b'mobilityaccessmodifications <310802599+mobilityaccessmodifications@users.noreply.github.com>\n'
            if command[0] == 'show' and command[1].startswith(head + ':'):
                return (ROOT / command[1].split(':', 1)[1]).read_bytes()
            raise AssertionError(command)
        source_sha, helper_sha = helper.sha(helper.MIGRATION.read_bytes()), helper.sha(HELPER.read_bytes())
        with patch.object(helper.Path, 'cwd', return_value=ROOT), patch.object(helper.subprocess, 'check_output', side_effect=git):
            helper.clean_source(head, source_sha, helper_sha)
            for arguments in [(head[:-1], source_sha, helper_sha), (head, '0' * 64, helper_sha), (head, source_sha, None)]:
                with self.subTest(arguments=arguments), self.assertRaises(SystemExit):
                    helper.clean_source(*arguments)
        for rejected in [b'?? unrelated-file\n', b'M source.sql\n']:
            def dirty(args, **kwargs):
                return rejected if args[1:] == ['status', '--porcelain'] else git(args, **kwargs)
            with patch.object(helper.Path, 'cwd', return_value=ROOT), patch.object(helper.subprocess, 'check_output', side_effect=dirty), self.assertRaises(SystemExit):
                helper.clean_source(head, source_sha, helper_sha)


if __name__ == '__main__':
    unittest.main()
