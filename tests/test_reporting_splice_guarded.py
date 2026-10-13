import contextlib
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

ROOT = Path(__file__).resolve().parents[1]
ADAPTER = Path('scripts/deploy-reporting-splice-guarded.py')
HELPER = Path('scripts/deploy-employee-removal-reporting-splice.py')
TRANSPORT = Path('scripts/deploy-staff-leave-calendar.py')
CORE = Path('supabase/migrations/20261012170000_employee_removal_reporting_splice.sql')
PREDECESSOR = Path('supabase/migrations/20261012110000_trade_school_leave.sql')
CLOSURE = [ADAPTER, HELPER, TRANSPORT, CORE, PREDECESSOR]


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@contextlib.contextmanager
def source_fixture():
    with tempfile.TemporaryDirectory(prefix='f65-guard-unit-') as directory:
        parent = Path(directory).resolve()
        root, home = parent / 'repo', parent / 'home'
        root.mkdir()
        home.mkdir()
        paths = [p for p in CLOSURE if (ROOT / p).exists()]
        for path in paths:
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / path).read_bytes())
        environment = {'PATH': os.environ.get('PATH', os.defpath), 'HOME': str(home),
                       'TMPDIR': tempfile.gettempdir(), 'LANG': 'C', 'LC_ALL': 'C',
                       'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
                       'PYTHONDONTWRITEBYTECODE': '1'}
        cwd = Path.cwd()
        with patch.dict(os.environ, environment, clear=True), patch.object(sys, 'dont_write_bytecode', True):
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=root, stderr=subprocess.PIPE)
            git('-c', 'init.templateDir=', 'init', '-q')
            git('config', '--local', 'user.name', 'mobilityaccessmodifications')
            git('config', '--local', 'user.email', '310802599+mobilityaccessmodifications@users.noreply.github.com')
            git('config', '--local', 'core.autocrlf', 'false')
            git('remote', 'add', 'origin', 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git')
            git('add', '--', *map(str, paths))
            git('commit', '-q', '-m', 'Synthetic F65 guard source fixture only')
            head = git('rev-parse', 'HEAD').decode().strip()
            pins = {p: digest((root / p).read_bytes()) for p in paths}
            os.chdir(root)
            try:
                yield root, parent, head, pins, git
            finally:
                os.chdir(cwd)


def adapter_for(root, head, pins):
    module = load(root / ADAPTER, 'f65_guard_fixture')
    return module.ReleaseAdapter(head, pins[ADAPTER], pins[HELPER], pins[TRANSPORT], pins[CORE])


class GuardedReportingSpliceTests(unittest.TestCase):
    def setUp(self):
        trap = patch('urllib.request.urlopen', side_effect=AssertionError('Offline synthetic fixture: network forbidden'))
        trap.start()
        self.addCleanup(trap.stop)

    def test_sql_gate_runs_new_guard_units_as_a_separate_process(self):
        runner = (ROOT / 'tests/run-reporting-splice-sql.mjs').read_text()
        self.assertIn("'-p', 'test_reporting_splice_guarded.py'", runner)
        self.assertIn('Reporting-splice guarded outer adapter tests', runner)
        self.assertIn("'-p', 'test_reporting_splice_release.py'", runner)

    def test_snapshot_reads_do_not_treat_access_time_as_source_drift(self):
        with source_fixture() as (root, parent, head, pins, git):
            module = load(root / ADAPTER, 'f65_atime_regression')
            target = parent / 'fresh-input'
            raw = b'synthetic public source bytes\n'
            target.write_bytes(raw)
            os.utime(target, ns=(1, target.stat().st_mtime_ns))
            before = target.stat()
            try:
                observed = module.snapshot(target)
            except SystemExit as error:
                self.fail('Immutable snapshot falsely rejected a native access-time update: ' + str(error))
            self.assertEqual(observed, raw)
            after = target.stat()
            self.assertEqual((before.st_ino, before.st_size, before.st_mtime_ns), (after.st_ino, after.st_size, after.st_mtime_ns))

    def test_actual_f65_inert_entrypoint_never_executes_replaced_transport(self):
        legacy_red = os.environ.get('F65_GUARD_LEGACY_RED') == '1'
        with source_fixture() as (root, parent, head, pins, git):
            path, marker = root / TRANSPORT, parent / 'transport-sentinel'
            measured = path.read_bytes()
            replacement = ("from pathlib import Path\nPath(" + repr(str(marker)) + ").write_text('INERT SENTINEL EXECUTED')\n").encode() + measured
            if legacy_red:
                path.write_bytes(replacement)
                helper = load(root / HELPER, 'legacy_f65_inert')
            else:
                module = load(root / ADAPTER, 'f65_guard_fixture')
                execute = module.SourceSnapshotLoader.exec_module
                def replace_before_first_statement(loader, unit):
                    if unit.__name__ == 'guarded_reporting_splice_legacy':
                        path.write_bytes(replacement)
                        try:
                            return execute(loader, unit)
                        finally:
                            path.write_bytes(measured)
                    return execute(loader, unit)
                with patch.object(module.SourceSnapshotLoader, 'exec_module', replace_before_first_statement):
                    adapter = module.ReleaseAdapter(head, pins[ADAPTER], pins[HELPER], pins[TRANSPORT], pins[CORE])
                helper = adapter.helper
                self.assertEqual(helper.SHARED.__loader__.raw, measured)
                self.assertEqual(helper.SHARED.__file__, str(path))
                self.assertEqual(helper.ROOT, root)
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as result:
                helper.main(['--help'])
            self.assertEqual(result.exception.code, 0)
            self.assertFalse(marker.exists(), 'Actual F65 pathname loader executed bytes different from the measured transport')
            path.write_bytes(measured)


def model_before(helper, source):
    specs = helper.function_spec(source)
    return {'major': 16, 'dataHash': 'a' * 64, 'securityHash': 'b' * 64, 'receiptHash': 'c' * 64,
            'purgeHash': 'd' * 64, 'purgeMatches': True, 'predecessorExact': True, 'targetExact': False,
            'ledger': [{'version': helper.PREDECESSOR_VERSION, 'name': helper.PREDECESSOR_NAME,
                        'dimensions': '[1:1]', 'cardinality': 1, 'sourceSha256': 'e' * 64}],
            'functions': {sig: {'sha256': spec['before'], 'metadata': {}, 'portable': {}} if spec['before'] else None for sig, spec in specs.items()},
            'tradeSchoolEnabledCount': 2, 'targetSourceArraySha256': '1' * 64,
            'dbRoleSettingHash': '2' * 64, 'dbRoleSettingCount': 3, 'dbRoleSettingShapeHash': '3' * 64}


class GuardedSettingsTests(unittest.TestCase):
    def test_new_transaction_adds_only_removable_guard_blocks(self):
        with source_fixture() as (root, parent, head, pins, git):
            adapter = adapter_for(root, head, pins)
            helper = adapter.helper
            source = helper.candidate(pins[CORE])
            before = model_before(helper, source)
            original = helper.transaction(source, {k: v for k, v in before.items() if not k.startswith('dbRoleSetting')})
            builder = getattr(adapter, 'transaction', helper.transaction)
            guarded = builder(source, before)
            self.assertIn('do $reporting_splice_guard_settings_before$', guarded, 'Native setting inventory is absent from the actual outer query')
            blocks = adapter.guard_blocks(before)
            for block in blocks:
                self.assertEqual(guarded.count(block), 1)
                guarded = guarded.replace(block, '', 1)
            self.assertEqual(guarded.encode(), original.encode())

    def test_independent_readback_rejects_settings_drift(self):
        import copy
        with source_fixture() as (root, parent, head, pins, git):
            adapter = adapter_for(root, head, pins)
            helper = adapter.helper
            source = helper.candidate(pins[CORE])
            before = model_before(helper, source)
            after = copy.deepcopy(before)
            after.update(purgeHash='f' * 64, targetExact=True)
            after['ledger'].append({'version': helper.VERSION, 'name': helper.NAME, 'dimensions': '[1:1]', 'cardinality': 1, 'sourceSha256': '1' * 64})
            for sig, spec in helper.function_spec(source).items():
                after['functions'][sig] = {'sha256': spec['after'], 'metadata': {}, 'portable': spec['portable'] or {}}
            verify = getattr(adapter, 'verify_after', helper.verify_after)
            verify(after, before, source, 'f' * 64)
            for field in ('dbRoleSettingHash', 'dbRoleSettingCount', 'dbRoleSettingShapeHash'):
                drift = copy.deepcopy(after)
                drift[field] = '0' * 64 if field != 'dbRoleSettingCount' else 4
                with self.subTest(field=field), self.assertRaises(SystemExit):
                    verify(drift, before, source, 'f' * 64)


class GuardedEntrypointTests(unittest.TestCase):
    def test_actual_entrypoint_uses_public_query_and_recorded_apply_is_readonly(self):
        import copy
        with source_fixture() as (root, parent, head, pins, git):
            adapter = adapter_for(root, head, pins)
            helper = adapter.helper
            source = helper.candidate(pins[CORE])
            before = model_before(helper, source)
            after = copy.deepcopy(before)
            after.update(purgeHash='f' * 64, targetExact=True)
            after['ledger'].append({'version': helper.VERSION, 'name': helper.NAME, 'dimensions': '[1:1]', 'cardinality': 1, 'sourceSha256': '1' * 64})
            for sig, spec in helper.function_spec(source).items():
                after['functions'][sig] = {'sha256': spec['after'], 'metadata': {}, 'portable': spec['portable'] or {}}
            snapshot_path = parent / 'model-snapshot.json'
            helper.retain(snapshot_path, before)
            captured = helper.load_json(snapshot_path.read_bytes())
            expected = adapter.transaction(source, captured)
            attestation, dispatch = parent / 'model-attestation.json', parent / 'model-dispatch.json'
            args = ['apply', '--source-sha', pins[CORE], '--snapshot', str(snapshot_path), '--snapshot-sha', digest(snapshot_path.read_bytes()),
                    '--head', head, '--helper-sha', pins[HELPER], '--attestation', str(attestation), '--dispatch', str(dispatch)]
            writes = []
            def inert_query(sql):
                if sql.startswith('begin read only;'):
                    return [{'state': after if writes else before}]
                writes.append(sql)
                return [{'reportingSpliceResultingCatalogSha256': 'f' * 64}]
            entrypoint = getattr(adapter, 'main', helper.main)
            with patch.object(helper, 'api', return_value={'id': helper.PROJECT, 'organization_id': helper.ORGANISATION}), patch.object(helper, 'query', side_effect=inert_query), contextlib.redirect_stdout(io.StringIO()):
                entrypoint(args)
                self.assertEqual(len(writes), 1)
                self.assertTrue(writes[0] == expected, 'Dispatch used a narrower inherited query rather than the public outer builder')
                entrypoint(args + ['--attestation-sha', digest(attestation.read_bytes())])
                self.assertEqual(len(writes), 1)
                receipt_raw = attestation.read_bytes()
                receipt = helper.load_json(receipt_raw)
                inherited_query = adapter.legacy_transaction(source, {k: v for k, v in captured.items() if not k.startswith('dbRoleSetting')})
                self.assertNotEqual(digest(inherited_query.encode()), digest(expected.encode()))
                for field, value in [('transactionSha256', digest(inherited_query.encode())), ('head', '0' * 40), ('resultingCatalogSha256', '0' * 64)]:
                    changed = dict(receipt)
                    changed[field] = value
                    attestation.write_text(json.dumps(changed))
                    with self.subTest(receiptField=field), self.assertRaises(SystemExit):
                        entrypoint(args + ['--attestation-sha', digest(attestation.read_bytes())])
                    self.assertEqual(len(writes), 1)
                for corrupt in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{not-json'):
                    attestation.write_bytes(corrupt)
                    with self.subTest(corruptSha=digest(corrupt)), self.assertRaises((SystemExit, ValueError)):
                        entrypoint(args + ['--attestation-sha', digest(corrupt)])
                    self.assertEqual(len(writes), 1)
                attestation.write_bytes(receipt_raw)
                with self.assertRaises(SystemExit):
                    entrypoint(args)
                with self.assertRaises(SystemExit):
                    entrypoint(args + ['--attestation-sha', '0' * 64])
                self.assertEqual(len(writes), 1)
            self.assertEqual(helper.load_json(dispatch.read_bytes())['transactionSha256'], digest(expected.encode()))
            self.assertEqual(helper.load_json(attestation.read_bytes())['transactionSha256'], digest(expected.encode()))


class GuardedClosureNegativeTests(unittest.TestCase):
    def test_helper_replacement_between_measurement_and_execution_uses_snapshot(self):
        with source_fixture() as (root, parent, head, pins, git):
            module = load(root / ADAPTER, 'f65_helper_race')
            path, marker = root / HELPER, parent / 'helper-sentinel'
            raw = path.read_bytes()
            execute = module.SourceSnapshotLoader.exec_module
            def race(loader, unit):
                if unit.__name__ == 'guarded_reporting_splice_legacy':
                    path.write_bytes(("from pathlib import Path\nPath(" + repr(str(marker)) + ").write_text('INERT ONLY')\n").encode() + raw)
                    try:
                        return execute(loader, unit)
                    finally:
                        path.write_bytes(raw)
                return execute(loader, unit)
            with patch.object(module.SourceSnapshotLoader, 'exec_module', race):
                adapter = module.ReleaseAdapter(head, pins[ADAPTER], pins[HELPER], pins[TRANSPORT], pins[CORE])
            self.assertFalse(marker.exists())
            self.assertEqual(adapter.helper.__loader__.raw, raw)
            self.assertEqual(adapter.helper.__file__, str(path))
            self.assertEqual(adapter.helper.__spec__.origin, str(path))

    def test_bad_closure_and_git_bindings_stop_before_dependency_statements(self):
        with source_fixture() as (root, parent, head, pins, git):
            module = load(root / ADAPTER, 'f65_bad_closure')
            arguments = [head, pins[ADAPTER], pins[HELPER], pins[TRANSPORT], pins[CORE]]
            with patch.object(module.SourceSnapshotLoader, 'exec_module', side_effect=AssertionError('Dependencies must not execute')):
                for index, value in enumerate(arguments):
                    wrong = list(arguments)
                    wrong[index] = '0' * len(value)
                    with self.subTest(pin=index), self.assertRaises(SystemExit):
                        module.ReleaseAdapter(*wrong)
                dirty = root / 'unreviewed-file'
                dirty.write_text('synthetic only')
                with self.assertRaisesRegex(SystemExit, 'tree must be clean'):
                    module.ReleaseAdapter(*arguments)
                dirty.unlink()
                for key, value in [('GIT_DIR', str(root / '.git')), ('GIT_CONFIG_COUNT', '1'), ('GIT_WORK_TREE', str(root))]:
                    with self.subTest(key=key), patch.dict(os.environ, {key: value}), self.assertRaisesRegex(SystemExit, 'Git override'):
                        module.ReleaseAdapter(*arguments)
                git('remote', 'set-url', 'origin', 'https://github.com/example/synthetic.git')
                with self.assertRaisesRegex(SystemExit, 'Wrong MAM Git remote'):
                    module.ReleaseAdapter(*arguments)
                git('remote', 'set-url', 'origin', 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git')
                git('config', '--local', 'user.name', 'Synthetic Non-MAM')
                with self.assertRaisesRegex(SystemExit, 'repository-local'):
                    module.ReleaseAdapter(*arguments)

    def test_source_snapshot_rejects_nonregular_replacement_and_stale_modules(self):
        import types
        with source_fixture() as (root, parent, head, pins, git):
            module = load(root / ADAPTER, 'f65_snapshot_negative')
            actual = parent / 'actual'
            actual.write_bytes(b'synthetic')
            linked = parent / 'linked'
            linked.symlink_to(actual)
            with self.assertRaises(SystemExit):
                module.snapshot(linked)
            hard = parent / 'hard'
            os.link(actual, hard)
            with self.assertRaises(SystemExit):
                module.snapshot(actual)
            hard.unlink()
            with patch.dict(sys.modules, {'reporting_splice_transport': types.ModuleType('reporting_splice_transport')}), self.assertRaisesRegex(SystemExit, 'Stale'):
                module.ReleaseAdapter(head, pins[ADAPTER], pins[HELPER], pins[TRANSPORT], pins[CORE])
            execute = module.SourceSnapshotLoader.exec_module
            def cached_after_acquisition(loader, unit):
                with patch.dict(sys.modules, {unit.__name__: types.ModuleType(unit.__name__)}):
                    return execute(loader, unit)
            with patch.object(module.SourceSnapshotLoader, 'exec_module', cached_after_acquisition), self.assertRaisesRegex(SystemExit, 'before execution'):
                module.ReleaseAdapter(head, pins[ADAPTER], pins[HELPER], pins[TRANSPORT], pins[CORE])

    def test_loaded_snapshot_digest_and_module_identity_reject_before_sentinel(self):
        with source_fixture() as (root, parent, head, pins, git):
            module = load(root / ADAPTER, 'f65_loader_negative')
            marker = parent / 'not-executed'
            raw = ("from pathlib import Path\nPath(" + repr(str(marker)) + ").write_text('INERT ONLY')\n").encode()
            with self.assertRaisesRegex(SystemExit, 'snapshot SHA'):
                module.SourceSnapshotLoader('sentinel', parent / 'sentinel.py', raw, '0' * 64)
            loader = module.SourceSnapshotLoader('sentinel', parent / 'sentinel.py', raw, digest(raw))
            spec = importlib.util.spec_from_file_location('sentinel', str(parent / 'sentinel.py'), loader=loader)
            assert spec is not None
            unit = importlib.util.module_from_spec(spec)
            unit.__file__ = str(parent / 'different.py')
            with self.assertRaisesRegex(SystemExit, 'before execution'):
                loader.exec_module(unit)
            self.assertFalse(marker.exists())

    def test_unknown_snapshot_fields_cannot_carry_raw_setting_values(self):
        with source_fixture() as (root, parent, head, pins, git):
            adapter = adapter_for(root, head, pins)
            helper = adapter.helper
            before = model_before(helper, helper.candidate(pins[CORE]))
            before['setconfig'] = ['synthetic_private_setting_value']
            path = parent / 'unsafe-snapshot.json'
            path.write_text(json.dumps(before))
            args = ['inspect', '--source-sha', pins[CORE], '--snapshot', str(path), '--snapshot-sha', digest(path.read_bytes()), '--head', head, '--helper-sha', pins[HELPER]]
            with patch.object(helper, 'api', side_effect=AssertionError('Unknown raw fields must stop before API')) as api, self.assertRaises(SystemExit):
                adapter.main(args)
            api.assert_not_called()

    def test_snapshot_parser_and_required_supplement_reject_before_api(self):
        with source_fixture() as (root, parent, head, pins, git):
            adapter = adapter_for(root, head, pins)
            helper = adapter.helper
            source = helper.candidate(pins[CORE])
            for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":Infinity}', b'{"x":-Infinity}', json.dumps({k: v for k, v in model_before(helper, source).items() if not k.startswith('dbRoleSetting')}).encode()):
                path = parent / 'bad-snapshot.json'
                path.write_bytes(raw)
                args = ['inspect', '--source-sha', pins[CORE], '--snapshot', str(path), '--snapshot-sha', digest(raw), '--head', head, '--helper-sha', pins[HELPER]]
                with self.subTest(rawSha=digest(raw)), patch.object(helper, 'api', side_effect=AssertionError('Parsing must precede API')) as api, self.assertRaises(SystemExit):
                    adapter.main(args)
                api.assert_not_called()


class GuardedJournalNegativeTests(unittest.TestCase):
    def test_unknown_outcome_spends_original_journal_and_never_retries(self):
        for failure in (RuntimeError('inert fixture only'), SystemExit('inert fixture only'), KeyboardInterrupt(), None):
            with self.subTest(failure=type(failure).__name__), source_fixture() as (root, parent, head, pins, git):
                adapter = adapter_for(root, head, pins)
                helper = adapter.helper
                source = helper.candidate(pins[CORE])
                before = model_before(helper, source)
                snapshot_path, dispatch, attestation = [parent / name for name in ('snapshot.json', 'dispatch.json', 'attestation.json')]
                helper.retain(snapshot_path, before)
                args = ['apply', '--source-sha', pins[CORE], '--snapshot', str(snapshot_path), '--snapshot-sha', digest(snapshot_path.read_bytes()), '--head', head, '--helper-sha', pins[HELPER], '--attestation', str(attestation), '--dispatch', str(dispatch)]
                writes, reads = [], []
                def inert_query(sql):
                    if sql.startswith('begin read only;'):
                        reads.append(sql)
                        return [{'state': before}]
                    writes.append(sql)
                    if failure is not None:
                        raise failure
                    return []
                with patch.object(helper, 'api', return_value={'id': helper.PROJECT, 'organization_id': helper.ORGANISATION}), patch.object(helper, 'query', side_effect=inert_query), contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises(KeyboardInterrupt if isinstance(failure, KeyboardInterrupt) else SystemExit):
                        adapter.main(args)
                    self.assertTrue(dispatch.is_file())
                    self.assertFalse(attestation.exists())
                    self.assertEqual(len(writes), 1)
                    with self.assertRaises(SystemExit):
                        adapter.main(args)
                    self.assertEqual(len(writes), 1)
                    spent = helper.load_json(dispatch.read_bytes())
                    spent['transactionSha256'] = '0' * 64
                    dispatch.write_text(json.dumps(spent))
                    with self.assertRaisesRegex(SystemExit, 'public query identity'):
                        adapter.main(args)
                    self.assertEqual(len(writes), 1)

    def test_wrong_target_rejects_before_any_database_query(self):
        with source_fixture() as (root, parent, head, pins, git):
            adapter = adapter_for(root, head, pins)
            helper = adapter.helper
            args = ['prepare', '--source-sha', pins[CORE], '--snapshot', str(parent / 'snapshot.json'), '--head', head, '--helper-sha', pins[HELPER]]
            with patch.object(helper, 'api', return_value={'id': 'wrong', 'organization_id': helper.ORGANISATION}), patch.object(helper, 'query', side_effect=AssertionError('Wrong target must stop before SQL')) as query, self.assertRaisesRegex(SystemExit, 'Wrong MAM project'):
                adapter.main(args)
            query.assert_not_called()

    def test_exceptional_write_source_hold_preserves_interrupt_and_spent_journal(self):
        with source_fixture() as (root, parent, head, pins, git):
            adapter = adapter_for(root, head, pins)
            helper = adapter.helper
            before = model_before(helper, helper.candidate(pins[CORE]))
            snap, journal, receipt = [parent / name for name in ('snapshot.json', 'dispatch.json', 'attestation.json')]
            helper.retain(snap, before)
            args = ['apply', '--source-sha', pins[CORE], '--snapshot', str(snap), '--snapshot-sha', digest(snap.read_bytes()), '--head', head, '--helper-sha', pins[HELPER], '--attestation', str(receipt), '--dispatch', str(journal)]
            raw = (root / TRANSPORT).read_bytes()
            def inert_query(sql):
                if sql.startswith('begin read only;'):
                    return [{'state': before}]
                (root / TRANSPORT).write_bytes(raw + b'\n')
                raise KeyboardInterrupt()
            output = io.StringIO()
            with patch.object(helper, 'api', return_value={'id': helper.PROJECT, 'organization_id': helper.ORGANISATION}), patch.object(helper, 'query', side_effect=inert_query), contextlib.redirect_stdout(output), self.assertRaises(KeyboardInterrupt):
                adapter.main(args)
            self.assertIn('"sourceHold": true', output.getvalue())
            self.assertIn('"enteredWrite": true', output.getvalue())
            self.assertTrue(journal.is_file())
            self.assertFalse(receipt.exists())
            (root / TRANSPORT).write_bytes(raw)


if __name__ == '__main__':
    unittest.main()
