import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const program = String.raw`
import ast
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE_ROOT = Path.cwd().resolve()
HELPER = 'scripts/deploy-day-one-reporting-splice-claims.py'
MIGRATION = 'supabase/migrations/20261013200000_day_one_reporting_splice_claims.sql'
TASK_TMP = Path(tempfile.gettempdir()).resolve()
REMOTE = 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git'
AUTHOR = 'mobilityaccessmodifications'
EMAIL = '310802599+mobilityaccessmodifications@users.noreply.github.com'

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def array_digest(raw):
    source = raw.decode('utf-8')
    escaped = source.replace('\\', '\\\\').replace('"', '\\"')
    return digest(('{"' + escaped + '"}').encode())

def source_pins():
    tree = ast.parse((SOURCE_ROOT / HELPER).read_bytes())
    return next(ast.literal_eval(node.value) for node in tree.body
                if isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == 'PINS'
                        for target in node.targets))

class Fixture:
    def __enter__(self):
        self.temp = tempfile.TemporaryDirectory(prefix='offline-committed-', dir=TASK_TMP)
        self.base = Path(self.temp.name)
        self.base.chmod(0o700)
        self.root = self.base / 'source'
        self.artifacts = self.base / 'private-artifacts'
        self.root.mkdir(mode=0o700)
        self.artifacts.mkdir(mode=0o700)
        paths = list(source_pins()) + [HELPER, MIGRATION]
        for relative in paths:
            destination = self.root / relative
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            destination.write_bytes((SOURCE_ROOT / relative).read_bytes())
            destination.chmod(0o600)
        environment = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TMPDIR')
                       if key in os.environ}
        environment.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                           PYTHONDONTWRITEBYTECODE='1')
        self.environment = patch.dict(os.environ, environment, clear=True)
        self.environment.start()
        self.old_cwd = Path.cwd()
        os.chdir(self.root)
        def git(*args):
            return subprocess.check_output(['git', '-c', 'core.hooksPath=' + os.devnull,
                                            '-c', 'core.fsmonitor=false', *args],
                                           cwd=self.root, stderr=subprocess.DEVNULL)
        git('init', '--template=', '--initial-branch=codex/offline-day-one')
        git('config', '--local', 'user.name', AUTHOR)
        git('config', '--local', 'user.email', EMAIL)
        git('config', '--local', 'core.autocrlf', 'false')
        git('remote', 'add', 'origin', REMOTE)
        git('add', '--', *paths)
        git('commit', '-m', 'Synthetic committed Day1 release guard fixture')
        self.head = git('rev-parse', 'HEAD').decode().strip()
        self.helper_sha = digest((self.root / HELPER).read_bytes())
        self.source = (self.root / MIGRATION).read_bytes()
        self.source_sha = digest(self.source)
        spec = importlib.util.spec_from_file_location('offline_day_one_helper', self.root / HELPER)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.snapshot = self.artifacts / 'before.json'
        self.dispatch = self.artifacts / 'dispatch.json'
        self.receipt = self.artifacts / 'receipt.json'
        self.catalog = 'f' * 64
        rows = []
        for version, dimensions, count, array_text in (
            ('19000101000000', None, None, '<NULL>'),
            ('19000101000001', None, 0, '{}'),
            ('19000101000002', '[0:0]', 1, '[0:0]={legacy}'),
            ('19000101000003', '[-2:-1]', 2, '[-2:-1]={old,history}'),
        ):
            rows.append(dict(version=version, name='synthetic_history', dimensions=dimensions,
                             cardinality=count, sourceSha256=digest(array_text.encode())))
        for version, name in (('20261013120000', 'annual_continuous_accrual'),
                              ('20261013170000', 'subscription_review_tasks'),
                              ('20261013180000', 'leave_required_employee_note')):
            raw = (self.root / 'supabase/migrations' / (version + '_' + name + '.sql')).read_bytes()
            rows.append(dict(version=version, name=name, dimensions='[1:1]', cardinality=1,
                             sourceSha256=array_digest(raw)))
        self.before = dict(major=16, dataHash='1' * 64, securityHash='2' * 64,
                           receiptHash='3' * 64, purgeHash='4' * 64, purgeMatches=True,
                           collectorSha256=self.module.COLLECTOR_SHA, predecessorExact=True,
                           publishedAndInitialExact=True, targetExact=False,
                           functionSha256=self.module.BEFORE_SHA,
                           functionMetadata=dict(oid=12345, proowner=10,
                                                 proacl=['postgres=X/postgres'],
                                                 proconfig=['search_path=""'],
                                                 prosecdef=True, parameter_defaults=None),
                           functionPortableExact=True, historicalLedgerHash='5' * 64,
                           ledger=rows)
        self.after = copy.deepcopy(self.before)
        self.after.update(purgeHash=self.catalog, targetExact=True,
                          functionSha256=self.module.AFTER_SHA)
        self.after['ledger'].append(dict(version=self.module.VERSION, name=self.module.NAME,
                                          dimensions='[1:1]', cardinality=1,
                                          sourceSha256=array_digest(self.source)))
        self.current = copy.deepcopy(self.before)
        self.api_calls = 0
        self.query_calls = []
        self.write_queries = []
        self.on_api = None
        self.on_write = None
        self.api_patch = patch.object(self.module, 'api', side_effect=self.api)
        self.query_patch = patch.object(self.module, 'query', side_effect=self.query)
        self.api_mock = self.api_patch.start()
        self.query_mock = self.query_patch.start()
        self.network_patch = patch('urllib.request.urlopen', side_effect=AssertionError('Unexpected network access'))
        self.network_patch.start()
        return self

    def __exit__(self, *args):
        self.network_patch.stop()
        self.query_patch.stop()
        self.api_patch.stop()
        os.chdir(self.old_cwd)
        self.environment.stop()
        self.temp.cleanup()

    def api(self, path):
        assert path == ''
        self.api_calls += 1
        if self.on_api:
            self.on_api()
        return dict(id=self.module.PROJECT, organization_id=self.module.ORGANISATION)

    def query(self, sql):
        self.query_calls.append(sql)
        if sql.startswith('begin read only;'):
            return [dict(state=copy.deepcopy(self.current))]
        expected = self.module.transaction(self.source.decode(), self.module.load_json(self.snapshot.read_bytes()))
        assert sql == expected, 'Public write differs from independently captured source/snapshot transaction'
        self.write_queries.append(sql)
        if self.on_write:
            return self.on_write()
        self.current = copy.deepcopy(self.after)
        return [dict(dayOneSpliceResultingCatalogSha256=self.catalog)]

    def argv(self, action, attested=False):
        args = [action, '--source-sha', self.source_sha, '--snapshot', str(self.snapshot),
                '--head', self.head, '--helper-sha', self.helper_sha]
        if action != 'prepare':
            args += ['--snapshot-sha', digest(self.snapshot.read_bytes())]
        if action == 'apply' or attested:
            args += ['--dispatch', str(self.dispatch), '--attestation', str(self.receipt)]
        if attested:
            args += ['--attestation-sha', digest(self.receipt.read_bytes())]
        return args

    def call(self, action, attested=False, args=None):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.module.main(self.argv(action, attested) if args is None else args)
        return output.getvalue()

    def capture_failure(self, action, attested=False, args=None):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            try:
                self.module.main(self.argv(action, attested) if args is None else args)
            except SystemExit as error:
                return str(error), output.getvalue()
        raise AssertionError('Release unexpectedly accepted negative fixture')

    def edit_json(self, path, change):
        value = json.loads(path.read_bytes())
        change(value)
        path.write_text(json.dumps(value, sort_keys=True) + '\n')
        path.chmod(0o600)

class DayOneReleaseGuards(unittest.TestCase):
    def test_public_success_exact_one_write_and_attested_readback(self):
        with Fixture() as f:
            self.assertIn('targetVerified', f.call('prepare'))
            snapshot = f.snapshot.read_bytes()
            self.assertIn('predecessorMatches', f.call('inspect'))
            self.assertEqual(f.write_queries, [])
            output = f.call('apply')
            self.assertIn('"committed": true', output)
            self.assertEqual(len(f.write_queries), 1)
            identity = dict(project=f.module.PROJECT, organization=f.module.ORGANISATION,
                            version=f.module.VERSION, head=f.head, sourceSha256=f.source_sha,
                            snapshotSha256=digest(snapshot),
                            transactionSha256=digest(f.write_queries[0].encode()))
            self.assertEqual(json.loads(f.dispatch.read_bytes()), identity)
            self.assertEqual(json.loads(f.receipt.read_bytes()),
                             dict(identity, resultingCatalogSha256=f.catalog))
            receipt = f.receipt.read_bytes()
            dispatch = f.dispatch.read_bytes()
            self.assertIn('readbackVerified', f.call('inspect', attested=True))
            self.assertIn('recorded', f.call('apply', attested=True))
            self.assertEqual(len(f.write_queries), 1)
            self.assertEqual(f.snapshot.read_bytes(), snapshot)
            self.assertEqual(f.receipt.read_bytes(), receipt)
            self.assertEqual(f.dispatch.read_bytes(), dispatch)

    def test_receipt_identity_swap_is_rejected_before_provider(self):
        with Fixture() as f:
            f.call('prepare')
            f.call('apply')
            f.edit_json(f.receipt, lambda value: value.update(transactionSha256='0' * 64))
            f.api_mock.reset_mock()
            f.query_mock.reset_mock()
            message, output = f.capture_failure('inspect', attested=True)
            self.assertIn('attestation', message)
            f.api_mock.assert_not_called()
            f.query_mock.assert_not_called()
            self.assertEqual(len(f.write_queries), 1)

    def test_dispatch_identity_swap_is_rejected_before_provider(self):
        with Fixture() as f:
            f.call('prepare')
            f.call('apply')
            f.edit_json(f.dispatch, lambda value: value.update(snapshotSha256='0' * 64))
            f.api_mock.reset_mock()
            f.query_mock.reset_mock()
            message, output = f.capture_failure('inspect', attested=True)
            self.assertIn('dispatch', message)
            f.api_mock.assert_not_called()
            f.query_mock.assert_not_called()
            self.assertEqual(len(f.write_queries), 1)

    def test_source_mutation_after_api_blocks_query(self):
        with Fixture() as f:
            f.on_api = lambda: (f.root / HELPER).write_bytes((f.root / HELPER).read_bytes() + b'\n')
            message, output = f.capture_failure('prepare')
            self.assertIn('sourceHold', output)
            self.assertIn('"enteredWrite": false', output)
            f.query_mock.assert_not_called()
            self.assertFalse(f.snapshot.exists())
            self.assertEqual(f.write_queries, [])

    def test_snapshot_mutation_after_api_blocks_query(self):
        with Fixture() as f:
            f.call('prepare')
            f.query_mock.reset_mock()
            f.on_api = lambda: f.snapshot.write_bytes(f.snapshot.read_bytes() + b'\n')
            args = f.argv('apply')
            message, output = f.capture_failure('apply', args=args)
            self.assertIn('sourceHold', output)
            self.assertIn('"enteredWrite": false', output)
            f.query_mock.assert_not_called()
            self.assertFalse(f.dispatch.exists())
            self.assertFalse(f.receipt.exists())
            self.assertEqual(f.write_queries, [])

    def test_unknown_write_outcome_spends_dispatch_and_denies_retry(self):
        for committed in (False, True):
            with self.subTest(committed=committed), Fixture() as f:
                f.call('prepare')
                def unknown():
                    if committed:
                        f.current = copy.deepcopy(f.after)
                    raise OSError('Synthetic lost COMMIT acknowledgement')
                f.on_write = unknown
                message, output = f.capture_failure('apply')
                self.assertIn('never retry', message)
                self.assertIn('"dispatchSpent": true', output)
                self.assertEqual(len(f.write_queries), 1)
                self.assertTrue(f.dispatch.exists())
                self.assertFalse(f.receipt.exists())
                dispatch = f.dispatch.read_bytes()
                message, output = f.capture_failure('apply')
                self.assertEqual(len(f.write_queries), 1)
                self.assertEqual(f.dispatch.read_bytes(), dispatch)
                self.assertFalse(f.receipt.exists())

    def test_source_mutation_during_write_holds_spent_dispatch(self):
        with Fixture() as f:
            f.call('prepare')
            def drift():
                (f.root / HELPER).write_bytes((f.root / HELPER).read_bytes() + b'\n')
                f.current = copy.deepcopy(f.after)
                return [dict(dayOneSpliceResultingCatalogSha256=f.catalog)]
            f.on_write = drift
            message, output = f.capture_failure('apply')
            self.assertIn('sourceHold', output)
            self.assertIn('"enteredWrite": true', output)
            self.assertIn('"retryAllowed": false', output)
            self.assertIn('"dispatchSpent": true', output)
            self.assertTrue(f.dispatch.exists())
            self.assertFalse(f.receipt.exists())
            self.assertEqual(len(f.write_queries), 1)
            f.api_mock.reset_mock()
            f.query_mock.reset_mock()
            f.capture_failure('apply')
            f.api_mock.assert_not_called()
            f.query_mock.assert_not_called()
            self.assertEqual(len(f.write_queries), 1)

    def test_strict_raw_ledger_dimensions_and_bool_cardinality(self):
        changes = [dict(cardinality=True, dimensions='[1:1]'),
                   dict(cardinality=False, dimensions=None),
                   dict(cardinality=1, dimensions='[1:1][1:1]'),
                   dict(cardinality=2, dimensions='[1:1]'),
                   dict(cardinality=1, dimensions=None),
                   dict(cardinality=0, dimensions='[1:0]'),
                   dict(cardinality=None, dimensions='[1:1]'),
                   dict(cardinality=1, dimensions='[2147483648:2147483648]'),
                   dict(name=None)]
        for change in changes:
            with self.subTest(change=change), Fixture() as f:
                f.current['ledger'][0].update(change)
                f.capture_failure('prepare')
                self.assertFalse(f.snapshot.exists())
                self.assertFalse(f.dispatch.exists())
                self.assertEqual(f.write_queries, [])

if __name__ == '__main__':
    unittest.main(argv=['day-one-release-offline', *sys.argv[1:]], verbosity=2)
`;

test('Day1 release public flow and fail-closed guards with committed synthetic source', () => {
  const args = ['-B', '-c', program];
  const result = spawnSync('python3', args, { cwd: process.cwd(), encoding: 'utf8',
    timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran \d+ tests? in/);
  assert.match(result.stderr, /\nOK\s*$/);
});
