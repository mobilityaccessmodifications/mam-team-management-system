import argparse
import hashlib
import importlib.abc
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
ADAPTER = Path(__file__).resolve()
HELPER = ROOT / 'scripts/deploy-employee-removal-reporting-splice.py'
TRANSPORT = ROOT / 'scripts/deploy-staff-leave-calendar.py'
CORE = ROOT / 'supabase/migrations/20261012170000_employee_removal_reporting_splice.sql'
PREDECESSOR = CORE.parent / '20261012110000_trade_school_leave.sql'
IMMUTABLE = {
    HELPER: '1beac990ddf17652b1e6d98d3d3594c4a311a597e134b99e9dd75b96bf099efc',
    TRANSPORT: '25e257bd80596247f4ae6fadf74e4283c6078a22ad9141d4f24b6614d38fb011',
    CORE: 'f65d043e18716538a6bc29bd0f5d0d95b9d58975de43334705972a0919a4e9e4',
    PREDECESSOR: 'c5b57e19c1ef6a763272e2e2f08d1967aa95bb7fa1aee0ac76b5e949d177f4fe',
}


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def snapshot(path):
    require(path.is_absolute() and not any(p.is_symlink() for p in [path, *path.parents]), 'Regular non-symlink source required')
    descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as handle:
        before = os.fstat(handle.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'Single-link regular source required')
        raw = handle.read()
        after = os.fstat(handle.fileno())
        fields = ('st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_uid', 'st_gid', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        cookie = lambda value: tuple(getattr(value, key) for key in fields)
        require(cookie(before) == cookie(after) == cookie(path.lstat())
                and not any(p.is_symlink() for p in path.parents), 'Source snapshot custody changed')
    return raw


class SourceSnapshotLoader(importlib.abc.Loader):
    def __init__(self, name, path, raw, expected):
        require(sha(raw) == expected, 'Loaded unit snapshot SHA differs')
        self.name, self.path, self.raw, self.expected = name, path, raw, expected

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        require(module.__name__ == self.name and module.__file__ == str(self.path)
                and module.__loader__ is self and sys.modules.get(self.name) is None
                and sha(self.raw) == self.expected, 'Loaded unit identity differs before execution')
        exec(compile(self.raw, str(self.path), 'exec'), module.__dict__)


SETTING_FIELDS = ('dbRoleSettingHash', 'dbRoleSettingCount', 'dbRoleSettingShapeHash')
STATE_FIELDS = {'major', 'dataHash', 'securityHash', 'receiptHash', 'purgeHash', 'purgeMatches', 'predecessorExact',
                'targetExact', 'targetSourceArraySha256', 'ledger', 'functions', 'tradeSchoolEnabledCount', *SETTING_FIELDS}
SETTINGS_EXPRESSION = """(select jsonb_build_object(
 'dbRoleSettingHash',encode(extensions.digest(coalesce(jsonb_agg(
   jsonb_build_object('row',to_jsonb(s),'arrayText',s.setconfig::text,'dimensions',array_dims(s.setconfig),'cardinality',cardinality(s.setconfig))
   order by s.setdatabase,s.setrole),'[]'::jsonb)::text,'sha256'),'hex'),
 'dbRoleSettingCount',count(*),
 'dbRoleSettingShapeHash',encode(extensions.digest(coalesce(jsonb_agg(
   jsonb_build_object('database',s.setdatabase,'role',s.setrole,'dimensions',array_dims(s.setconfig),'cardinality',cardinality(s.setconfig))
   order by s.setdatabase,s.setrole),'[]'::jsonb)::text,'sha256'),'hex'))
 from pg_catalog.pg_db_role_setting s)"""


class ReleaseAdapter:
    def __init__(self, head, adapter_sha, helper_sha, transport_sha, source_sha):
        require(re.fullmatch('[0-9a-f]{40}', head or '') is not None and Path.cwd().resolve() == ROOT, 'Exact approved root and full reviewed HEAD required')
        self.head = head
        self.pins = dict(IMMUTABLE)
        self.pins.update({ADAPTER: adapter_sha, HELPER: helper_sha, TRANSPORT: transport_sha, CORE: source_sha})
        require(all(re.fullmatch('[0-9a-f]{64}', value or '') for value in self.pins.values()), 'Explicit reviewed closure SHA required')
        require(all(self.pins[path] == value for path, value in IMMUTABLE.items()), 'Immutable F65 closure pin differs')
        self.clean_git()
        self.raw = {path: snapshot(path) for path in self.pins}
        for path, raw in self.raw.items():
            require(sha(raw) == self.pins[path] and self.git('show', head + ':' + str(path.relative_to(ROOT))) == raw, 'Reviewed committed closure bytes differ')
        for name in ('guarded_reporting_splice_legacy', 'reporting_splice_transport'):
            require(name not in sys.modules, 'Stale release dependency module prohibited')
        original = importlib.util.spec_from_file_location
        def finite_spec(name, location, *args, **kwargs):
            require(name == 'reporting_splice_transport' and Path(location) == TRANSPORT and not args and not kwargs, 'Unexpected transitive release load')
            loader = SourceSnapshotLoader(name, TRANSPORT, self.raw[TRANSPORT], self.pins[TRANSPORT])
            return original(name, str(TRANSPORT), loader=loader)
        loader = SourceSnapshotLoader('guarded_reporting_splice_legacy', HELPER, self.raw[HELPER], self.pins[HELPER])
        spec = original(loader.name, str(HELPER), loader=loader)
        require(spec is not None, 'Missing release dependency specification')
        assert spec is not None
        self.helper = importlib.util.module_from_spec(spec)
        with patch.object(importlib.util, 'spec_from_file_location', finite_spec):
            loader.exec_module(self.helper)
        self.check_custody()
        self.helper.clean_source(head, source_sha, helper_sha)
        self.legacy_transaction = self.helper.transaction
        self.legacy_verify_after = self.helper.verify_after
        self.active_before = None

    def git(self, *args):
        allowed = {'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull}
        require(all(not key.startswith('GIT_') or allowed.get(key) == value for key, value in os.environ.items()), 'Inherited Git override prohibited')
        environment = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
        environment.update(allowed)
        return subprocess.check_output(['git', *args], cwd=ROOT, env=environment)

    def clean_git(self):
        require(self.git('rev-parse', 'HEAD').decode().strip() == self.head, 'Reviewed HEAD differs')
        require(not self.git('status', '--porcelain').strip(), 'Release tree must be clean')
        require(self.git('remote', 'get-url', 'origin').decode().strip() == 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git', 'Wrong MAM Git remote')
        require(self.git('show', '-s', '--format=%an <%ae>', 'HEAD').decode().strip() == 'mobilityaccessmodifications <310802599+mobilityaccessmodifications@users.noreply.github.com>', 'Wrong MAM source author')
        require(self.git('config', '--local', '--get', 'user.name').decode().strip() == 'mobilityaccessmodifications'
                and self.git('config', '--local', '--get', 'user.email').decode().strip() == '310802599+mobilityaccessmodifications@users.noreply.github.com', 'Wrong repository-local MAM identity')

    def check_custody(self):
        self.clean_git()
        require(all(snapshot(path) == raw for path, raw in self.raw.items()), 'Reviewed source custody changed')

    def verified_source(self, source):
        require(source.encode('utf-8') == self.raw[CORE], 'Immutable verified F65 source required')

    def settings(self, frame):
        require(isinstance(frame, dict) and all(field in frame for field in SETTING_FIELDS), 'Native database-role settings snapshot required')
        require(set(frame) == STATE_FIELDS, 'Exact credential-safe native snapshot fields required')
        require(type(frame['dbRoleSettingCount']) is int and frame['dbRoleSettingCount'] >= 0, 'Invalid native database-role settings count')
        require(all(isinstance(frame[field], str) and re.fullmatch('[0-9a-f]{64}', frame[field]) for field in ('dbRoleSettingHash', 'dbRoleSettingShapeHash')), 'Invalid native database-role settings digest')
        return {field: frame[field] for field in SETTING_FIELDS}

    def state_expression(self, source):
        self.verified_source(source)
        return '(' + self.helper.state_expression(source) + ') || ' + SETTINGS_EXPRESSION

    def read_state(self, source):
        self.check_custody()
        result = self.helper.query("begin read only; set local search_path=''; set local lock_timeout='3s'; set local statement_timeout='30s';\n" + self.helper.ledger_bound() + '\nselect ' + self.state_expression(source) + ' as state; rollback;')
        require(isinstance(result, list) and len(result) == 1 and isinstance(result[0].get('state'), dict), 'Invalid bounded read-only state response')
        self.settings(result[0]['state'])
        return result[0]['state']

    def guard_blocks(self, before):
        expected = self.helper.literal(json.dumps(self.settings(before), separators=(',', ':'), allow_nan=False)) + '::jsonb'
        capture = '\ncreate temporary table reporting_splice_guard_settings_before on commit drop as select ' + SETTINGS_EXPRESSION + ' value;\n'
        capture += 'do $reporting_splice_guard_settings_before$ begin if (select value from pg_temp.reporting_splice_guard_settings_before) is distinct from ' + expected + " then raise exception 'Reporting splice database-role settings predecessor changed' using errcode='55000'; end if; end $reporting_splice_guard_settings_before$;"
        final = '\ndo $reporting_splice_guard_settings_final$ begin if ' + SETTINGS_EXPRESSION + " is distinct from (select value from pg_temp.reporting_splice_guard_settings_before) then raise exception 'Reporting splice database-role settings final state differs' using errcode='55000'; end if; end $reporting_splice_guard_settings_final$;"
        return capture, final

    def transaction(self, source, before):
        self.verified_source(source)
        if getattr(self, 'active_before', None) is not None:
            require(before == self.active_before, 'Parsed snapshot differs from reviewed bytes')
        original_before = {key: value for key, value in before.items() if key not in SETTING_FIELDS}
        original = self.legacy_transaction(source, original_before)
        capture, final = self.guard_blocks(before)
        anchors = ('\ndo $reporting_splice_release_before$', '\nnotify pgrst,\'reload schema\';\nselect value as "reportingSpliceResultingCatalogSha256"')
        guarded = original
        for anchor, block in zip(anchors, (capture, final)):
            require(original.count(anchor) == 1, 'Unique live outer release guard required')
            guarded = guarded.replace(anchor, block + anchor, 1)
        restored = guarded
        for block in (capture, final):
            require(restored.count(block) == 1, 'Unique supplementary guard block required')
            restored = restored.replace(block, '', 1)
        require(restored == original, 'Original release query changed beyond supplement')
        return guarded

    def verify_after(self, actual, before, source, expected_catalog):
        self.verified_source(source)
        require(self.settings(actual) == self.settings(before), 'Protected readback differs: database-role settings')
        if getattr(self, 'expected_query', None) is not None:
            require(self.transaction(source, before) == self.expected_query, 'Independent public query identity differs')
        self.legacy_verify_after(actual, before, source, expected_catalog)

    def main(self, argv):
        args = arguments(argv)
        require(args.head == self.head and args.source_sha == self.pins[CORE] and args.helper_sha == self.pins[HELPER], 'Entrypoint reviewed closure differs')
        self.check_custody()
        self.inputs = {}
        self.entered_write = False
        self.expected_query = None
        self.active_before = None
        identity = None
        if args.action != 'prepare':
            raw = snapshot(args.snapshot)
            require(re.fullmatch('[0-9a-f]{64}', args.snapshot_sha or '') is not None and sha(raw) == args.snapshot_sha, 'Explicit reviewed predecessor snapshot differs')
            self.inputs[args.snapshot] = raw
            self.active_before = self.helper.load_json(raw)
            self.settings(self.active_before)
            source = self.raw[CORE].decode('utf-8')
            self.expected_query = self.transaction(source, self.active_before)
            identity = {'project': self.helper.PROJECT, 'organization': self.helper.ORGANISATION, 'version': self.helper.VERSION,
                        'head': self.head, 'sourceSha256': self.pins[CORE], 'snapshotSha256': args.snapshot_sha,
                        'transactionSha256': sha(self.expected_query.encode())}
            if args.dispatch is not None and args.dispatch.exists():
                require(self.helper.load_json(snapshot(args.dispatch)) == identity, 'Spent dispatch public query identity differs; reconcile read-only')
            if args.attestation_sha is not None:
                require(args.dispatch is not None and args.dispatch.exists(), 'Retained spent dispatch required for reconciliation')
        original_api, original_query = self.helper.api, self.helper.query
        def checked(function, *values):
            self.check_inputs()
            writing = function is original_query and not values[0].startswith('begin read only;')
            if writing:
                require(values[0] == self.expected_query and args.dispatch is not None
                        and self.helper.load_json(snapshot(args.dispatch)) == identity, 'Exact public query/spent journal required before dispatch')
                self.entered_write = True
            pending = None
            try:
                return function(*values)
            except BaseException as error:
                pending = error
                raise
            finally:
                self.final_custody(pending)
        pending = None
        try:
            with patch.object(self.helper, 'transaction', self.transaction), patch.object(self.helper, 'read_state', self.read_state), \
                 patch.object(self.helper, 'verify_after', self.verify_after), \
                 patch.object(self.helper, 'api', lambda *values: checked(original_api, *values)), \
                 patch.object(self.helper, 'query', lambda *values: checked(original_query, *values)):
                return self.helper.main(argv)
        except BaseException as error:
            pending = error
            raise
        finally:
            self.final_custody(pending)
            self.active_before = None

    def check_inputs(self):
        self.check_custody()
        require(all(snapshot(path) == raw for path, raw in self.inputs.items()), 'Reviewed input custody changed')

    def final_custody(self, pending):
        try:
            self.check_inputs()
        except BaseException:
            print(json.dumps({'sourceHold': True, 'enteredWrite': self.entered_write, 'retryAllowed': False}), flush=True)
            if pending is None:
                raise


def arguments(argv, outer=False):
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('prepare', 'inspect', 'apply'))
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--snapshot', required=True, type=Path)
    parser.add_argument('--snapshot-sha')
    parser.add_argument('--head', required=True)
    parser.add_argument('--helper-sha', required=True)
    if outer:
        parser.add_argument('--adapter-sha', required=True)
        parser.add_argument('--transport-sha', required=True)
    parser.add_argument('--attestation', type=Path)
    parser.add_argument('--attestation-sha')
    parser.add_argument('--dispatch', type=Path)
    return parser.parse_args(argv)


def main(argv=None):
    args = arguments(argv, outer=True)
    adapter = ReleaseAdapter(args.head, args.adapter_sha, args.helper_sha, args.transport_sha, args.source_sha)
    legacy = [args.action]
    for name in ('source_sha', 'snapshot', 'snapshot_sha', 'head', 'helper_sha', 'attestation', 'attestation_sha', 'dispatch'):
        value = getattr(args, name)
        if value is not None:
            legacy.extend(['--' + name.replace('_', '-'), str(value)])
    return adapter.main(legacy)


if __name__ == '__main__':
    main()

