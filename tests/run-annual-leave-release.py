import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
socket, base, *options = sys.argv[1:]
focus = options[0] if options else None
require_options = not options or options in (['--triggers'], ['--attestation'], ['--entrypoint'], ['--weekdays'])
if not require_options:
    raise ValueError('Unsupported focused release fixture')
evidence = ROOT / 'output/annual-gate-resume' / ('review-fix-release-' + str(os.getpid()))
evidence.mkdir(mode=0o700, parents=True)
require = lambda condition, message: condition or (_ for _ in ()).throw(AssertionError(message))
require(re.fullmatch('mam_test_annual_[a-z0-9_]+', base) is not None, 'Synthetic predecessor only')
marker = json.loads((Path(socket) / 'mam-test-cluster.json').read_bytes())
require(marker == {'owner': 'mam-local-tests-v1', 'socket': str(Path(socket).resolve()), 'port': 55439}, 'Owned socket required')
env = {key: os.environ[key] for key in ('PATH', 'TMPDIR') if key in os.environ}
env.update(PGPASSFILE='/dev/null', PGSERVICEFILE='/dev/null', PGCONNECT_TIMEOUT='5', PGPASSWORD='synthetic-local-unused', LANG='C', LC_ALL='C')
spec = importlib.util.spec_from_file_location('annual_release', ROOT / 'scripts/deploy-annual-leave-all-submitter-gate.py')
assert spec is not None and spec.loader is not None, 'Release source required'
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
pins = json.loads(m.PINS.read_bytes())
source = m.candidate(pins['migrationSha256'])


def execute(db, text, expected=0):
    require(re.fullmatch('mam_test_annual_[a-z0-9_]+', db) is not None, 'Synthetic database required')
    file = Path(socket) / (db + '-release.sql')
    file.write_text(text)
    file.chmod(0o600)
    result = subprocess.run(['psql', '-X', '-h', socket, '-p', '55439', '-U', 'postgres', '-d', db,
        '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-Atq', '-f', str(file)], env=env, capture_output=True, text=True)
    if expected:
        (evidence / (db + '.sql')).write_text(text)
        (evidence / (db + '.result.json')).write_text(json.dumps({'returncode': result.returncode, 'expectedSqlstate': '55000'}) + '\n')
        (evidence / (db + '.stdout')).write_text(result.stdout)
        (evidence / (db + '.stderr')).write_text(result.stderr)
    if expected == 0:
        require(result.returncode == 0, result.stderr)
    else:
        require(result.returncode != 0 and '55000:' in result.stderr, 'Expected guarded rollback: ' + result.stderr)
    rows = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
    rows.extend({'annualGateResultingCatalogSha256': line} for line in result.stdout.splitlines() if re.fullmatch('[0-9a-f]{64}', line))
    return rows


def clone(name):
    subprocess.run(['createdb', '-h', socket, '-p', '55439', '-U', 'postgres', '--template=' + base, name], env=env, check=True)
    execute(name, (ROOT / 'tests/annual-leave-legacy-setup.sql').read_text())
    execute(name, "insert into supabase_migrations.schema_migrations(version,name,statements) values('20261006104000','unified_portal_roles',array['Synthetic predecessor source']),('20260801000000','synthetic_legacy',null) on conflict(version) do nothing;")
    return name


def state_transport(db, text):
    if ' as state; rollback;' in text:
        return [{'state': row} for row in execute(db, text)]
    require(' as exact ' in text, 'Unexpected fixture-only provider boundary')
    return execute(db, text.replace('select statements[1]=', "select jsonb_build_object('exact',statements[1]=").replace(' as exact from ', ') from '))


def trigger_regressions():
    faults = [
        ('public.leave_requests', 'z_leave_requests_banked_annual_limit', 'before insert or update', 'row', 'private.enforce_banked_annual_leave_request()', ' when (false)'),
        ('private.employee_directory_details', 'aa_guard_legacy_annual_leave_classification', 'before update of working_weekdays', 'row', 'private.guard_legacy_annual_leave_classification()', ''),
    ]
    for relation, column in (
        ('private.employee_annual_leave_balances', 'hours'), ('private.employee_directory_details', 'employment_type'),
        ('private.leave_accrual_day_reviews', 'person_id'), ('private.leave_accrual_policies', 'person_id'),
        ('private.leave_balance_approvals', 'request_id'), ('private.payroll_carryforward_events', 'request_id'),
        ('public.internal_org_people', 'full_name'),
    ):
        events = 'before update of ' + column + ' or delete' if relation == 'public.internal_org_people' else 'before insert or update of ' + column + ' or delete'
        faults.append((relation, 'aa_lock_annual_leave_budget', events, 'statement', 'private.lock_annual_leave_budget_statement()', ''))
    faults.extend([
        ('private.leave_balance_approvals', 'leave_balance_approvals_fill_required_hours', 'before insert or update of required_hours', 'row', 'private.fill_leave_balance_required_hours()', ''),
        ('public.leave_requests', 'z_leave_requests_refresh_required_hours', 'after update of hours', 'row', 'private.refresh_annual_leave_required_hours()', ''),
    ])
    require(len(faults) == 11, 'Every reviewed trigger must be exercised')
    for phase, anchor in (
        ('capture', 'create temporary table annual_gate_trigger_after on commit drop as'),
        ('refresh', 'set constraints all immediate;\ndo $$ begin\n  perform pg_temp.annual_gate_assert_triggers();'),
    ):
        require(source.count(anchor) == 1, 'Exact core trigger boundary required')
        for index, (relation, name, events, level, function, predicate) in enumerate(faults):
            db = clone('mam_test_annual_trigger_' + str(os.getpid()) + '_' + phase + '_' + str(index))
            setattr(m, 'query', lambda text: state_transport(db, text))
            before = m.read_state(source)
            fault = f'drop trigger {name} on {relation};\ncreate trigger {name} {events} on {relation} for each {level}{predicate} execute function {function};\n'
            execute(db, source.replace(anchor, fault + anchor), expected=1)
            require(m.read_state(source) == before, 'Failed core changed complete catalog data raw ledger receipts or security')
            print('PASS T20 exact core trigger rollback ' + phase + ' ' + relation + '/' + name)


def attestation_regressions():
    db = clone('mam_test_annual_attestation_' + str(os.getpid()))
    setattr(m, 'query', lambda text: state_transport(db, text))
    snapshot = evidence / 'generated-snapshot.json'
    snapshot.write_text(json.dumps(m.read_state(source), sort_keys=True, indent=2) + '\n')
    before = json.loads(snapshot.read_bytes())
    result = execute(db, m.transaction(source, before, pins))
    expected_catalog = m.resulting_catalog(result)
    (evidence / 'exact-commit-attestation.json').write_text(json.dumps(result, indent=2) + '\n')
    actual = m.read_state(source)
    m.verify_after(actual, before, source, pins, expected_catalog)
    print('PASS T20 actual generated COMMIT attestation binds legitimate independent readback')
    for label, value in (('missing', None), ('malformed', 'unapproved'), ('tampered', '0' * 64)):
        changed = dict(actual)
        if value is None:
            changed.pop('purgeHash')
        else:
            changed['purgeHash'] = value
        try:
            m.verify_after(changed, before, source, pins, expected_catalog)
        except ValueError:
            pass
        else:
            raise AssertionError('Independent readback accepted ' + label + ' catalog hash')
        print('PASS T20 independent readback rejects ' + label + ' catalog hash')
    for result in ([], [{}], [{'annualGateResultingCatalogSha256': 'unapproved'}], [{'annualGateResultingCatalogSha256': expected_catalog}] * 2):
        try:
            m.resulting_catalog(result)
        except ValueError:
            pass
        else:
            raise AssertionError('Missing malformed or duplicate COMMIT attestation accepted')
    for expected in (None, '', 'unapproved', '0' * 64):
        try:
            m.verify_after(actual, before, source, pins, expected)
        except ValueError:
            pass
        else:
            raise AssertionError('Unapproved expected catalog attestation accepted')
    proof = evidence / 'generated-attestation.json'
    attestation = {
        'project': m.PROJECT, 'organization': m.ORG, 'version': m.VERSION, 'sourceSha256': pins['migrationSha256'],
        'snapshotSha256': m.sha(snapshot.read_bytes()), 'transactionSha256': m.sha(m.transaction(source, before, pins).encode()),
        'resultingCatalogSha256': expected_catalog,
    }
    proof.write_text(json.dumps(attestation, sort_keys=True, indent=2) + '\n')
    reads = []
    def read_only_transport(text):
        require(text.startswith('begin read only;') and (' as state; rollback;' in text or ' as exact ' in text), 'Recorded inspect attempted a write or retried the unknown transaction')
        reads.append(text)
        return state_transport(db, text)
    setattr(m, 'query', read_only_transport)
    setattr(m.SHARED, 'api', lambda: {'id': m.PROJECT, 'organization_id': m.ORG})
    def inspect_recorded(proof_args, rejected=False):
        argv = sys.argv
        sys.argv = ['fixture', 'inspect', '--source-sha', pins['migrationSha256'], '--snapshot', str(snapshot),
            '--snapshot-sha', m.sha(snapshot.read_bytes())] + proof_args
        output = io.StringIO()
        try:
            with contextlib.redirect_stdout(output):
                m.main()
        except ValueError as error:
            require(rejected, str(error))
            output.write('REJECTED ' + str(error) + '\n')
        else:
            require(not rejected, 'Recorded inspect accepted missing or invalid COMMIT proof')
            require(json.loads(output.getvalue())['readOnly'] is True, 'Recorded inspect must report no write')
        finally:
            sys.argv = argv
            with (evidence / 'generated-recorded-inspect.log').open('a') as log:
                log.write(output.getvalue())
    proof_args = ['--attestation', str(proof), '--attestation-sha', m.sha(proof.read_bytes())]
    inspect_recorded(proof_args)
    inspect_recorded([], rejected=True)
    inspect_recorded(['--attestation', str(proof), '--attestation-sha', '0' * 64], rejected=True)
    require(m.read_state(source) == actual and reads, 'Read-only recorded inspection changed committed state')
    print('PASS T20 actual recorded inspect uses retained generated COMMIT proof and never writes; clean-source apply gate remains separate')
    execute(db, "alter function private.assert_leave_date_range(date,date) cost 101; update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;")
    drift = m.read_state(source)
    require(drift['purgeMatches'] is True and drift['purgeHash'] != expected_catalog and drift['functions'] == actual['functions'], 'Actual unselected catalog and stored-fingerprint drift required')
    require(all(drift[field] == actual[field] for field in ('dataHash', 'securityHash', 'receiptHash', 'ledger')), 'Catalog drift must isolate this finding')
    try:
        m.verify_after(drift, before, source, pins, expected_catalog)
    except ValueError:
        pass
    else:
        raise AssertionError('Self-consistent unapproved catalog drift accepted')
    print('PASS T20 missing malformed duplicate expected attestations and unselected catalog plus stored-fingerprint drift fail closed')


def entrypoint_regressions():
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    helper_sha = m.sha((ROOT / 'scripts/deploy-annual-leave-all-submitter-gate.py').read_bytes())
    pins_sha = m.sha(m.PINS.read_bytes())
    m.clean_source(head, pins['migrationSha256'], helper_sha, pins_sha)
    setattr(m.SHARED, 'api', lambda: {'id': m.PROJECT, 'organization_id': m.ORG})
    for mode in ('known', 'unknown'):
        db = clone('mam_test_annual_main_' + str(os.getpid()) + '_' + mode)
        snapshot = evidence / (mode + '-snapshot.json')
        attestation = evidence / (mode + '-attestation.json')
        writes = []
        def transport(text):
            if ' as state; rollback;' in text or ' as exact ' in text:
                return state_transport(db, text)
            before = json.loads(snapshot.read_bytes())
            require(text == m.transaction(source, before, pins) and not writes, 'Only one exact generated COMMIT may reach fixture transport')
            writes.append(m.sha(text.encode()))
            result = execute(db, text)
            return result if mode == 'known' else []
        setattr(m, 'query', transport)
        def invoke(action, extra=(), rejected=False):
            argv = sys.argv
            args = ['fixture', action, '--source-sha', pins['migrationSha256'], '--snapshot', str(snapshot),
                '--head', head, '--helper-sha', helper_sha, '--pins-sha', pins_sha]
            if snapshot.exists():
                args += ['--snapshot-sha', m.sha(snapshot.read_bytes())]
            sys.argv = args + list(extra)
            output = io.StringIO()
            try:
                with contextlib.redirect_stdout(output):
                    m.main()
            except ValueError as error:
                require(rejected, str(error))
                output.write('REJECTED ' + str(error) + '\n')
            else:
                require(not rejected, 'Entrypoint accepted invalid or missing attestation')
            finally:
                sys.argv = argv
                with (evidence / (mode + '-main.log')).open('a') as log:
                    log.write(output.getvalue())
            return [json.loads(line) for line in output.getvalue().splitlines() if line.startswith('{')]
        require(invoke('prepare')[-1]['readOnly'] is True and not writes, 'prepare must only read')
        require(invoke('inspect')[-1]['targetAbsent'] is True and not writes, 'absent inspection must only read')
        applied = invoke('apply', ['--attestation', str(attestation)], rejected=mode == 'unknown')
        require(len(writes) == 1, 'Exactly one COMMIT transport required')
        committed_state = m.read_state(source)
        if mode == 'unknown':
            require(not attestation.exists(), 'Missing COMMIT response must not adopt observed catalog hash')
            invoke('inspect', rejected=True)
            invoke('apply', rejected=True)
        else:
            require(applied[-1]['readbackVerified'] is True and attestation.exists(), 'Actual main must retain COMMIT proof and independently read back')
            proof_args = ['--attestation', str(attestation), '--attestation-sha', m.sha(attestation.read_bytes())]
            require(invoke('apply', proof_args)[-1]['readOnly'] is True, 'Recorded apply must be read-only after real clean_source')
            require(invoke('inspect', proof_args)[-1]['recorded'] is True, 'Recorded inspection must reconcile to retained proof')
            invoke('apply', rejected=True)
            invoke('inspect', rejected=True)
            bad = evidence / 'tampered-attestation.json'
            changed = json.loads(attestation.read_bytes())
            changed['resultingCatalogSha256'] = '0' * 64
            bad.write_text(json.dumps(changed))
            invoke('inspect', ['--attestation', str(bad), '--attestation-sha', m.sha(bad.read_bytes())], rejected=True)
        require(len(writes) == 1 and m.read_state(source) == committed_state, 'Recorded or uncertain reconciliation must never retry or mutate')
        print('PASS T20 actual clean committed-source main and recorded no-write reconciliation ' + mode)


def weekday_regressions():
    db = clone('mam_test_annual_weekday_' + str(os.getpid()))
    fixture = (ROOT / 'tests/annual-leave-all-submitters.sql').read_text()
    anchor = "'annual','Annual leave',"
    request_dates = fixture.split('DO $$ BEGIN\n  BEGIN', 1)[1].split(anchor, 1)[1].split(',1,7.6);', 1)[0]
    definitions = ''
    helper_anchor = 'CREATE FUNCTION pg_temp.annual_fixture_weekday'
    if helper_anchor in fixture:
        definitions = helper_anchor + fixture.split(helper_anchor, 1)[1].split('$$;', 1)[0] + '$$;\n'
    for day in ('2026-10-10', '2026-10-11'):
        dates = request_dates.replace('current_date', "date '" + day + "'")
        result = execute(db, 'begin;\n' + definitions + "select jsonb_build_object('start',start_day,'end',end_day,'weekday',extract(isodow from start_day)) from (select " + dates + ') r(start_day,end_day); rollback;')[0]
        require(result['start'] == result['end'] and 1 <= result['weekday'] <= 5, 'T06 fixture is not a working day for weekend anchor ' + day + ': ' + str(result))
        require(result['start'] == '2026-10-12', 'Weekend anchor must select the next Monday without changing the clock')
        print('PASS T20 weekday fixture anchor ' + day + ' selects 2026-10-12')


if focus == '--entrypoint':
    entrypoint_regressions()
if focus in (None, '--weekdays'):
    weekday_regressions()
if focus in (None, '--triggers'):
    trigger_regressions()
if focus in (None, '--attestation'):
    attestation_regressions()
if focus:
    sys.exit(0)

for mode in ('success', 'late_security', 'late_data', 'ledger_bounds'):
    db = clone('mam_test_annual_release_' + str(os.getpid()) + '_' + mode)
    def transport(text):
        if ' as state; rollback;' in text:
            return [{'state': row} for row in execute(db, text)]
        require(' as exact ' in text, 'Unexpected fixture-only provider boundary')
        parsed = execute(db, text.replace('select statements[1]=', "select jsonb_build_object('exact',statements[1]=").replace(' as exact from ', ') from '))
        return parsed
    setattr(m, 'query', transport)
    before = m.read_state(source)
    transaction = m.transaction(source, before, pins)
    if mode == 'success':
        result = execute(db, transaction)
        m.verify_after(m.read_state(source), before, source, pins, m.resulting_catalog(result))
        print('PASS T20 exact helper transaction commits source and ledger with unchanged data receipts and complete security')
    else:
        anchor = '\nset constraints all immediate;\ndo $annual_release$'
        require(transaction.count(anchor) == 1, 'Exact final envelope boundary required')
        fault = {
            'late_security': 'alter role service_role createrole;',
            'late_data': "update private.employee_annual_leave_balances set hours=hours+1;",
            'ledger_bounds': "update supabase_migrations.schema_migrations set statements='[0:0]={Synthetic predecessor source}'::text[] where version='20261006104000';",
        }[mode]
        execute(db, transaction.replace(anchor, '\n' + fault + anchor), expected=1)
        require(m.read_state(source) == before, 'Failed helper changed schema raw ledger data receipts or security')
        print('PASS T20 actual final envelope rollback ' + mode)
