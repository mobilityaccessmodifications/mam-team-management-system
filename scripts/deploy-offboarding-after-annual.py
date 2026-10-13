import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
ADAPTER = Path(__file__).resolve()
ANNUAL_VERSION = '20261013120000'
ANNUAL_NAME = 'annual_continuous_accrual'
ANNUAL = ROOT / ('supabase/migrations/' + ANNUAL_VERSION + '_' + ANNUAL_NAME + '.sql')
ANNUAL_ARRAY_SHA = 'b36d758a3a3798c99f04a07f2a4384ed48288e66126defda0990da05649bae6c'
IMMUTABLE = {
    'scripts/deploy-reporting-splice-guarded.py': 'd39d0fa65011f192590bba670b02e29b4d7745b38fe4e854a9559e5e42afdac1',
    'scripts/deploy-employee-removal-reporting-splice.py': '1beac990ddf17652b1e6d98d3d3594c4a311a597e134b99e9dd75b96bf099efc',
    'scripts/deploy-archived-account-finalizer.py': 'e0ea29b5d4fc5129520079be28c8a113ba2abf28a30a57d89223dca860d0c1c7',
    'scripts/deploy-offboarding-version-conflicts.py': 'a844652909a77b2d0fa82d5f4c41906861555113bb3b1101e8464c934f0bcd59',
    'scripts/deploy-staff-leave-calendar.py': '25e257bd80596247f4ae6fadf74e4283c6078a22ad9141d4f24b6614d38fb011',
    'supabase/migrations/20261012110000_trade_school_leave.sql': 'c5b57e19c1ef6a763272e2e2f08d1967aa95bb7fa1aee0ac76b5e949d177f4fe',
    'supabase/migrations/20261012170000_employee_removal_reporting_splice.sql': 'f65d043e18716538a6bc29bd0f5d0d95b9d58975de43334705972a0919a4e9e4',
    'supabase/migrations/20261013081500_archived_account_status_finalizer.sql': '7ac9fb016817e36d537e86f468e0383f377c3311e723d0f126cb2c1a228af76d',
    'supabase/migrations/20261013153500_offboarding_version_conflict_responses.sql': 'fac3a9fe00bd4ba5f4fb5d1e6ac7f3fd786ac9e1bf2d452617f57e1891ba2e62',
    'supabase/migrations/20261013120000_annual_continuous_accrual.sql': '271c649221999cfce6f27ecbcd39dfbc5e95e581108a39b66f0f88ae182d2682',
}
PHASES = {
    'reporting-splice': ('deploy-employee-removal-reporting-splice.py', 'reporting_splice', '20261012170000_employee_removal_reporting_splice.sql'),
    'finalizer': ('deploy-archived-account-finalizer.py', 'archived_finalizer', '20261013081500_archived_account_status_finalizer.sql'),
    'version-conflict': ('deploy-offboarding-version-conflicts.py', 'offboarding_version_conflict', '20261013153500_offboarding_version_conflict_responses.sql'),
}
ANNUAL_FIELDS = ('annualExact', 'annualFunctionsExact', 'annualStateHash')


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


class AfterAnnualAdapter:
    def __init__(self, phase, head, adapter_sha, helper_sha, guarded_sha, transport_sha, source_sha, annual_sha):
        require(phase in PHASES and Path.cwd().resolve() == ROOT and re.fullmatch('[0-9a-f]{40}', head or '') is not None, 'Exact phase/root/full reviewed HEAD required')
        self.phase, self.head = phase, head
        self.pins = {ROOT / path: pin for path, pin in IMMUTABLE.items()}
        helper_file, _, core_file = PHASES[phase]
        explicit = {ADAPTER: adapter_sha, ROOT / 'scripts' / helper_file: helper_sha,
                    ROOT / 'scripts/deploy-reporting-splice-guarded.py': guarded_sha,
                    ROOT / 'scripts/deploy-staff-leave-calendar.py': transport_sha,
                    ROOT / 'supabase/migrations' / core_file: source_sha, ANNUAL: annual_sha}
        require(all(re.fullmatch('[0-9a-f]{64}', pin or '') for pin in explicit.values()), 'Explicit reviewed phase/adapter/dependency/source pins required')
        require(all(self.pins.get(path, pin) == pin for path, pin in explicit.items()), 'Immutable phase closure pin differs')
        self.pins.update(explicit)
        self.raw = {path: source_snapshot(path) for path in self.pins}
        require(all(sha(raw) == self.pins[path] for path, raw in self.raw.items()), 'Reviewed closure bytes differ')
        self.load_components()
        self.check_custody()

    def git(self, *args):
        return self.guarded.ReleaseAdapter.git(self, *args)

    def check_custody(self):
        self.guarded.ReleaseAdapter.clean_git(self)
        require(all(source_snapshot(path) == raw and self.git('show', self.head + ':' + str(path.relative_to(ROOT))) == raw for path, raw in self.raw.items()), 'Reviewed committed closure/custody differs')

    @contextlib.contextmanager
    def measured_reads(self):
        def read(path):
            require(path in self.raw, 'Unexpected release dependency read')
            return self.raw[path]
        with patch.object(Path, 'read_bytes', read):
            yield

    def load_components(self):
        require(self.phase in PHASES and all(sha(self.raw[ROOT / path]) == pin for path, pin in IMMUTABLE.items()), 'Exact after-annual closure required')
        original_spec = importlib.util.spec_from_file_location
        def unit(name, path):
            require(name not in sys.modules, 'Stale release dependency module prohibited')
            spec = original_spec(name, path)
            require(spec is not None, 'Missing release dependency specification')
            module = importlib.util.module_from_spec(spec)
            exec(compile(self.raw[path], str(path), 'exec'), module.__dict__)
            return module
        self.guarded = unit('after_annual_guarded_dependency', ROOT / 'scripts/deploy-reporting-splice-guarded.py')
        transport = ROOT / 'scripts/deploy-staff-leave-calendar.py'
        allowed = {'reporting_splice_transport', 'archived_finalizer_transport', 'offboarding_version_conflict_transport'}
        def finite_spec(name, location, *args, **kwargs):
            require(name in allowed and name not in sys.modules and Path(location) == transport and not args and not kwargs, 'Unexpected transitive release load')
            loader = self.guarded.SourceSnapshotLoader(name, transport, self.raw[transport], IMMUTABLE[str(transport.relative_to(ROOT))])
            return original_spec(name, transport, loader=loader)
        helper_file, self.prefix, core_file = PHASES[self.phase]
        self.core = ROOT / 'supabase/migrations' / core_file
        self.helper_path = ROOT / 'scripts' / helper_file
        with self.measured_reads(), patch.object(importlib.util, 'spec_from_file_location', finite_spec):
            self.helper = unit('after_annual_' + self.prefix, self.helper_path)
        require(self.helper.MIGRATION == self.core, 'Exact phase path binding differs')
        self.f65 = self.guarded.ReleaseAdapter.__new__(self.guarded.ReleaseAdapter)
        self.f65.raw = self.raw
        self.f65.helper = self.helper
        self.f65.legacy_transaction = self.helper.transaction
        self.f65.legacy_verify_after = self.helper.verify_after
        self.f65.active_before = None
        annual = self.raw[ANNUAL].decode('utf-8')
        section = annual.split('insert into annual_continuous_function_spec(signature,before_sha256,after_sha256) values\n', 1)[1].split('do $annual_continuous_functions$', 1)[0]
        rows = re.findall(r"\('([^']+)',(?:null|'[0-9a-f]{64}'),'([0-9a-f]{64})'", section)
        require(len(rows) == len(dict(rows)) == 13, 'Exact published annual definitions required')
        self.annual_functions = dict(rows)

    def supplementary_expression(self):
        literal = self.helper.literal
        annual = self.raw[ANNUAL].decode('utf-8')
        signatures = ','.join(literal(sig) for sig in sorted(self.annual_functions))
        exact = ' and '.join("encode(extensions.digest(pg_get_functiondef(to_regprocedure(" + literal(sig) + ")),'sha256'),'hex') is not distinct from " + literal(pin) for sig, pin in sorted(self.annual_functions.items()))
        expression = "jsonb_build_object('annualExact',coalesce((select name=" + literal(ANNUAL_NAME) + " and array_dims(statements)='[1:1]' and cardinality(statements)=1 and statements=ARRAY[" + literal(annual) + ']::text[] from supabase_migrations.schema_migrations where version=' + literal(ANNUAL_VERSION) + "),false),'annualFunctionsExact',(" + exact + "),'annualStateHash',encode(extensions.digest(jsonb_build_object('functions',(select jsonb_object_agg(signature,jsonb_build_object('definition',pg_get_functiondef(p.oid),'metadata',(to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)))) from unnest(array[" + signatures + "]::text[]) signature join pg_proc p on p.oid=to_regprocedure(signature)),'accounting',(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate \"C\"),'[]'::jsonb) from private.annual_leave_day_accounting t))::text,'sha256'),'hex'))"
        return '(' + expression + ') || ' + self.guarded.SETTINGS_EXPRESSION

    def state_expression(self, source):
        require(source.encode('utf-8') == self.raw[self.core], 'Exact phase source required')
        with self.measured_reads():
            return '(' + self.helper.state_expression(source) + ') || ' + self.supplementary_expression()

    def annual_state(self, frame):
        fields = (*ANNUAL_FIELDS, *self.guarded.SETTING_FIELDS)
        require(isinstance(frame, dict) and all(field in frame for field in fields), 'Complete native annual/settings snapshot required')
        require(frame['annualExact'] is True and frame['annualFunctionsExact'] is True, 'Exact published annual source and definitions required')
        require(type(frame['dbRoleSettingCount']) is int and frame['dbRoleSettingCount'] >= 0, 'Invalid complete settings count')
        for field in ('annualStateHash', 'dbRoleSettingHash', 'dbRoleSettingShapeHash'):
            require(isinstance(frame[field], str) and re.fullmatch('[0-9a-f]{64}', frame[field]) is not None, 'Invalid protected annual/settings hash')
        rows = [row for row in frame.get('ledger', []) if row.get('version') == ANNUAL_VERSION]
        require(len(rows) == 1 and type(rows[0].get('cardinality')) is int, 'Exact integer annual array cardinality required')
        require(rows == [{'version': ANNUAL_VERSION, 'name': ANNUAL_NAME, 'dimensions': '[1:1]', 'cardinality': 1, 'sourceSha256': ANNUAL_ARRAY_SHA}], 'Exact full published annual ledger row required')
        return {field: frame[field] for field in fields}

    def validation_projection(self, frame):
        self.annual_state(frame)
        omitted = {*ANNUAL_FIELDS, *self.guarded.SETTING_FIELDS}
        projection = {key: value for key, value in frame.items() if key not in omitted}
        projection['ledger'] = [row for row in frame['ledger'] if row['version'] != ANNUAL_VERSION]
        return projection

    def validate_before(self, before, source):
        base = self.guarded.STATE_FIELDS | set(ANNUAL_FIELDS)
        if self.phase != 'reporting-splice':
            base = base | {'predecessorFunctionsExact'}
        require(isinstance(before, dict) and set(before) == base, 'Exact full native phase fields required')
        versions = [row['version'] for row in before['ledger']]
        require(0 < len(versions) <= 512 and len(versions) == len(set(versions)) and versions == sorted(versions) and max(versions) == ANNUAL_VERSION, 'Only the exact published annual latest predecessor admitted')
        with self.measured_reads():
            self.helper.validate_before(self.validation_projection(before), source)

    def expected_ledger(self, before):
        target = {'version': self.helper.VERSION, 'name': self.helper.NAME, 'dimensions': '[1:1]', 'cardinality': 1, 'sourceSha256': before['targetSourceArraySha256']}
        return sorted([*before['ledger'], target], key=lambda row: row['version'])

    def bind_query(self, source, before):
        self.validate_before(before, source)
        projected = self.validation_projection(before)
        with self.measured_reads():
            if self.phase == 'reporting-splice':
                original = self.f65.transaction(source, dict(projected, **{key: before[key] for key in self.guarded.SETTING_FIELDS}))
                original_expected = dict(projected)
            else:
                original = self.helper.transaction(source, projected)
                original_expected = projected
            old_expression = self.helper.state_expression(source)
            row_expression = self.helper.expected_ledger_row(source)
        literal = self.helper.literal
        old_expected = literal(json.dumps(original_expected, separators=(',', ':'), allow_nan=False)) + '::jsonb'
        expected = literal(json.dumps(before, separators=(',', ':'), allow_nan=False)) + '::jsonb'
        expression = self.state_expression(source)
        before_start = '\ndo $' + self.prefix + '_release_before$'
        before_end = ' end $' + self.prefix + '_release_before$;\n'
        final_start = '\ndo $' + self.prefix + '_release_final$'
        final_end = '\nend $' + self.prefix + '_release_final$;'
        changes = []
        for start, end in ((before_start, before_end), (final_start, final_end)):
            require(original.count(start) == original.count(end) == 1, 'Unique actual outer release guard required')
            offset = original.index(start)
            old = original[offset:original.index(end, offset) + len(end)]
            require(old.count(old_expression) == old.count(old_expected) == 1, 'Exact actual outer frame literals required')
            new = old.replace(old_expression, expression, 1).replace(old_expected, expected, 1)
            if start == final_start:
                append = "(expected->'ledger')||jsonb_build_array(" + row_expression + ')'
                require(new.count(append) == 1, 'Exact actual outer ledger comparison required')
                new = new.replace(append, literal(json.dumps(self.expected_ledger(before), separators=(',', ':'), allow_nan=False)) + '::jsonb', 1)
            changes.append((old, new))
        anchor = "\nnotify pgrst,'reload schema';\nselect value as "
        require(original.count(anchor) == 1, 'Unique actual attestation boundary required')
        supplementary = literal(json.dumps(self.annual_state(before), separators=(',', ':'), allow_nan=False)) + '::jsonb'
        ledger_expected = literal(json.dumps(self.expected_ledger(before), separators=(',', ':'), allow_nan=False)) + '::jsonb'
        block = '\ndo $offboarding_after_annual_final$ declare actual jsonb; begin perform pg_temp.' + self.prefix + '_assert_delta(); actual:=' + expression + '; if (' + self.supplementary_expression() + ') is distinct from ' + supplementary + " or actual->'ledger' is distinct from " + ledger_expected + " or actual->'purgeMatches' is distinct from 'true'::jsonb or actual->>'purgeHash' is distinct from (select value from pg_temp." + self.prefix + "_catalog_after) then raise exception 'Published annual or complete final native state changed' using errcode='55000'; end if; end $offboarding_after_annual_final$;"
        changes.append((anchor, block + anchor))
        query = original
        for old, new in changes:
            require(query.count(old) == 1, 'Unique declared query adaptation required')
            query = query.replace(old, new, 1)
        restored = query
        for old, new in reversed(changes):
            require(restored.count(new) == 1, 'Unique reversible query adaptation required')
            restored = restored.replace(new, old, 1)
        require(restored == original, 'Query changed outside declared after-annual adaptations')
        return query, original, changes

    def transaction(self, source, before):
        return self.bind_query(source, before)[0]

    def verify_after(self, actual, before, source, expected_catalog):
        self.validate_before(before, source)
        require(isinstance(actual, dict) and isinstance(actual.get('functions'), dict) and isinstance(actual.get('ledger'), list), 'Invalid complete protected readback frame')
        require(self.annual_state(actual) == self.annual_state(before), 'Published annual/settings independent readback differs')
        require(actual.get('ledger') == self.expected_ledger(before), 'Complete sorted historical ledger readback differs')
        require(set(actual) == set(before), 'Exact complete independent frame required')
        with self.measured_reads():
            self.helper.verify_after(self.validation_projection(actual), self.validation_projection(before), source, expected_catalog)

    def check_inputs(self):
        self.check_custody()
        require(all(source_snapshot(path, private=True) == raw for path, raw in self.inputs.items()), 'Reviewed phase input custody changed')

    def port(self, function, value, writing=False):
        self.check_inputs()
        if writing:
            require(value == self.expected_query and self.helper.load_json(source_snapshot(self.dispatch, private=True)) == self.identity, 'Exact public query/spent journal required before dispatch')
            self.entered_write = True
        pending = None
        try:
            return function(value)
        except BaseException as error:
            pending = error
            raise
        finally:
            try:
                self.check_inputs()
            except BaseException:
                print(json.dumps({'sourceHold': True, 'enteredWrite': self.entered_write, 'retryAllowed': False}), flush=True)
                if pending is None:
                    raise

    def read_state(self, source):
        sql = "begin read only; set local search_path=''; set local lock_timeout='3s'; set local statement_timeout='30s';\n" + self.helper.ledger_bound() + '\nselect ' + self.state_expression(source) + ' as state; rollback;'
        result = self.port(self.helper.query, sql)
        require(isinstance(result, list) and len(result) == 1 and isinstance(result[0].get('state'), dict), 'Invalid complete read-only native frame')
        return result[0]['state']

    def retain(self, path, value):
        require(path.is_absolute() and ROOT not in path.parents and not any(p.is_symlink() for p in [path, *path.parents]), 'Private external artifact path required')
        require(path.parent.is_dir() and path.parent.stat().st_uid == os.getuid() and stat.S_IMODE(path.parent.stat().st_mode) == 0o700, 'Owned existing private artifact directory required')
        self.helper.retain(path, value)
        descriptor = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def run(self, args):
        expected_pins = ((args.adapter_sha, ADAPTER), (args.helper_sha, self.helper_path),
                         (args.guarded_sha, ROOT / 'scripts/deploy-reporting-splice-guarded.py'),
                         (args.transport_sha, ROOT / 'scripts/deploy-staff-leave-calendar.py'),
                         (args.source_sha, self.core), (args.annual_sha, ANNUAL))
        require(args.phase == self.phase and args.head == self.head and all(pin == self.pins[path] for pin, path in expected_pins), 'Entrypoint reviewed phase/closure differs')
        self.inputs, self.entered_write = {}, False
        self.expected_query = None
        self.check_inputs()
        source = self.raw[self.core].decode('utf-8')
        before = None
        if args.action != 'prepare':
            raw = source_snapshot(args.snapshot, private=True)
            require(re.fullmatch('[0-9a-f]{64}', args.snapshot_sha or '') is not None and sha(raw) == args.snapshot_sha, 'Explicit reviewed full predecessor snapshot differs')
            self.inputs[args.snapshot] = raw
            before = self.helper.load_json(raw)
            self.validate_before(before, source)
            self.expected_query = self.transaction(source, before)
            self.identity = {'project': self.helper.PROJECT, 'organization': self.helper.ORGANISATION,
                             'phase': self.phase, 'version': self.helper.VERSION, 'head': self.head,
                             'adapterSha256': args.adapter_sha, 'sourceSha256': args.source_sha,
                             'snapshotSha256': args.snapshot_sha, 'transactionSha256': sha(self.expected_query.encode())}
            self.dispatch = args.dispatch
            if args.dispatch is not None and args.dispatch.exists():
                require(self.helper.load_json(source_snapshot(args.dispatch, private=True)) == self.identity, 'Spent dispatch public query identity differs; reconcile read-only')
            if args.attestation_sha is not None:
                require(args.dispatch is not None and args.dispatch.exists(), 'Retained exact spent dispatch required for reconciliation')
        else:
            require(not args.snapshot.exists() and args.snapshot_sha is None and args.attestation is None and args.dispatch is None, 'Independent new phase capture required')
        target = self.port(self.helper.api, '')
        require(isinstance(target, dict) and target.get('id') == self.helper.PROJECT and target.get('organization_id') == self.helper.ORGANISATION, 'Wrong MAM project/organization')
        actual = self.read_state(source)
        if args.action == 'prepare':
            self.validate_before(actual, source)
            self.retain(args.snapshot, actual)
            print(json.dumps({'readOnly': True, 'targetVerified': True, 'phase': self.phase, 'snapshotSha256': sha(source_snapshot(args.snapshot, private=True))}))
            return
        recorded = any(row['version'] == self.helper.VERSION for row in actual['ledger'])
        if recorded:
            require(args.attestation is not None and re.fullmatch('[0-9a-f]{64}', args.attestation_sha or '') is not None, 'Reviewed exact COMMIT attestation required; reconcile read-only and do not retry')
            raw = source_snapshot(args.attestation, private=True)
            require(sha(raw) == args.attestation_sha, 'Reviewed COMMIT attestation bytes differ')
            self.inputs[args.attestation] = raw
            receipt = self.helper.load_json(raw)
            catalog = receipt.get('resultingCatalogSha256')
            require(receipt == dict(self.identity, resultingCatalogSha256=catalog), 'COMMIT attestation public query/phase differs')
            require(self.transaction(source, before) == self.expected_query, 'Independent public query identity differs')
            self.verify_after(actual, before, source, catalog)
            self.check_inputs()
            print(json.dumps({'readOnly': True, 'recorded': True, 'readbackVerified': True, 'phase': self.phase}))
            return
        self.validate_before(actual, source)
        require(actual == before, 'Complete observed predecessor changed; never adopt or retry')
        if args.action == 'inspect':
            print(json.dumps({'readOnly': True, 'targetAbsent': True, 'predecessorMatches': True, 'phase': self.phase}))
            return
        require(args.attestation is not None and not args.attestation.exists() and args.attestation_sha is None, 'New retained COMMIT attestation path required')
        require(args.dispatch is not None and not args.dispatch.exists() and args.dispatch.resolve() not in (args.snapshot.resolve(), args.attestation.resolve()), 'Unspent exclusive dispatch path required; never retry unknown write')
        self.check_inputs()
        self.retain(args.dispatch, self.identity)
        self.inputs[args.dispatch] = source_snapshot(args.dispatch, private=True)
        print(json.dumps({'operation': 'one exact transaction', 'phase': self.phase, 'querySha256': self.identity['transactionSha256']}), flush=True)
        try:
            catalog = self.helper.resulting_catalog(self.port(self.helper.query, self.expected_query, writing=True))
        except (Exception, SystemExit):
            try:
                reconciled = self.read_state(source)
                print(json.dumps({'readOnlyReconciliation': True, 'targetRecorded': any(row['version'] == self.helper.VERSION for row in reconciled['ledger']), 'dispatchSpent': True}), flush=True)
            except (Exception, SystemExit):
                print(json.dumps({'readOnlyReconciliation': False, 'dispatchSpent': True}), flush=True)
            raise SystemExit('Write outcome unverified; retain dispatch and reconcile read-only, never retry') from None
        self.retain(args.attestation, dict(self.identity, resultingCatalogSha256=catalog))
        require(self.transaction(source, before) == self.expected_query, 'COMMIT attestation public query identity differs')
        self.verify_after(self.read_state(source), before, source, catalog)
        self.check_inputs()
        print(json.dumps({'committed': True, 'readbackVerified': True, 'writeCount': 1, 'retryCount': 0,
                          'phase': self.phase, 'attestationSha256': sha(source_snapshot(args.attestation, private=True)), 'resultingCatalogSha256': catalog}))


def source_snapshot(path, private=False):
    require(path.is_absolute() and not any(p.is_symlink() for p in [path, *path.parents]), 'Regular non-symlink source/input required')
    descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as handle:
        initial = os.fstat(handle.fileno())
        require(stat.S_ISREG(initial.st_mode) and initial.st_nlink == 1 and initial.st_uid == os.getuid() and not initial.st_mode & 0o022, 'Owned single-link source/input mode required')
        require(not private or stat.S_IMODE(initial.st_mode) == 0o600, 'Credential-safe private input mode required')
        raw = handle.read()
        fields = ('st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_uid', 'st_gid', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        cookie = lambda value: tuple(getattr(value, key) for key in fields)
        require(cookie(initial) == cookie(os.fstat(handle.fileno())) == cookie(path.lstat()) and not any(p.is_symlink() for p in path.parents), 'Source/input snapshot custody changed')
    return raw


def arguments(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('prepare', 'inspect', 'apply'))
    parser.add_argument('--phase', choices=tuple(PHASES), required=True)
    for name in ('head', 'adapter-sha', 'helper-sha', 'guarded-sha', 'transport-sha', 'source-sha', 'annual-sha'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--snapshot-sha')
    parser.add_argument('--dispatch', type=Path)
    parser.add_argument('--attestation', type=Path)
    parser.add_argument('--attestation-sha')
    return parser.parse_args(argv)


def main(argv=None):
    args = arguments(argv)
    adapter = AfterAnnualAdapter(args.phase, args.head, args.adapter_sha, args.helper_sha, args.guarded_sha, args.transport_sha, args.source_sha, args.annual_sha)
    return adapter.run(args)


if __name__ == '__main__':
    main()
