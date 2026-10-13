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
HELPER_PATH = ROOT / 'scripts/deploy-employee-removal-reporting-splice.py'
SPEC = importlib.util.spec_from_file_location('reporting_release', HELPER_PATH)
assert SPEC is not None and SPEC.loader is not None
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


def run(socket, predecessor, prefix, head=None, evidence_dir=None):
    marker = json.loads((Path(socket) / 'mam-test-cluster.json').read_bytes())
    assert marker == {'owner': 'mam-local-tests-v1', 'socket': str(Path(socket).resolve()), 'port': 55439}
    assert Path(socket).resolve().parent == Path(tempfile.gettempdir()).resolve()
    assert all(re.fullmatch(r'mam_test_[a-z0-9_]+', value) for value in [predecessor, prefix])
    assert len(prefix) < 42
    env = {'PATH': os.environ['PATH'], 'TMPDIR': str(Path(socket).resolve().parent)}
    env.update(LANG='C', LC_ALL='C', PGPASSFILE='/dev/null', PGSERVICEFILE='/dev/null', PGCONNECT_TIMEOUT='5', PGPASSWORD='synthetic-local-unused', PYTHONDONTWRITEBYTECODE='1')
    source = helper.candidate(helper.sha(helper.MIGRATION.read_bytes()))
    source_sha = helper.sha(helper.MIGRATION.read_bytes())
    helper_sha = helper.sha(HELPER_PATH.read_bytes())
    runner_sha = helper.sha(Path(__file__).read_bytes())
    evidence = Path(tempfile.mkdtemp(prefix='reporting-release-native-', dir=evidence_dir or socket))
    (evidence / 'source.sql').write_bytes(helper.MIGRATION.read_bytes())
    (evidence / 'helper.py').write_bytes(HELPER_PATH.read_bytes())
    (evidence / 'runner.py').write_bytes(Path(__file__).read_bytes())
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
        assert 'Reporting splice' in result.stderr, result.stderr
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
        native(positive, "insert into supabase_migrations.schema_migrations(version,name,statements) values('20260908000020','20260907230409_archive_combined_employment_account_disable',null),('20260801000001','synthetic_empty_history',ARRAY[]::text[]),('20260801000002','synthetic_split_history',ARRAY['select 1;','select 2;']::text[]);")
        fixture = (ROOT / 'tests/reporting-splice-fixture.sql').read_text().replace('\\ir sql-test-auth.sql', '\\ir ' + str(ROOT / 'tests/sql-test-auth.sql'))
        native(positive, 'begin;\n' + fixture + '\ncommit;')
        native(positive, "insert into auth.users(id,email,banned_until) values('97abcdef-0000-4000-8000-000000000001','compat-admin@example.test',null),('97abcdef-0000-4000-8000-000000000002','compat-pending@example.test',clock_timestamp()+interval '1 day'); insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after) values('97abcdef-0000-4000-8000-000000000001','Compatibility Admin Synthetic','system_admin','compat-admin@example.test',clock_timestamp()-interval '1 day'); insert into public.internal_org_people(id,full_name,company_key,position_title,is_active) values('97abcdef-0000-4000-8000-000000000003','Compatibility Test Synthetic','mam','Synthetic',false); insert into private.confirmed_test_identity_purges(id,person_id,auth_user_id,actor_user_id,company_key,manifest_hash,manifest,retained_audit,retired_identifiers,phase,completed_at) values('97abcdef-0000-4000-8001-000000000002','97abcdef-0000-4000-8000-000000000002','97abcdef-0000-4000-8000-000000000002','97abcdef-0000-4000-8000-000000000001','mam',repeat('a',64),'{}','{}',array['97abcdef-0000-4000-8000-000000000002']::uuid[],'business_purged',null),('97abcdef-0000-4000-8001-000000000099','97abcdef-0000-4000-8000-000000000099',null,'97abcdef-0000-4000-8000-000000000001','mam',repeat('b',64),'{}','{}',array['97abcdef-0000-4000-8000-000000000099']::uuid[],'complete',clock_timestamp());")
        def compatibility(database):
            sql = (ROOT / 'tests/payroll-purge-compatibility.sql').read_text().replace('\\ir sql-test-auth.sql', '\\ir ' + str(ROOT / 'tests/sql-test-auth.sql'))
            native(database, sql)
        compatibility(positive)

        before = state(positive)
        helper.validate_before(before, source)
        transaction = helper.transaction(source, before)
        catalog = native(positive, transaction)
        assert re.fullmatch('[a-f0-9]{64}', catalog), catalog
        after = state(positive)
        helper.verify_after(after, before, source, catalog)
        print('PASS: exact generated release transaction and independent native readback')
        compatibility(positive)
        print('PASS: unchanged destructive preview, pending Auth-delete claim/completion and completed receipt retention before/after transition')

        faults = [
            ('public_acl', 'grant execute on function public.preflight_employee_removal_reporting_splice(uuid,bigint,bigint,date,text) to anon'),
            ('private_acl', 'grant execute on function private.apply_employee_removal_reporting_splice(uuid,uuid) to service_role'),
            ('column_acl', 'grant update(full_name) on public.internal_org_people to anon'),
            ('schema_acl', 'grant create on schema storage to anon'),
            ('auth_schema_acl', 'grant create on schema auth to authenticated'),
            ('role_attribute', 'alter role authenticated createdb'),
            ('other_defaults', 'alter default privileges for role authenticated in schema storage grant select on tables to anon'),
            ('unknown_function', "create function public.reporting_unapproved() returns integer language sql as 'select 1'"),
            ('domain', 'create domain pg_catalog.reporting_unapproved as integer check(value>0)'),
            ('rewrite', 'create rule reporting_unapproved as on update to public.teams do instead nothing'),
            ('index', 'create index reporting_unapproved on public.internal_org_people(full_name) where is_active'),
            ('trigger', 'alter table public.internal_org_people enable always trigger internal_org_people_set_updated_at'),
            ('trade_enabled', 'update private.employee_directory_details set trade_school_enabled=not trade_school_enabled where person_id=\'a7100000-0000-4000-8000-000000000020\''),
            ('receipt', "update private.confirmed_test_identity_purges set retained_audit='{\"synthetic_fault\":true}' where phase='complete'"),
            ('historical_null', "update supabase_migrations.schema_migrations set statements=ARRAY[]::text[] where version='20260908000020'"),
            ('historical_bound', "update supabase_migrations.schema_migrations set statements='[0:1]={\"select 1;\",\"select 2;\"}'::text[] where version='20260801000002'"),
            ('target_bound', "update supabase_migrations.schema_migrations set statements=array_fill(statements[1],array[1],array[0]) where version='20261012170000'"),
        ]
        for index, (label, fault) in enumerate(faults):
            database = prefix + '_f' + str(index)
            command('createdb', ['-h', socket, '-p', '55439', '-U', 'postgres', '--template=' + predecessor, database])
            databases.append(database)
            native(database, 'insert into supabase_migrations.schema_migrations(version,name,statements) values(' + helper.literal(helper.PREDECESSOR_VERSION) + ',' + helper.literal(helper.PREDECESSOR_NAME) + ',ARRAY[' + helper.literal(helper.PREDECESSOR.read_text()) + ']);')
            native(database, "insert into supabase_migrations.schema_migrations(version,name,statements) values('20260908000020','20260907230409_archive_combined_employment_account_disable',null),('20260801000002','synthetic_split_history',ARRAY['select 1;','select 2;']);")
            native(database, 'begin;\n' + fixture + '\ncommit;')
            native(database, "insert into private.confirmed_test_identity_purges(person_id,actor_user_id,company_key,manifest_hash,manifest,retained_audit,retired_identifiers,phase,completed_at) values('a7100000-0000-4000-8000-000000000099','a7100000-0000-4000-8000-000000000001','mam',repeat('b',64),'{}','{}',array['a7100000-0000-4000-8000-000000000099']::uuid[],'complete',now());")
            baseline = state(database)
            sql = helper.transaction(source, baseline)
            anchor = '\nset constraints all immediate;\nselect pg_temp.reporting_splice_assert_delta();\ndo $reporting_splice_release_final$'
            assert sql.count(anchor) == 1
            sql = sql.replace(anchor, '\n' + fault + ';' + anchor, 1)
            native(database, sql, expected_success=False)
            assert state(database) == baseline, 'Late fault must restore complete schema/security/raw ledger/receipts/data: ' + label
            print('PASS: final envelope fault atomic rollback: ' + label)

        for suffix, deferred in [('late', False), ('deferred', True)]:
            database = clone(suffix)
            function = 'reporting_splice_fault_' + suffix
            trigger = 'reporting_splice_fault_' + suffix
            hook = "create function supabase_migrations." + function + "() returns trigger language plpgsql as $$ begin if new.version=" + helper.literal(helper.VERSION) + " then grant create on schema auth to anon; end if; return new; end $$;\n"
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
            print('PASS: ' + suffix + ' actual ledger privilege fault rolls back the complete release')

        for phase, anchor in [('before_transition', 'do $reporting_splice_transition$'), ('after_transition', 'do $reporting_splice_final$')]:
            database = clone(phase)
            baseline = state(database)
            sql = helper.transaction(source, baseline)
            body = helper.transaction_body(source)
            assert sql.count(body) == 1
            offset = sql.index(body) + body.index('\n' + anchor)
            sql = sql[:offset] + "\ncreate domain pg_catalog.reporting_unknown as integer check(value>0);" + sql[offset:]
            native(database, sql, expected_success=False)
            assert state(database) == baseline, 'Core transition fault must not become a new fingerprint'
            print('PASS: core ' + phase + ' complete-metadata rollback')

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
                return [{'reportingSpliceResultingCatalogSha256': native(database, sql)}]

            with patch.object(helper, 'api', return_value={'id': helper.PROJECT, 'organization_id': helper.ORGANISATION}), patch.object(helper, 'query', side_effect=fixture_query), contextlib.redirect_stdout(io.StringIO()):
                helper.main(args)
                assert writes == 1
                helper.main(args + ['--attestation-sha', helper.sha(attestation.read_bytes())])
                assert writes == 1, 'Idempotent entrypoint must not dispatch a second write'
            print('PASS: actual clean committed apply entrypoint, native provider-transport fixture and read-only replay')
        assert helper.sha(helper.MIGRATION.read_bytes()) == source_sha
        assert helper.sha(HELPER_PATH.read_bytes()) == helper_sha
        assert helper.sha(Path(__file__).read_bytes()) == runner_sha
        print(json.dumps({'sourceSha256': source_sha, 'helperSha256': helper_sha, 'runnerSha256': runner_sha, 'evidence': str(evidence), 'syntheticOnly': True, 'liveProviderNotCalled': True, 'cleanCommittedApply': 'PASS' if head else 'NOT_RUN_PENDING_PARENT_COMMIT', 'atomicFaultCases': len(faults)+4}))
    finally:
        for database in reversed(databases):
            command('dropdb', ['-h', socket, '-p', '55439', '-U', 'postgres', database])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('socket')
    parser.add_argument('predecessor')
    parser.add_argument('prefix')
    parser.add_argument('--head')
    parser.add_argument('--evidence-dir', type=Path)
    args = parser.parse_args()
    run(args.socket, args.predecessor, args.prefix, args.head, args.evidence_dir)
