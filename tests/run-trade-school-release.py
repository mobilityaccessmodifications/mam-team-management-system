import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HELPER_PATH = ROOT / 'scripts/deploy-trade-school-leave.py'
SPEC = importlib.util.spec_from_file_location('trade_release', HELPER_PATH)
assert SPEC is not None and SPEC.loader is not None
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


def run(socket, predecessor, prefix, head=None):
    marker = json.loads((Path(socket) / 'mam-test-cluster.json').read_bytes())
    assert marker == {'owner': 'mam-local-tests-v1', 'socket': str(Path(socket).resolve()), 'port': 55439}
    assert Path(socket).resolve().parent == Path(tempfile.gettempdir()).resolve()
    assert all(re.fullmatch(r'mam_test_[a-z0-9_]+', value) for value in [predecessor, prefix])
    assert len(prefix) < 45
    env = {'PATH': os.environ['PATH'], 'TMPDIR': str(Path(socket).resolve().parent)}
    env.update(LANG='C', LC_ALL='C', PGPASSFILE='/dev/null', PGSERVICEFILE='/dev/null', PGCONNECT_TIMEOUT='5', PGPASSWORD='synthetic-local-unused', PYTHONDONTWRITEBYTECODE='1')
    source = helper.candidate(helper.sha(helper.MIGRATION.read_bytes()))
    source_sha = helper.sha(helper.MIGRATION.read_bytes())
    evidence = Path(tempfile.mkdtemp(prefix='trade-release-native-', dir=socket))
    databases = []
    sequence = 0

    def command(binary, args, timeout=90):
        result = subprocess.run([binary, *args], env=env, text=True, capture_output=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError(result.stderr)
        return result.stdout

    def native(database, sql, expected_success=True) -> str:
        nonlocal sequence
        sequence += 1
        file = evidence / ('query-%03d.sql' % sequence)
        file.write_text(sql)
        file.chmod(0o600)
        result = subprocess.run(['psql', '-X', '-h', socket, '-p', '55439', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-Atq', '-f', str(file)], env=env, text=True, capture_output=True, timeout=90)
        (evidence / ('query-%03d.log' % sequence)).write_text(result.stdout + result.stderr)
        if expected_success:
            assert result.returncode == 0, result.stderr
            return result.stdout.strip()
        assert result.returncode != 0, 'Injected fault must roll back'
        assert 'Trade-school' in result.stderr, result.stderr
        return result.stderr

    def state(database):
        result = native(database, "begin read only; set local search_path=''; select " + helper.state_expression(source) + '; rollback;')
        return json.loads(result)

    def clone(suffix):
        database = prefix + '_' + suffix
        command('createdb', ['-h', socket, '-p', '55439', '-U', 'postgres', '--template=' + predecessor, database])
        databases.append(database)
        isolation = json.loads(native(database, "select json_build_object('database',current_database(),'socketOnly',inet_server_addr() is null and current_setting('listen_addresses')='');"))
        assert isolation == {'database': database, 'socketOnly': True}
        native(database, 'insert into supabase_migrations.schema_migrations(version,name,statements) values(' + helper.literal(helper.PREDECESSOR_VERSION) + ',' + helper.literal(helper.PREDECESSOR_NAME) + ',ARRAY[' + helper.literal(helper.PREDECESSOR.read_text()) + ']);')
        return database

    try:
        positive = clone('ok')
        before = state(positive)
        helper.validate_before(before, source)
        transaction = helper.transaction(source, before)
        catalog = native(positive, transaction)
        assert re.fullmatch('[a-f0-9]{64}', catalog), catalog
        after = state(positive)
        helper.verify_after(after, before, source, catalog)
        print('PASS: exact generated release transaction and independent native readback')
        native(positive, (ROOT / 'tests/trade-school-leave.sql').read_text().replace('\\ir sql-test-auth.sql', '\\ir ' + str(ROOT / 'tests/sql-test-auth.sql')))
        print('PASS: full-schema trade-school submission, denial, lifecycle, balances and roles')

        for suffix, deferred in [('late', False), ('deferred', True)]:
            database = clone(suffix)
            function = 'trade_school_fault_' + suffix
            trigger = 'trade_school_fault_' + suffix
            hook = "create function supabase_migrations." + function + "() returns trigger language plpgsql as $$ begin if new.version=" + helper.literal(helper.VERSION) + " then grant execute on function public.list_trade_school_leave_entitlements(uuid) to anon; end if; return new; end $$;\n"
            hook += ('create constraint trigger ' if deferred else 'create trigger ') + trigger + ' after insert on supabase_migrations.schema_migrations '
            hook += 'deferrable initially deferred ' if deferred else ''
            hook += 'for each row execute function supabase_migrations.' + function + '();'
            native(database, hook)
            baseline = state(database)
            sql = helper.transaction(source, baseline)
            ledger_anchor = '\ninsert into supabase_migrations.schema_migrations(version,name,statements)'
            assert sql.count(ledger_anchor) == 1
            if deferred:
                sql = sql.replace(ledger_anchor, '\nset constraints supabase_migrations.' + trigger + ' deferred;' + ledger_anchor, 1)
            native(database, sql, expected_success=False)
            assert state(database) == baseline, 'Fault must restore exact catalog, security, ledger, receipts and business data'
            print('PASS: ' + suffix + ' ledger privilege fault rolls back the complete release')

        if head is not None:
            database = clone('entry')
            before = state(database)
            snapshot = evidence / 'entry-snapshot.json'
            helper.retain(snapshot, before)
            attestation = evidence / 'entry-attestation.json'
            dispatch = evidence / 'entry-dispatch.json'
            args = ['apply', '--source-sha', source_sha, '--snapshot', str(snapshot), '--snapshot-sha', helper.sha(snapshot.read_bytes()), '--head', head, '--helper-sha', helper.sha(HELPER_PATH.read_bytes()), '--attestation', str(attestation), '--dispatch', str(dispatch)]
            writes = 0

            def fixture_query(sql):
                nonlocal writes
                if sql.startswith('begin read only;'):
                    return [{'state': json.loads(native(database, sql))}]
                writes += 1
                return [{'tradeSchoolResultingCatalogSha256': native(database, sql)}]

            with patch.object(helper, 'api', return_value={'id': helper.PROJECT, 'organization_id': helper.ORGANISATION}), patch.object(helper, 'query', side_effect=fixture_query), contextlib.redirect_stdout(io.StringIO()):
                helper.main(args)
                assert writes == 1
                helper.main(args + ['--attestation-sha', helper.sha(attestation.read_bytes())])
                assert writes == 1, 'Idempotent entrypoint must not dispatch a second write'
            print('PASS: actual clean committed apply entrypoint, native provider-transport fixture and read-only replay')
        print(json.dumps({'sourceSha256': source_sha, 'helperSha256': helper.sha(HELPER_PATH.read_bytes()), 'evidence': str(evidence), 'syntheticOnly': True, 'liveProviderNotCalled': True}))
    finally:
        for database in reversed(databases):
            command('dropdb', ['-h', socket, '-p', '55439', '-U', 'postgres', database])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('socket')
    parser.add_argument('predecessor')
    parser.add_argument('prefix')
    parser.add_argument('--head')
    args = parser.parse_args()
    run(args.socket, args.predecessor, args.prefix, args.head)
