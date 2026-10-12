import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'scripts/deploy-employee-removal-reporting-splice.py'


def load_helper(path=HELPER):
    if not path.is_file():
        raise AssertionError('Targeted source-bound reporting-splice release helper is missing')
    spec = importlib.util.spec_from_file_location('reporting_release', path)
    assert spec is not None and spec.loader is not None
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    return helper


@contextlib.contextmanager
def release_source_fixture():
    paths = [HELPER.relative_to(ROOT), Path('scripts/deploy-staff-leave-calendar.py'),
             Path('supabase/migrations/20261012170000_employee_removal_reporting_splice.sql'),
             Path('supabase/migrations/20261012110000_trade_school_leave.sql')]
    with tempfile.TemporaryDirectory(prefix='reporting-source-unit-') as directory:
        parent = Path(directory).resolve()
        root = parent / 'repo'
        root.mkdir()
        home = parent / 'home'
        home.mkdir()
        for path in paths:
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / path).read_bytes())
        environment = {'PATH': os.environ.get('PATH', os.defpath), 'HOME': str(home),
                       'TMPDIR': tempfile.gettempdir(), 'LANG': 'C', 'LC_ALL': 'C',
                       'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull}
        with patch.dict(os.environ, environment, clear=True), patch.object(sys, 'dont_write_bytecode', True):
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=root)
            git('-c', 'init.templateDir=', 'init', '-q')
            git('config', '--local', 'user.name', 'mobilityaccessmodifications')
            git('config', '--local', 'user.email', '310802599+mobilityaccessmodifications@users.noreply.github.com')
            git('config', '--local', 'core.autocrlf', 'false')
            git('remote', 'add', 'origin', 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git')
            git('add', '--', *map(str, paths))
            git('commit', '-q', '-m', 'Synthetic reporting release source fixture')
            head = git('rev-parse', 'HEAD').decode().strip()
            helper = load_helper(root / HELPER.relative_to(ROOT))
            cwd = Path.cwd()
            os.chdir(root)
            try:
                yield helper, head
            finally:
                os.chdir(cwd)


def synthetic_before(source):
    rows = re.findall(r"\('([^']+)',(true|false),(null|'[0-9a-f]{64}'),'([0-9a-f]{64})',", source)
    return {
        'major': 16, 'dataHash': 'a' * 64, 'securityHash': 'b' * 64, 'receiptHash': 'c' * 64,
        'purgeHash': 'd' * 64, 'purgeMatches': True, 'predecessorExact': True, 'targetExact': False,
        'ledger': [{'version': '20261012110000', 'name': 'trade_school_leave',
                    'dimensions': '[1:1]', 'cardinality': 1, 'sourceSha256': 'e' * 64}],
        'functions': {sig: {'sha256': before.strip("'"), 'metadata': {}, 'portable': {}}
                      if existing == 'true' else None for sig, existing, before, after in rows},
        'tradeSchoolEnabledCount': 2, 'targetSourceArraySha256': '1' * 64,
    }


class ReportingSpliceReleaseTests(unittest.TestCase):
    def test_exact_six_function_contract_preserves_the_current_predecessor(self):
        helper = load_helper()
        source = helper.candidate(helper.sha(helper.MIGRATION.read_bytes()))
        specs = helper.function_spec(source)
        self.assertEqual(set(specs), helper.SIGNATURES)
        self.assertEqual(len(specs), 6)
        self.assertEqual(sum(v['before'] is not None for v in specs.values()), 3)
        self.assertEqual(helper.PREDECESSOR_VERSION, '20261012110000')
        self.assertIn('to_jsonb(t) order by', helper.source_function(source, 'reporting_splice_data'))
        self.assertNotIn("to_jsonb(t)-'trade_school_enabled'", source)

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
        self.assertIn('pg_temp.reporting_splice_assert_delta()', transaction[ledger:])
        self.assertIn('pg_temp.reporting_splice_security()', transaction[ledger:])
        self.assertIn('reportingSpliceResultingCatalogSha256', transaction[ledger:])
        self.assertLess(transaction.index('set constraints all immediate;', ledger), transaction.index('do $reporting_splice_release_final$', ledger))


    def test_independent_readback_rejects_every_protected_field(self):
        helper = load_helper()
        source = helper.candidate(helper.sha(helper.MIGRATION.read_bytes()))
        before = synthetic_before(source)
        after = copy.deepcopy(before)
        after.update(purgeHash='f' * 64, targetExact=True)
        after['ledger'].append({'version': helper.VERSION, 'name': helper.NAME, 'dimensions': '[1:1]',
                                'cardinality': 1, 'sourceSha256': '1' * 64})
        for sig, spec in helper.function_spec(source).items():
            if spec['before'] is None:
                after['functions'][sig] = {'sha256': spec['after'], 'metadata': {}, 'portable': spec['portable']}
            else:
                after['functions'][sig]['sha256'] = spec['after']
        helper.verify_after(after, before, source, 'f' * 64)
        for field in ['major', 'dataHash', 'securityHash', 'receiptHash', 'purgeHash', 'purgeMatches',
                      'predecessorExact', 'targetExact', 'tradeSchoolEnabledCount', 'targetSourceArraySha256']:
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
        for result in [[], [{}], [{'reportingSpliceResultingCatalogSha256': 'bad'}], [{}, {}]]:
            with self.assertRaises(SystemExit):
                helper.resulting_catalog(result)
        self.assertEqual(helper.resulting_catalog([{'reportingSpliceResultingCatalogSha256': 'f' * 64}]), 'f' * 64)

    def test_apply_has_one_dispatch_independent_readback_and_readonly_idempotence(self):
        helper = load_helper()
        source_sha = helper.sha(helper.MIGRATION.read_bytes())
        source = helper.candidate(source_sha)
        before = synthetic_before(source)
        with tempfile.TemporaryDirectory(prefix='reporting-release-unit-') as directory:
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
                 patch.object(helper, 'query', return_value=[{'reportingSpliceResultingCatalogSha256': 'f' * 64}]) as writes, \
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
        cwd, environment, bytecode = Path.cwd(), dict(os.environ), sys.dont_write_bytecode
        with release_source_fixture() as (helper, head):
            fixture = helper.ROOT
            assert helper.__file__ is not None and helper.SHARED.__file__ is not None
            source_sha = helper.sha(helper.MIGRATION.read_bytes())
            helper_sha = helper.sha(Path(helper.__file__).read_bytes())
            self.assertEqual(fixture, Path.cwd().resolve())
            self.assertEqual(Path(helper.__file__).read_bytes(), HELPER.read_bytes())
            self.assertEqual(Path(helper.SHARED.__file__).read_bytes(), (ROOT / 'scripts/deploy-staff-leave-calendar.py').read_bytes())
            self.assertEqual(helper.PREDECESSOR.read_bytes(), (ROOT / helper.PREDECESSOR.relative_to(fixture)).read_bytes())
            helper.state_expression(helper.candidate(source_sha))
            helper.clean_source(head, source_sha, helper_sha)
            for arguments in [(head[:-1], source_sha, helper_sha), (head, '0' * 64, helper_sha), (head, source_sha, None),
                              (None, source_sha, helper_sha), ('0' * 40, source_sha, helper_sha), (head, source_sha, '0' * 64)]:
                with self.subTest(arguments=arguments), self.assertRaises(SystemExit):
                    helper.clean_source(*arguments)
            os.chdir(fixture.parent)
            try:
                with self.assertRaisesRegex(SystemExit, 'Exact approved root and full reviewed HEAD required'):
                    helper.clean_source(head, source_sha, helper_sha)
            finally:
                os.chdir(fixture)
            for path in [fixture / 'unrelated-file', helper.MIGRATION]:
                raw = path.read_bytes() if path.exists() else None
                path.write_bytes((raw or b'') + b'\nsynthetic dirty source\n')
                try:
                    self.assertTrue(subprocess.check_output(['git', 'status', '--porcelain'], cwd=fixture).strip())
                    with self.subTest(path=path), self.assertRaisesRegex(SystemExit, 'Release tree must be clean'):
                        helper.clean_source(head, source_sha, helper_sha)
                finally:
                    path.unlink() if raw is None else path.write_bytes(raw)
            subprocess.check_output(['git', 'remote', 'set-url', 'origin', 'https://github.com/example/synthetic.git'], cwd=fixture)
            with self.assertRaisesRegex(SystemExit, 'Wrong MAM Git remote'):
                helper.clean_source(head, source_sha, helper_sha)
            subprocess.check_output(['git', 'remote', 'set-url', 'origin', 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git'], cwd=fixture)
            subprocess.check_output(['git', 'config', '--local', 'user.email', 'ai@mobilityaccess.com.au'], cwd=fixture)
            subprocess.check_output(['git', 'commit', '--amend', '--reset-author', '--no-edit', '-q'], cwd=fixture)
            rejected_head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=fixture).decode().strip()
            with self.assertRaisesRegex(SystemExit, 'Wrong MAM source author'):
                helper.clean_source(rejected_head, source_sha, helper_sha)
        self.assertEqual(Path.cwd(), cwd)
        self.assertEqual(dict(os.environ), environment)
        self.assertEqual(sys.dont_write_bytecode, bytecode)
        self.assertFalse(fixture.parent.exists())


    def test_raw_ledger_shapes_are_finite_and_malformed_shapes_fail_closed(self):
        helper = load_helper()
        source = helper.candidate(helper.sha(helper.MIGRATION.read_bytes()))
        before = synthetic_before(source)
        for cardinality, dimensions in [(None, None), (0, None), (2, '[0:1]')]:
            valid = copy.deepcopy(before)
            valid['ledger'].insert(0, {'version': '20260908000020', 'name': '20260907230409_archive_combined_employment_account_disable', 'cardinality': cardinality, 'dimensions': dimensions, 'sourceSha256': '9' * 64})
            helper.validate_before(valid, source)
        for cardinality, dimensions in [(True, '[1:1]'), (-1, None), (2, '[1:1]'), (2, '[1:1][1:2]'), (None, '[1:1]')]:
            invalid = copy.deepcopy(before)
            invalid['ledger'][0].update(cardinality=cardinality, dimensions=dimensions)
            with self.subTest(cardinality=cardinality, dimensions=dimensions), self.assertRaises(SystemExit):
                helper.validate_before(invalid, source)

    def test_source_bytes_known_pins_json_and_actual_dirty_tree_reject_before_transport(self):
        with release_source_fixture() as (helper, head):
            raw = helper.MIGRATION.read_bytes()
            source = helper.candidate(helper.sha(raw))
            for sig, pin in helper.BEFORE_SHAS.items():
                with self.subTest(signature=sig), self.assertRaises(SystemExit):
                    helper.function_spec(source.replace(pin, '0' * 64))
            with tempfile.TemporaryDirectory(prefix='reporting-source-corrupt-unit-') as directory:
                file = Path(directory) / 'source.sql'
                file.write_bytes(raw.replace(b'\n', b'\r\n'))
                with patch.object(helper, 'MIGRATION', file), self.assertRaises(SystemExit):
                    helper.candidate(helper.sha(raw))
                with patch.object(helper, 'MIGRATION', file), self.assertRaises(SystemExit):
                    helper.candidate(helper.sha(file.read_bytes()))
            for raw_json in ['{"x":1,"x":2}', '{"x":NaN}', '{"x":Infinity}', '{"x":-Infinity}']:
                with self.subTest(raw_json=raw_json), self.assertRaises(SystemExit):
                    helper.load_json(raw_json)
            fixture_helper = helper.ROOT / HELPER.relative_to(ROOT)
            helper_sha = helper.sha(fixture_helper.read_bytes())
            self.assertEqual(raw, (ROOT / helper.MIGRATION.relative_to(helper.ROOT)).read_bytes())
            self.assertEqual(subprocess.check_output(['git', 'status', '--porcelain'], cwd=helper.ROOT), b'')
            helper.clean_source(head, helper.sha(raw), helper_sha)
            dirty = helper.ROOT / 'unrelated-file'
            dirty.write_text('synthetic only\n')
            self.assertNotIn('SUPABASE_ACCESS_TOKEN', os.environ)
            with patch.object(helper, 'api', side_effect=AssertionError('Dirty source must stop before credentials/transport')) as transport, \
                 patch.object(helper, 'query', side_effect=AssertionError('Dirty source must stop before query dispatch')) as queries, \
                 self.assertRaisesRegex(SystemExit, 'Release tree must be clean'):
                helper.main(['apply', '--source-sha', helper.sha(raw), '--snapshot', str(helper.ROOT / 'synthetic-not-created.json'), '--head', head, '--helper-sha', helper_sha])
            transport.assert_not_called()
            queries.assert_not_called()
            self.assertFalse((helper.ROOT / 'synthetic-not-created.json').exists())
            dirty.unlink()
            self.assertEqual(subprocess.check_output(['git', 'status', '--porcelain'], cwd=helper.ROOT), b'')
            helper.clean_source(head, helper.sha(raw), helper_sha)

    def test_full_migration_job_installs_git_for_unprivileged_release_tests(self):
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        job = workflow.split('  full-migration-replay-and-openclaw:\n', 1)[1].split('\n  annual-leave-all-submitters:', 1)[0]
        packages = re.findall(r'^\s+apt-get install -y --no-install-recommends ([^\n]+)$', job, re.MULTILINE)
        self.assertEqual(len(packages), 1)
        self.assertIn('python3', packages[0].split())
        self.assertIn('git', packages[0].split())
        self.assertIn('runuser -u postgres -- python3 --version', job)
        self.assertIn('runuser -u postgres -- git --version', job)
        self.assertIn("postgres: ['16', '17']", job)
        self.assertIn('container: postgres:${{ matrix.postgres }}', job)
        self.assertIn('runuser -u postgres -- node scripts/test-sql.mjs', job)

    def test_unknown_dispatch_spends_journal_and_only_reconciles_read_only(self):
        helper = load_helper()
        source_sha = helper.sha(helper.MIGRATION.read_bytes())
        source = helper.candidate(source_sha)
        before = synthetic_before(source)
        with tempfile.TemporaryDirectory(prefix='reporting-unknown-unit-') as directory:
            directory = Path(directory)
            snapshot, dispatch, attestation = [directory / name for name in ['snapshot.json', 'dispatch.json', 'attestation.json']]
            snapshot.write_text(json.dumps(before))
            args = ['apply', '--source-sha', source_sha, '--snapshot', str(snapshot), '--snapshot-sha', helper.sha(snapshot.read_bytes()), '--head', 'a' * 40, '--helper-sha', helper.sha(HELPER.read_bytes()), '--attestation', str(attestation), '--dispatch', str(dispatch)]
            with patch.object(helper, 'clean_source'), patch.object(helper, 'api', return_value={'id': helper.PROJECT, 'organization_id': helper.ORGANISATION}), patch.object(helper, 'read_state', return_value=before) as reads, patch.object(helper, 'query', return_value=[]) as write, contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(SystemExit, 'Write outcome unverified'):
                helper.main(args)
            self.assertEqual(write.call_count, 1)
            self.assertEqual(reads.call_count, 2)
            self.assertTrue(dispatch.is_file())
            self.assertFalse(attestation.exists())
            with patch.object(helper, 'clean_source'), patch.object(helper, 'api', return_value={'id': helper.PROJECT, 'organization_id': helper.ORGANISATION}), patch.object(helper, 'read_state', return_value=before), patch.object(helper, 'query', side_effect=AssertionError('Unknown write must never repeat')), self.assertRaises(SystemExit):
                helper.main(args)


if __name__ == '__main__':
    unittest.main()
