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

ROOT = Path(__file__).resolve().parents[1]
SOCKET = Path(sys.argv[1]).resolve()
BASE = sys.argv[2]
assert re.fullmatch(r'mam-openclaw-pg\.[A-Za-z0-9]+', SOCKET.name)
assert SOCKET.parent == Path(os.environ['TMPDIR']).resolve()
marker = json.loads((SOCKET / 'mam-test-cluster.json').read_text())
assert marker == {'owner': 'mam-local-tests-v1', 'socket': str(SOCKET), 'port': 55439}
assert re.fullmatch(r'mam_test_[a-z0-9_]+', BASE)
ENV = {'PATH': os.environ['PATH'], 'TMPDIR': str(SOCKET.parent), 'LC_ALL': 'C', 'LANG': 'C', 'PGPASSWORD': 'synthetic-local-unused', 'PYTHONDONTWRITEBYTECODE': '1'}
prefix = 'mam_test_continuous_release_' + str(os.getpid())
owned = []


def command(binary, args, sql=None, required=True):
    p = subprocess.run([binary] + args, input=sql, env=ENV, cwd=ROOT, text=True, capture_output=True, timeout=120)
    if required and p.returncode:
        raise RuntimeError(p.stderr)
    return p


def clone(name, template):
    command('createdb', ['-h', str(SOCKET), '-p', '55439', '-U', 'postgres', '--template=' + template, name])
    owned.append(name)


def native(database, text, required=True):
    return command('psql', ['-X', '-h', str(SOCKET), '-p', '55439', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-Atq'], text, required)


spec = importlib.util.spec_from_file_location('annual_release_native', ROOT / 'scripts/deploy-annual-continuous-accrual.py')
assert spec is not None and spec.loader is not None
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
source = h.read_migration()
passed = []
current = None
writes = 0


def transport(text):
    global writes
    if text.startswith('begin;'):
        writes += 1
    output = native(current, text).stdout.strip()
    if ') as frame; rollback;' in text:
        return [{'frame': json.loads(output)}]
    if text.startswith('begin read only;') and 'select version from supabase_migrations.schema_migrations' in text:
        return [{'version': x} for x in output.splitlines() if x]
    return []


h.query = transport
h.api = lambda: {'id': h.PROJECT, 'organization_id': h.ORG, 'fixture': 'synthetic-native-transport'}
h.clean_source = lambda: 'SYNTHETIC_NATIVE_FIXTURE_NOT_GIT_CUSTODY'
try:
    baseline = prefix + '_base'
    clone(baseline, BASE)
    current = baseline
    assert native(current, "select to_regclass('supabase_migrations.schema_migrations') is not null;").stdout.strip() == 't'
    for path in sorted((ROOT / 'supabase/migrations').glob('*.sql')):
        if path == h.MIGRATION:
            continue
        version, name = path.stem.split('_', 1)
        if native(current, 'select exists(select 1 from supabase_migrations.schema_migrations where version=' + h.literal(version) + ');').stdout.strip() == 't':
            continue
        native(current, 'insert into supabase_migrations.schema_migrations(version,name,statements) values(' + ','.join([h.literal(version), h.literal(name), 'array[' + h.literal(path.read_bytes().decode('utf-8')) + ']']) + ');')
    frame = h.read_frame(source)
    pins = h.prepare_pins(source, frame)
    transaction = h.build_transaction(source, pins)
    assert transaction.startswith('begin;') and transaction.endswith('commit;')
    manifest = SOCKET / (prefix + '-pins.json')
    manifest.write_text(json.dumps(pins, indent=2))
    h.PINS = manifest
    journal_directory = SOCKET / (prefix + '-journal')
    journal_directory.mkdir(mode=0o700)
    os.environ['MAM_ANNUAL_CONTINUOUS_JOURNAL_DIR'] = str(journal_directory)
    pins_sha = h.byte_digest(manifest)
    database = prefix + '_success'
    clone(database, baseline)
    current = database
    writes = 0
    with contextlib.redirect_stdout(io.StringIO()) as capture:
        sys.argv = [str(h.__file__), 'apply', h.MIGRATION_SHA, pins_sha]
        h.main()
    assert writes == 1 and json.loads(capture.getvalue())['readbackVerified'] is True
    h.validate_frame(h.read_frame(source, True), pins, True)
    passed.append('native exact apply entrypoint commits one ledger/source/catalog transaction and independent readback')
    writes = 0
    with contextlib.redirect_stdout(io.StringIO()) as capture:
        h.main()
    assert writes == 0 and json.loads(capture.getvalue())['readOnly'] is True
    passed.append('recorded exact source is read-only idempotent with zero repeated writes')
    h.api = lambda: {'id': h.PROJECT, 'organization_id': 'synthetic-wrong-org'}
    try:
        h.main()
        raise AssertionError('Wrong org was admitted')
    except ValueError as e:
        assert str(e) == 'Wrong MAM organization/project'
    h.api = lambda: {'id': h.PROJECT, 'organization_id': h.ORG}
    passed.append('wrong organization rejected before database queries')
    for label, before_sql, late_sql, defer in [
        ('predecessor_definition', "create or replace function private.payroll_request_hours_after(p_request uuid,p_after date) returns numeric language sql stable security definer set search_path='' as $$select 999::numeric$$;", None, False),
        ('ledger_bounds', "update supabase_migrations.schema_migrations set statements=('[-1:-1]={synthetic}')::text[] where version=(select min(version) from supabase_migrations.schema_migrations);", None, False),
        ('late_column_grant', "create schema fixture_release; create table fixture_release.security_probe(payload text);", "grant select(payload) on fixture_release.security_probe to authenticated;", False),
        ('deferred_security', "create schema fixture_release; create table fixture_release.security_probe(payload text); create function fixture_release.ledger_fault() returns trigger language plpgsql as $$begin execute 'grant select(payload) on fixture_release.security_probe to authenticated'; return new; end$$; create constraint trigger fixture_release_deferred after insert on supabase_migrations.schema_migrations deferrable initially deferred for each row execute function fixture_release.ledger_fault();", None, True),
    ]:
        database = prefix + '_' + label
        clone(database, baseline)
        current = database
        native(current, before_sql)
        fault_pins = h.prepare_pins(source, h.read_frame(source)) if defer else pins
        candidate = h.build_transaction(source, fault_pins)
        insert = '\ninsert into supabase_migrations.schema_migrations(version,name,statements) values('
        assert candidate.count(insert) == 1
        if late_sql:
            final = '\ndo $annual_continuous_release_final$'
            assert candidate.count(final) == 1
            candidate = candidate.replace(final, '\n' + late_sql + final)
        if defer:
            candidate = candidate.replace(insert, '\nset constraints supabase_migrations.fixture_release_deferred deferred;' + insert)
        result = native(current, candidate, required=False)
        assert result.returncode != 0 and any(x in result.stderr for x in ['catalog or raw ledger drift', 'final catalog or security drift', 'final complete security drift']), result.stderr
        check = native(current, "select to_regclass('private.annual_leave_day_accounting') is null and not exists(select 1 from supabase_migrations.schema_migrations where version='20261013120000');").stdout.strip()
        assert check == 't'
        if late_sql or defer:
            assert native(current, "select not has_column_privilege('authenticated','fixture_release.security_probe','payload','SELECT');").stdout.strip() == 't'
            h.validate_frame(h.read_frame(source), fault_pins, False)
        passed.append(label + ': generated transaction fails closed with schema/ledger/security rollback')
    current = baseline
    with contextlib.redirect_stdout(io.StringIO()) as captured:
        sys.argv = [str(h.__file__), 'inspect']
        h.main()
    inspected = json.loads(captured.getvalue())
    assert inspected == pins
    passed.append('inspect emits exact reviewed-scope metadata pins using READ ONLY transactions')
    print(json.dumps({'status': 'PASS', 'migrationSha256': h.MIGRATION_SHA, 'helperSha256': h.byte_digest(Path(h.__file__)), 'serverMajor': frame['serverMajor'], 'nativeCases': len(passed), 'cases': passed, 'fixture': 'owned PostgreSQL 16; synthetic provider transport and source admission; Git rejection gates tested separately'}, indent=2))
finally:
    for database in reversed(owned):
        command('dropdb', ['-h', str(SOCKET), '-p', '55439', '-U', 'postgres', database])
