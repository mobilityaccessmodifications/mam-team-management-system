import contextlib
import hashlib
import copy
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
CANDIDATE = ROOT / 'supabase/migrations/20261013153500_offboarding_version_conflict_responses.sql'
ADAPTER = ROOT / 'scripts/deploy-offboarding-after-annual.py'


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(path.read_bytes(), str(path), 'exec'), module.__dict__)
    return module


def model_before(module, adapter):
    helper = adapter.helper
    specs = helper.function_spec(adapter.raw[adapter.core].decode())
    before = {'major': 16, 'dataHash': 'a'*64, 'securityHash': 'b'*64, 'receiptHash': 'c'*64,
              'purgeHash': 'd'*64, 'purgeMatches': True, 'predecessorExact': True, 'targetExact': False,
              'targetSourceArraySha256': 'e'*64, 'tradeSchoolEnabledCount': 2,
              'functions': {sig: {'sha256': spec['before'], 'metadata': {}, 'portable': {}}
                            if spec['before'] is not None else None for sig, spec in specs.items()},
              'ledger': [{'version': helper.PREDECESSOR_VERSION, 'name': helper.PREDECESSOR_NAME,
                          'dimensions': '[1:1]', 'cardinality': 1, 'sourceSha256': 'f'*64},
                         {'version': module.ANNUAL_VERSION, 'name': module.ANNUAL_NAME,
                          'dimensions': '[1:1]', 'cardinality': 1, 'sourceSha256': module.ANNUAL_ARRAY_SHA}],
              'annualExact': True, 'annualFunctionsExact': True, 'annualStateHash': '1'*64,
              'dbRoleSettingHash': '2'*64, 'dbRoleSettingCount': 0, 'dbRoleSettingShapeHash': '3'*64}
    if adapter.phase != 'reporting-splice':
        before['predecessorFunctionsExact'] = True
    return before


@contextlib.contextmanager
def source_fixture():
    module = load(ADAPTER, 'after_annual_fixture_closure')
    paths = [*module.IMMUTABLE, str(ADAPTER.relative_to(ROOT))]
    with tempfile.TemporaryDirectory(prefix='after-annual-source-unit-') as directory:
        parent = Path(directory).resolve()
        parent.chmod(0o700)
        root, home = parent / 'repo', parent / 'home'
        root.mkdir(mode=0o700)
        home.mkdir(mode=0o700)
        for path in paths:
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / path).read_bytes())
            target.chmod(0o600)
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
            git('add', '--', *paths)
            git('commit', '-q', '-m', 'Synthetic after-annual source fixture only')
            head = git('rev-parse', 'HEAD').decode().strip()
            pins = {path: hashlib.sha256((root / path).read_bytes()).hexdigest() for path in paths}
            os.chdir(root)
            try:
                yield load(root / ADAPTER.relative_to(ROOT), 'after_annual_fixture'), parent, head, pins
            finally:
                os.chdir(cwd)


def adapter_for(module, phase, head, pins):
    helper, _, core = module.PHASES[phase]
    return module.AfterAnnualAdapter(phase, head, pins['scripts/deploy-offboarding-after-annual.py'],
                                    pins['scripts/' + helper], pins['scripts/deploy-reporting-splice-guarded.py'],
                                    pins['scripts/deploy-staff-leave-calendar.py'], pins['supabase/migrations/' + core],
                                    pins['supabase/migrations/20261013120000_annual_continuous_accrual.sql'])


def model_after(adapter, before):
    after = copy.deepcopy(before)
    after.update(targetExact=True, purgeHash='5'*64, ledger=adapter.expected_ledger(before))
    for sig, spec in adapter.helper.function_spec(adapter.raw[adapter.core].decode()).items():
        if spec['before'] is None:
            after['functions'][sig] = {'sha256': spec['after'], 'portable': spec['portable'], 'metadata': {}}
        else:
            after['functions'][sig]['sha256'] = spec['after']
    return after


def entry_arguments(module, adapter, parent, action='apply', attestation_sha=None):
    values = [action, '--phase', adapter.phase, '--head', adapter.head,
              '--adapter-sha', adapter.pins[module.ADAPTER], '--helper-sha', adapter.pins[adapter.helper_path],
              '--guarded-sha', adapter.pins[module.ROOT / 'scripts/deploy-reporting-splice-guarded.py'],
              '--transport-sha', adapter.pins[module.ROOT / 'scripts/deploy-staff-leave-calendar.py'],
              '--source-sha', adapter.pins[adapter.core], '--annual-sha', adapter.pins[module.ANNUAL],
              '--snapshot', str(parent / 'MODEL-before.json')]
    if action != 'prepare':
        values += ['--snapshot-sha', module.sha((parent / 'MODEL-before.json').read_bytes()),
                   '--dispatch', str(parent / 'MODEL-dispatch.json'), '--attestation', str(parent / 'MODEL-attestation.json')]
    if attestation_sha is not None:
        values += ['--attestation-sha', attestation_sha]
    return values


class AfterAnnualReleaseTests(unittest.TestCase):
    def setUp(self):
        trap = patch('urllib.request.urlopen', side_effect=AssertionError('Offline MODEL tests forbid network'))
        trap.start()
        self.addCleanup(trap.stop)

    def model(self, phase='reporting-splice'):
        module = load(ADAPTER, 'after_annual_control_tests')
        adapter = module.AfterAnnualAdapter.__new__(module.AfterAnnualAdapter)
        adapter.phase = phase
        adapter.raw = {ROOT / path: (ROOT / path).read_bytes() for path in module.IMMUTABLE}
        adapter.load_components()
        return module, adapter, model_before(module, adapter)

    def test_exact_annual_admission_rejects_boolean_cardinality(self):
        _, adapter, before = self.model()
        before['ledger'][-1]['cardinality'] = True
        with self.assertRaises(SystemExit):
            adapter.validate_before(before, adapter.raw[adapter.core].decode())

    def test_unknown_future_and_every_changed_annual_row_are_rejected(self):
        for phase in ('reporting-splice', 'finalizer', 'version-conflict'):
            module, adapter, original = self.model(phase)
            source = adapter.raw[adapter.core].decode()
            adapter.validate_before(original, source)
            mutations = [('name', 'renamed'), ('sourceSha256', '9'*64), ('dimensions', '[0:0]'), ('cardinality', 0), ('dimensions', None), ('cardinality', None)]
            for key, value in mutations:
                before = copy.deepcopy(original)
                before['ledger'][-1][key] = value
                with self.subTest(phase=phase, key=key, value=value), self.assertRaises(SystemExit):
                    adapter.validate_before(before, source)
            for field in module.ANNUAL_FIELDS:
                before = copy.deepcopy(original)
                before[field] = False if field != 'annualStateHash' else None
                with self.subTest(phase=phase, field=field), self.assertRaises(SystemExit):
                    adapter.validate_before(before, source)
            before = copy.deepcopy(original)
            before['ledger'].append(dict(before['ledger'][-1], version='20261013120001'))
            with self.subTest(phase=phase), self.assertRaises(SystemExit):
                adapter.validate_before(before, source)
            before = copy.deepcopy(original)
            del before['ledger'][-1]
            with self.subTest(phase=phase), self.assertRaises(SystemExit):
                adapter.validate_before(before, source)

    def test_full_sorted_readback_keeps_every_row_and_protected_field(self):
        for phase in ('reporting-splice', 'finalizer', 'version-conflict'):
            module, adapter, before = self.model(phase)
            source = adapter.raw[adapter.core].decode()
            after = copy.deepcopy(before)
            after.update(targetExact=True, purgeHash='5'*64, ledger=adapter.expected_ledger(before))
            for sig, spec in adapter.helper.function_spec(source).items():
                if spec['before'] is None:
                    after['functions'][sig] = {'sha256': spec['after'], 'portable': spec['portable'], 'metadata': {}}
                else:
                    after['functions'][sig]['sha256'] = spec['after']
            adapter.verify_after(after, before, source, '5'*64)
            for field in after:
                bad = copy.deepcopy(after)
                bad[field] = None
                with self.subTest(phase=phase, field=field), self.assertRaises((SystemExit, TypeError)):
                    adapter.verify_after(bad, before, source, '5'*64)
            target = next(row for row in after['ledger'] if row['version'] == adapter.helper.VERSION)
            bad = copy.deepcopy(after)
            bad['ledger'] = [row for row in after['ledger'] if row['version'] != adapter.helper.VERSION] + [target]
            if phase != 'version-conflict':
                with self.assertRaises(SystemExit):
                    adapter.verify_after(bad, before, source, '5'*64)

    def test_distinct_prospective_identity_keeps_core_raw_bytes(self):
        self.assertTrue(CANDIDATE.is_file(), 'Distinct prospective offboarding migration required')
        self.assertEqual(hashlib.sha256(CANDIDATE.read_bytes()).hexdigest(), 'fac3a9fe00bd4ba5f4fb5d1e6ac7f3fd786ac9e1bf2d452617f57e1891ba2e62')
        helper = load(ROOT / 'scripts/deploy-offboarding-version-conflicts.py', 'after_annual_version_test')
        self.assertEqual(helper.VERSION, '20261013153500')
        self.assertEqual(helper.MIGRATION, CANDIDATE)
        self.assertEqual(hashlib.sha256((ROOT / 'supabase/migrations/20261013120000_annual_continuous_accrual.sql').read_bytes()).hexdigest(), '271c649221999cfce6f27ecbcd39dfbc5e95e581108a39b66f0f88ae182d2682')


    def test_exact_annual_predecessor_has_a_reversible_full_ledger_query(self):
        self.assertTrue(ADAPTER.is_file(), 'New exact after-annual adapter required')
        module, adapter, before = self.model()
        source = adapter.raw[adapter.core].decode()
        with self.assertRaisesRegex(SystemExit, 'Latest predecessor'):
            adapter.helper.validate_before(before, source)
        query, original, changes = adapter.bind_query(source, before)
        restored = query
        for old, new in reversed(changes):
            self.assertEqual(restored.count(new), 1)
            restored = restored.replace(new, old, 1)
        self.assertEqual(restored, original)
        self.assertEqual(adapter.transaction(source, before), query)
        self.assertEqual(len(adapter.validation_projection(before)['ledger']), len(before['ledger'])-1)
        self.assertIn('20261013120000', query)
        self.assertIn('set constraints all immediate;', query)
        self.assertEqual(before['ledger'][-1]['version'], module.ANNUAL_VERSION)


    def test_public_three_phase_entry_requires_all_explicit_pins_before_ports(self):
        module = load(ADAPTER, 'after_annual_entry_test')
        self.assertTrue(hasattr(module, 'arguments'), 'Explicit three-phase public CLI required')
        self.assertTrue(hasattr(module.AfterAnnualAdapter, 'run'), 'Exact-query entry/attestation/reconciliation required')
        with self.assertRaises(SystemExit):
            module.arguments(['apply', '--phase', 'finalizer'])
        with source_fixture() as (module, parent, head, pins):
            adapter_for(module, 'reporting-splice', head, pins)
            dirty = module.ROOT / 'synthetic-unreviewed-file'
            dirty.write_text('MODEL only')
            with self.assertRaisesRegex(SystemExit, 'Release tree must be clean'):
                adapter_for(module, 'reporting-splice', head, pins)


    def test_sql_gate_wires_portable_units_without_local_native_archives(self):
        runner = (ROOT / 'scripts/test-sql.mjs').read_text()
        self.assertIn("'-p', 'test_after_annual_offboarding_release.py'", runner)
        self.assertIn('After-annual offboarding portable release adapter tests', runner)
        self.assertNotIn('run-after-annual-offboarding-release.py', runner)
        self.assertIn('runuser -u postgres -- node scripts/test-sql.mjs', (ROOT / '.github/workflows/ci.yml').read_text())

    def test_every_explicit_cli_pin_is_required_before_any_port(self):
        with source_fixture() as (module, parent, head, pins):
            adapter = adapter_for(module, 'reporting-splice', head, pins)
            args = entry_arguments(module, adapter, parent, 'prepare')
            for flag in ('--head', '--adapter-sha', '--helper-sha', '--guarded-sha', '--transport-sha', '--source-sha', '--annual-sha'):
                bad = list(args)
                index = bad.index(flag)
                del bad[index:index+2]
                with self.subTest(flag=flag), patch.object(module.AfterAnnualAdapter, 'run') as run, contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    module.main(bad)
                run.assert_not_called()

    def test_model_public_dispatch_attestation_and_reconciliation_use_same_query(self):
        for phase in ('reporting-splice', 'finalizer', 'version-conflict'):
            with self.subTest(phase=phase), source_fixture() as (module, parent, head, pins):
                adapter = adapter_for(module, phase, head, pins)
                before = model_before(module, adapter)
                after = model_after(adapter, before)
                adapter.retain(parent / 'MODEL-before.json', before)
                captured = adapter.helper.load_json((parent / 'MODEL-before.json').read_bytes())
                expected = adapter.transaction(adapter.raw[adapter.core].decode(), captured)
                writes = []
                def inert_query(sql):
                    if sql.startswith('begin read only;'):
                        return [{'state': after if writes else before}]
                    self.assertEqual(sql, expected)
                    writes.append(sql)
                    return [{'reporting-splice': {'reportingSpliceResultingCatalogSha256': '5'*64},
                             'finalizer': {'archivedFinalizerResultingCatalogSha256': '5'*64},
                             'version-conflict': {'offboardingVersionConflictResultingCatalogSha256': '5'*64}}[phase]]
                args = entry_arguments(module, adapter, parent)
                with patch.object(adapter.helper, 'api', return_value={'id': adapter.helper.PROJECT, 'organization_id': adapter.helper.ORGANISATION}), patch.object(adapter.helper, 'query', side_effect=inert_query), contextlib.redirect_stdout(io.StringIO()):
                    adapter.run(module.arguments(args))
                    receipt = parent / 'MODEL-attestation.json'
                    adapter.run(module.arguments(args + ['--attestation-sha', module.sha(receipt.read_bytes())]))
                self.assertEqual(writes, [expected])
                for name in ('MODEL-dispatch.json', 'MODEL-attestation.json'):
                    self.assertEqual(adapter.helper.load_json((parent / name).read_bytes())['transactionSha256'], module.sha(expected.encode()))
                self.assertEqual(captured['ledger'][-1]['version'] > adapter.helper.VERSION, phase != 'version-conflict')

    def test_model_unknown_outcome_never_rearms_original_dispatch(self):
        for phase in ('reporting-splice', 'finalizer', 'version-conflict'):
            for failure in (RuntimeError('MODEL transport lost'), KeyboardInterrupt(), None):
                with self.subTest(phase=phase, failure=type(failure).__name__), source_fixture() as (module, parent, head, pins):
                    adapter = adapter_for(module, phase, head, pins)
                    before = model_before(module, adapter)
                    adapter.retain(parent / 'MODEL-before.json', before)
                    writes, reads = [], []
                    def inert_query(sql):
                        if sql.startswith('begin read only;'):
                            reads.append(sql)
                            return [{'state': before}]
                        writes.append(sql)
                        if failure is not None:
                            raise failure
                        return []
                    args = module.arguments(entry_arguments(module, adapter, parent))
                    with patch.object(adapter.helper, 'api', return_value={'id': adapter.helper.PROJECT, 'organization_id': adapter.helper.ORGANISATION}), patch.object(adapter.helper, 'query', side_effect=inert_query), contextlib.redirect_stdout(io.StringIO()):
                        with self.assertRaises(KeyboardInterrupt if isinstance(failure, KeyboardInterrupt) else SystemExit):
                            adapter.run(args)
                        spent = (parent / 'MODEL-dispatch.json').read_bytes()
                        with self.assertRaises(SystemExit):
                            adapter.run(args)
                        self.assertEqual((parent / 'MODEL-dispatch.json').read_bytes(), spent)
                    self.assertEqual(len(writes), 1)
                    self.assertGreaterEqual(len(reads), 2)
                    self.assertFalse((parent / 'MODEL-attestation.json').exists())

    def test_model_receipt_query_or_catalog_drift_stays_readonly(self):
        for phase in ('reporting-splice', 'finalizer', 'version-conflict'):
            with self.subTest(phase=phase), source_fixture() as (module, parent, head, pins):
                adapter = adapter_for(module, phase, head, pins)
                before = model_before(module, adapter)
                after = model_after(adapter, before)
                adapter.retain(parent / 'MODEL-before.json', before)
                expected = adapter.transaction(adapter.raw[adapter.core].decode(), adapter.helper.load_json((parent / 'MODEL-before.json').read_bytes()))
                base = {'project': adapter.helper.PROJECT, 'organization': adapter.helper.ORGANISATION, 'phase': phase,
                        'version': adapter.helper.VERSION, 'head': head, 'adapterSha256': adapter.pins[module.ADAPTER],
                        'sourceSha256': adapter.pins[adapter.core], 'snapshotSha256': module.sha((parent / 'MODEL-before.json').read_bytes()),
                        'transactionSha256': module.sha(expected.encode())}
                adapter.retain(parent / 'MODEL-dispatch.json', base)
                receipt = parent / 'MODEL-attestation.json'
                args = entry_arguments(module, adapter, parent)
                with patch.object(adapter.helper, 'api', return_value={'id': adapter.helper.PROJECT, 'organization_id': adapter.helper.ORGANISATION}), patch.object(adapter.helper, 'query', return_value=[{'state': after}]) as query, contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises(SystemExit):
                        adapter.run(module.arguments(args))
                    for field, value in (('transactionSha256', '0'*64), ('head', '0'*40), ('resultingCatalogSha256', '0'*64)):
                        raw = json.dumps(dict(base, resultingCatalogSha256='5'*64, **{field: value}) if field != 'resultingCatalogSha256' else dict(base, resultingCatalogSha256=value)).encode()
                        receipt.write_bytes(raw)
                        receipt.chmod(0o600)
                        with self.subTest(field=field), self.assertRaises(SystemExit):
                            adapter.run(module.arguments(args + ['--attestation-sha', module.sha(raw)]))
                    for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{not-json'):
                        receipt.write_bytes(raw)
                        with self.subTest(raw=raw), self.assertRaises((SystemExit, ValueError)):
                            adapter.run(module.arguments(args + ['--attestation-sha', module.sha(raw)]))
                    journal = parent / 'MODEL-dispatch.json'
                    journal.write_bytes(json.dumps(dict(base, transactionSha256='0'*64)).encode())
                    with self.assertRaises(SystemExit):
                        adapter.run(module.arguments(args))
                self.assertTrue(all(call.args[0].startswith('begin read only;') for call in query.call_args_list))

    def test_model_source_hold_retains_spend_and_cannot_retry(self):
        with source_fixture() as (module, parent, head, pins):
            adapter = adapter_for(module, 'reporting-splice', head, pins)
            before = model_before(module, adapter)
            adapter.retain(parent / 'MODEL-before.json', before)
            source = module.ROOT / 'scripts/deploy-staff-leave-calendar.py'
            raw = source.read_bytes()
            writes = []
            def inert_query(sql):
                if sql.startswith('begin read only;'):
                    return [{'state': before}]
                writes.append(sql)
                source.write_bytes(raw + b'\n')
                raise RuntimeError('MODEL uncertain write and source mutation')
            output = io.StringIO()
            args = module.arguments(entry_arguments(module, adapter, parent))
            with patch.object(adapter.helper, 'api', return_value={'id': adapter.helper.PROJECT, 'organization_id': adapter.helper.ORGANISATION}), patch.object(adapter.helper, 'query', side_effect=inert_query), contextlib.redirect_stdout(output):
                with self.assertRaises(SystemExit):
                    adapter.run(args)
                with self.assertRaises(SystemExit):
                    adapter.run(args)
                source.write_bytes(raw)
                with self.assertRaises(SystemExit):
                    adapter.run(args)
            self.assertIn('"sourceHold": true', output.getvalue())
            self.assertIn('"enteredWrite": true', output.getvalue())
            self.assertEqual(len(writes), 1)
            self.assertTrue((parent / 'MODEL-dispatch.json').exists())
            self.assertFalse((parent / 'MODEL-attestation.json').exists())


if __name__ == '__main__':
    unittest.main()
