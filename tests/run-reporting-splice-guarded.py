import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from unittest.mock import patch

from test_reporting_splice_guarded import ROOT, ADAPTER, HELPER, TRANSPORT, CORE, source_fixture, adapter_for, load, digest


def run(socket, predecessor, prefix, evidence, legacy_red=False, phase='all', fixture_admin='postgres'):
    socket = Path(socket).resolve()
    assert json.loads((socket / 'mam-test-cluster.json').read_bytes()) == {'owner': 'mam-local-tests-v1', 'socket': str(socket), 'port': 55439}
    assert socket.parent == Path(tempfile.gettempdir()).resolve()
    assert all(re.fullmatch('mam_test_[a-z0-9_]+', name) for name in (predecessor, prefix)) and len(prefix) < 32
    evidence = Path(evidence).resolve()
    evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    env = {'PATH': os.environ['PATH'], 'LANG': 'C', 'LC_ALL': 'C', 'TMPDIR': str(socket.parent),
           'PGPASSFILE': '/dev/null', 'PGSERVICEFILE': '/dev/null', 'PGCONNECT_TIMEOUT': '5', 'PYTHONDONTWRITEBYTECODE': '1'}
    sequence = 0
    cases = []
    databases = []
    role = prefix + '_subject'
    def native(database, sql, user='postgres'):
        nonlocal sequence
        sequence += 1
        file = evidence / ('query-%03d.sql' % sequence)
        file.write_bytes(sql.encode())
        file.chmod(0o600)
        result = subprocess.run(['psql', '-X', '-h', str(socket), '-p', '55439', '-U', user, '-d', database,
                                 '-v', 'ON_ERROR_STOP=1', '-Atq', '-f', str(file)], env=env, capture_output=True, text=True, timeout=95)
        (evidence / ('query-%03d.log' % sequence)).write_text(result.stdout + result.stderr)
        (evidence / ('query-%03d.json' % sequence)).write_text(json.dumps({'database': database, 'user': user, 'exitCode': result.returncode,
            'querySha256': digest(sql.encode()), 'stdoutSha256': digest(result.stdout.encode()), 'stderrSha256': digest(result.stderr.encode())}, sort_keys=True))
        return result
    def success(database, sql, user='postgres'):
        result = native(database, sql, user)
        assert result.returncode == 0, result.stderr
        return result.stdout.strip()
    def command(binary, args):
        result = subprocess.run([binary, '-h', str(socket), '-p', '55439', '-U', 'postgres', *args], env=env, capture_output=True, text=True, timeout=90)
        assert result.returncode == 0, result.stderr
    def clone(suffix):
        database = prefix + '_' + suffix
        command('createdb', ['--template=' + predecessor, database])
        databases.append(database)
        isolation = json.loads(success(database, "begin read only; select json_build_object('database',current_database(),'currentUser',current_user,'sessionUser',session_user,'major',current_setting('server_version_num')::int/10000,'socketOnly',inet_server_addr() is null and current_setting('listen_addresses')='','superuser',(select rolsuper from pg_roles where rolname=current_user)); rollback;"))
        assert isolation['database'] == database and isolation['currentUser'] == 'postgres' and isolation['sessionUser'] == 'postgres' and isolation['socketOnly'] and isolation['major'] in (16, 17)
        (evidence / (suffix + '-connection.json')).write_text(json.dumps(isolation, indent=2))
        success(database, 'alter role ' + role + ' in database ' + database + ' set default_transaction_read_only=on;')
        return database
    try:
        success(predecessor, 'create role ' + role + ' login;')
        with source_fixture() as (root, parent, head, pins, git):
            old = load(root / HELPER, 'f65_native_old')
            source = old.candidate(pins[CORE])
            def old_state(database):
                return json.loads(success(database, "begin read only; set local search_path=''; select " + old.state_expression(source) + '; rollback;'))
            if legacy_red:
                database = clone('red')
                before = old_state(database)
                old.validate_before(before, source)
                assert success(database, 'show default_transaction_read_only;', role) == 'on'
                release = old.transaction(source, before)
                anchor = '\ndo $reporting_splice_release_final$'
                assert release.count(anchor) == 1
                fault = '\nalter role ' + role + ' in database ' + database + ' set default_transaction_read_only=off;'
                injected = release.replace(anchor, fault + anchor, 1)
                assert injected.replace(fault, '', 1) == release
                result = native(database, injected)
                assert result.returncode == 0, result.stderr
                catalog = result.stdout.strip()
                after = old_state(database)
                old.verify_after(after, before, source, catalog)
                effective = success(database, 'show default_transaction_read_only;', role)
                outcome = {'case': 'legacy_setting_drift_RED', 'committed': True, 'oldIndependentReadbackAccepted': True,
                           'freshEffectiveBefore': 'on', 'freshEffectiveAfter': effective, 'querySha256': digest(release.encode()),
                           'faultQuerySha256': digest(injected.encode()), 'exactFaultRemoval': True, 'syntheticOnly': True}
                (evidence / 'legacy-red.json').write_text(json.dumps(outcome, indent=2))
                assert effective == 'on', 'Actual old F65 envelope committed per-database role default drift and independent readback accepted it'
            else:
                adapter = adapter_for(root, head, pins)
                helper = adapter.helper
                def state(database):
                    frame = json.loads(success(database, "begin read only; set local search_path=''; select " + adapter.state_expression(source) + '; rollback;'))
                    assert all(value not in json.dumps(frame) for value in ('f65_synthetic_private_value', 'setconfig', 'rolpassword', 'rolconfig'))
                    return frame
                def record(label, value):
                    cases.append(dict(value, case=label))
                    (evidence / (label + '.json')).write_text(json.dumps(cases[-1], sort_keys=True, indent=2))
                    print('PASS: ' + label)
                def proof(database, before, release):
                    original = old.transaction(source, {key: value for key, value in before.items() if not key.startswith('dbRoleSetting')})
                    restored = release
                    for block in adapter.guard_blocks(before):
                        assert restored.count(block) == 1
                        restored = restored.replace(block, '', 1)
                    assert restored.encode() == original.encode()
                    return {'originalQuerySha256': digest(original.encode()), 'outerQuerySha256': digest(release.encode()), 'exactOriginalRestoration': True}
                def atomic(label, change, boundary='final', deferred=False):
                    database = clone(label)
                    if boundary == 'ledger':
                        hook = 'create function supabase_migrations.f65_settings_hook() returns trigger language plpgsql as $$ begin if new.version=' + helper.literal(helper.VERSION) + ' then ' + change(database) + '; end if; return new; end $$;\n'
                        hook += ('create constraint trigger f65_settings_hook after insert on supabase_migrations.schema_migrations deferrable initially deferred ' if deferred else 'create trigger f65_settings_hook after insert on supabase_migrations.schema_migrations ')
                        hook += 'for each row execute function supabase_migrations.f65_settings_hook();'
                        success(database, hook)
                    before = state(database)
                    helper.validate_before(before, source)
                    release = adapter.transaction(source, before)
                    binding = proof(database, before, release)
                    if boundary == 'ledger':
                        anchor = '\ninsert into supabase_migrations.schema_migrations(version,name,statements)'
                        assert release.count(anchor) == 1
                        fault = '\nset constraints supabase_migrations.f65_settings_hook deferred;' if deferred else ''
                    elif boundary == 'before':
                        anchor = '\ncreate temporary table reporting_splice_guard_settings_before'
                        assert release.count(anchor) == 1
                        fault = '\n' + change(database) + ';'
                    else:
                        anchor = '\ndo $reporting_splice_guard_settings_final$'
                        assert release.count(anchor) == 1
                        fault = '\n' + change(database) + ';'
                    injected = release.replace(anchor, fault + anchor, 1)
                    assert not fault or injected.replace(fault, '', 1) == release
                    result = native(database, injected)
                    after = state(database)
                    assert result.returncode != 0 and 'Reporting splice database-role settings' in result.stderr, result.stderr
                    assert after == before, 'Complete old schema/ledger/security/data/receipt plus native-setting rollback'
                    assert success(database, 'show default_transaction_read_only;', role) == 'on'
                    record(label, dict(binding, boundary=boundary, deferred=deferred, transactionExit=result.returncode,
                        instrumentedQuerySha256=digest(injected.encode()), faultRemovalExact=True, completeRollback=True,
                        before=before, after=after, freshEffectiveReadOnly='on'))
                change = lambda db: 'alter role ' + role + ' in database ' + db + ' set default_transaction_read_only=off'
                if phase == 'all':
                    atomic('before', change, 'before')
                    atomic('final', change)
                    atomic('ledger', change, 'ledger')
                    atomic('deferred', change, 'ledger', True)
                    atomic('database_default', lambda db: "alter database " + db + " set statement_timeout='83s'")
                    atomic('other_database', lambda db: 'alter role ' + role + ' in database ' + predecessor + " set statement_timeout='84s'")
                    atomic('delete_row', lambda db: 'alter role ' + role + ' in database ' + db + ' reset all')
                    database = clone('preexisting')
                    before = state(database)
                    release = adapter.transaction(source, before)
                    success(database, change(database) + ';')
                    drift = state(database)
                    assert {k: v for k, v in drift.items() if not k.startswith('dbRoleSetting')} == {k: v for k, v in before.items() if not k.startswith('dbRoleSetting')}
                    result = native(database, release)
                    assert result.returncode != 0 and 'settings predecessor changed' in result.stderr
                    assert state(database) == drift
                    record('preexisting', {'transactionExit': result.returncode, 'preDDLDenied': True, 'alreadyChangedStateNotAdopted': True})
                    success(database, 'alter role ' + role + ' in database ' + database + ' reset all;')
                database = clone('shape')
                success(database, 'do $$ begin execute format(' + helper.literal('alter role ' + role + ' in database ' + database + ' set f65_guard.private_value=%L') + ", 'f65_synthetic'||'_private_value'); end $$;", fixture_admin)
                before = state(database)
                row_filter = "setdatabase=(select oid from pg_database where datname=" + helper.literal(database) + ") and setrole=(select oid from pg_roles where rolname=" + helper.literal(role) + ')'
                original_hash = before['dbRoleSettingHash']
                success(database, 'alter role ' + role + " set statement_timeout='85s'; alter database " + database + " set statement_timeout='86s'; alter role " + role + ' in database ' + predecessor + " set work_mem='4MB';")
                inventory = json.loads(success(database, "begin read only; select jsonb_build_object('completeCount',(select count(*) from pg_db_role_setting),'globalRows',(select count(*) from pg_db_role_setting where setdatabase=0),'databaseDefaultRows',(select count(*) from pg_db_role_setting where setrole=0),'otherDatabaseRows',(select count(*) from pg_db_role_setting where setdatabase<>0 and setdatabase<>(select oid from pg_database where datname=current_database()))); rollback;"))
                before = state(database)
                assert inventory['completeCount'] == before['dbRoleSettingCount'] and all(inventory[k] > 0 for k in ('globalRows', 'databaseDefaultRows', 'otherDatabaseRows'))
                record('all_rows_private_native_inventory', dict(inventory, noRawValuesExported=True, includesSetroleZero=True, includesSetdatabaseZero=True))
                original_hash = before['dbRoleSettingHash']
                variants = {
                    'array_bounds': "('[0:'||(cardinality(setconfig)-1)||']='||setconfig::text)::text[]",
                    'array_order': '(select array_agg(value order by ordinality desc) from unnest(setconfig) with ordinality x(value,ordinality))',
                    'null_array': 'null',
                    'empty_array': 'array[]::text[]',
                }
                if phase == 'inventory-entry':
                    variants = {}
                for label, expression in variants.items():
                    sql = 'begin; update pg_catalog.pg_db_role_setting set setconfig=' + expression + ' where ' + row_filter + '; select ' + adapter.state_expression(source) + '; rollback;'
                    observed = json.loads(success(database, sql, fixture_admin))
                    assert observed['dbRoleSettingHash'] != original_hash and observed['dbRoleSettingCount'] == before['dbRoleSettingCount']
                    assert state(database) == before
                    record(label, {'nativeDigestChanged': True, 'nativeShapeChanged': observed['dbRoleSettingShapeHash'] != before['dbRoleSettingShapeHash'], 'rawValuesNotExported': True})
                database = clone('entry')
                before = state(database)
                snapshot_path, attestation, dispatch = [evidence / name for name in ('entry-snapshot.json', 'entry-attestation.json', 'entry-dispatch.json')]
                helper.retain(snapshot_path, before)
                captured = helper.load_json(snapshot_path.read_bytes())
                expected = adapter.transaction(source, captured)
                (evidence / 'entry-expected.sql').write_bytes(expected.encode())
                binding = proof(database, captured, expected)
                module = load(root / ADAPTER, 'f65_native_public')
                args = ['apply', '--source-sha', pins[CORE], '--snapshot', str(snapshot_path), '--snapshot-sha', digest(snapshot_path.read_bytes()),
                        '--head', head, '--helper-sha', pins[HELPER], '--adapter-sha', pins[ADAPTER], '--transport-sha', pins[TRANSPORT],
                        '--attestation', str(attestation), '--dispatch', str(dispatch)]
                writes, reads = [], []
                def inert_urlopen(request, timeout):
                    assert request.full_url in ('https://api.supabase.com/v1/projects/' + helper.PROJECT, 'https://api.supabase.com/v1/projects/' + helper.PROJECT + '/database/query')
                    if request.data is None:
                        value = {'id': helper.PROJECT, 'organization_id': helper.ORGANISATION}
                    else:
                        sql = json.loads(request.data)['query']
                        if sql.startswith('begin read only;'):
                            reads.append(digest(sql.encode()))
                            value = [{'state': json.loads(success(database, sql))}]
                        else:
                            assert sql.encode() == expected.encode()
                            assert helper.load_json(dispatch.read_bytes())['transactionSha256'] == digest(expected.encode())
                            writes.append(digest(sql.encode()))
                            value = [{'reportingSpliceResultingCatalogSha256': success(database, sql)}]
                    return contextlib.closing(io.BytesIO(json.dumps(value).encode()))
                stdout = io.StringIO()
                pending = None
                try:
                    with patch.dict(os.environ, {'SUPABASE_ACCESS_TOKEN': 'synthetic-inert-transport-only'}), patch('urllib.request.urlopen', side_effect=inert_urlopen), contextlib.redirect_stdout(stdout):
                        module.main(args)
                        module.main(args + ['--attestation-sha', digest(attestation.read_bytes())])
                except BaseException as error:
                    pending = type(error).__name__
                    raise
                finally:
                    (evidence / 'entry-stdout.log').write_text(stdout.getvalue())
                    (evidence / 'entry-boundary.json').write_text(json.dumps({'enteredWrites': writes, 'readQuerySha256s': reads, 'error': pending,
                         'sourcePins': {str(p): value for p, value in pins.items()}, 'syntheticGitHead': head, 'finalOwnedSourceCommittedClaimed': False}, indent=2))
                assert len(writes) == 1 and len(reads) == 3
                after = state(database)
                catalog = helper.load_json(attestation.read_bytes())['resultingCatalogSha256']
                adapter.verify_after(after, captured, source, catalog)
                assert success(database, 'show default_transaction_read_only;', role) == 'on'
                record('entrypoint_commit_and_readonly_second_apply', dict(binding, writeCount=1, readCount=3, nativeCommit=True, exactReadback=True,
                    oldSixRuntimePins={sig: spec['after'] for sig, spec in helper.function_spec(source).items()}, before=captured, after=after,
                    syntheticNativeOnly=True, authenticHostedInputs=False, finalOwnedCleanCommittedSource=False))
                success(database, change(database) + ';')
                drift = state(database)
                old.verify_after({k: v for k, v in drift.items() if not k.startswith('dbRoleSetting')}, {k: v for k, v in captured.items() if not k.startswith('dbRoleSetting')}, source, catalog)
                assert {k: v for k, v in drift.items() if not k.startswith('dbRoleSetting')} == {k: v for k, v in after.items() if not k.startswith('dbRoleSetting')}
                try:
                    with patch.dict(os.environ, {'SUPABASE_ACCESS_TOKEN': 'synthetic-inert-transport-only'}), patch('urllib.request.urlopen', side_effect=inert_urlopen), contextlib.redirect_stdout(io.StringIO()):
                        module.main(args + ['--attestation-sha', digest(attestation.read_bytes())])
                except SystemExit as error:
                    assert 'database-role settings' in str(error)
                else:
                    raise AssertionError('Actual fresh independent reconciliation accepted postcommit settings drift')
                assert len(writes) == 1 and success(database, 'show default_transaction_read_only;', role) == 'off'
                record('postcommit_detection', {'freshReadbackRejected': True, 'oldReadbackAccepted': True, 'rollbackClaimed': False, 'writeCountStill': 1,
                    'freshEffectiveReadOnly': 'off', 'targetStillExact': drift['targetExact'], 'historicalLedgerUnchanged': drift['ledger'] == after['ledger']})
                (evidence / 'summary.json').write_text(json.dumps({'cases': cases, 'caseCount': len(cases), 'syntheticOnly': True,
                    'liveProviderNotCalled': True, 'finalCommittedCandidate': 'BLOCKED_PARENT_ONLY', 'nativeMajor': before['major'],
                    'bindings': {str(p): digest((ROOT / p).read_bytes()) for p in (ADAPTER, HELPER, TRANSPORT, CORE)}, 'runnerSha256': digest(Path(__file__).read_bytes())}, sort_keys=True, indent=2))
    finally:
        for database in reversed(databases):
            command('dropdb', [database])
        success(predecessor, 'drop role ' + role + ';')
        (evidence / 'cleanup.json').write_text(json.dumps({'ownedDatabasesDropped': databases, 'ownedRoleDropped': role, 'originalArchivedInputsNeverOpenedForWrites': True}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('socket')
    parser.add_argument('predecessor')
    parser.add_argument('prefix')
    parser.add_argument('evidence')
    parser.add_argument('--legacy-red', action='store_true')
    parser.add_argument('--phase', choices=('all', 'shape-entry', 'inventory-entry'), default='all')
    parser.add_argument('--fixture-admin', choices=('postgres', 'fixture_bootstrap'), default='postgres')
    args = parser.parse_args()
    run(args.socket, args.predecessor, args.prefix, args.evidence, args.legacy_red, args.phase, args.fixture_admin)
