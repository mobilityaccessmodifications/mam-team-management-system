import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('reporting_security_helper', ROOT / 'scripts/deploy-employee-removal-reporting-splice.py')
assert spec and spec.loader
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
socket, predecessor, prefix = sys.argv[1:4]
assert json.loads((Path(socket) / 'mam-test-cluster.json').read_bytes()) == {'owner': 'mam-local-tests-v1', 'socket': str(Path(socket).resolve()), 'port': 55439}
assert Path(socket).resolve().parent == Path(tempfile.gettempdir()).resolve()
assert all(re.fullmatch('mam_test_[a-z0-9_]+', name) for name in [predecessor, prefix])
env = {'PATH': os.environ['PATH'], 'TMPDIR': str(Path(socket).resolve().parent), 'LANG': 'C', 'LC_ALL': 'C', 'PGPASSFILE': '/dev/null', 'PGSERVICEFILE': '/dev/null', 'PGPASSWORD': 'synthetic-local-unused', 'PYTHONDONTWRITEBYTECODE': '1'}
evidence = Path(tempfile.mkdtemp(prefix='reporting-security-', dir=sys.argv[4] if len(sys.argv)>4 else socket))
source_sha = helper.sha(helper.MIGRATION.read_bytes())
source = helper.candidate(source_sha)
sequence = 0


def native(database, query):
    global sequence
    sequence += 1
    file = evidence / ('query-%03d.sql' % sequence)
    file.write_text(query)
    result = subprocess.run(['psql', '-X', '-h', socket, '-p', '55439', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-Atq', '-f', str(file)], env=env, text=True, capture_output=True, timeout=90)
    (evidence / ('query-%03d.log' % sequence)).write_text(result.stdout+result.stderr)
    (evidence / ('query-%03d.json' % sequence)).write_text(json.dumps({'database': database, 'querySha256': helper.sha(query.encode()), 'exitCode': result.returncode, 'stdoutSha256': helper.sha(result.stdout.encode()), 'stderrSha256': helper.sha(result.stderr.encode())}, sort_keys=True))
    return result


for index, (name, change) in enumerate([
    ('external_column_acl', 'grant select(value) on reporting_splice_probe.sensitive to anon'),
    ('external_table_acl', 'grant update on reporting_splice_probe.sensitive to authenticated'),
]):
    database = prefix + str(index)
    created = subprocess.run(['createdb', '-h', socket, '-p', '55439', '-U', 'postgres', '--template='+predecessor, database], env=env, text=True, capture_output=True)
    assert created.returncode == 0, created.stderr
    try:
        setup = "create schema reporting_splice_probe; grant usage on schema reporting_splice_probe to anon,authenticated; create table reporting_splice_probe.sensitive(value text); insert into supabase_migrations.schema_migrations(version,name,statements) values(" + ','.join([helper.literal(helper.PREDECESSOR_VERSION), helper.literal(helper.PREDECESSOR_NAME), 'ARRAY['+helper.literal(helper.PREDECESSOR.read_text())+']']) + ');'
        assert native(database, setup).returncode == 0
        observe = "begin read only; select " + helper.state_expression(source) + '; rollback;'
        before = json.loads(native(database, observe).stdout)
        transaction = helper.transaction(source, before)
        anchor = '\nset constraints all immediate;\nselect pg_temp.reporting_splice_assert_delta();\ndo $reporting_splice_release_final$'
        assert transaction.count(anchor) == 1
        transaction = transaction.replace(anchor, '\n'+change+';'+anchor, 1)
        result = native(database, transaction)
        assert result.returncode != 0, 'Expected complete security snapshot to reject ' + name
        assert 'Reporting splice' in result.stderr
        assert json.loads(native(database, observe).stdout) == before, 'Complete schema/raw ledger/security rollback'
        print('PASS: complete all-schema security rejects '+name)
    finally:
        dropped = subprocess.run(['dropdb', '-h', socket, '-p', '55439', '-U', 'postgres', database], env=env, text=True, capture_output=True)
        assert dropped.returncode == 0, dropped.stderr


def policy_snapshot(database):
    signatures = ','.join(helper.literal(signature) for signature in sorted(helper.SIGNATURES))
    security = helper.source_function(source, 'reporting_splice_security')
    query = "begin read only; set local search_path=''; with reporting_splice_function_spec(signature) as (select unnest(array[" + signatures + "]::text[])) select jsonb_build_object('state'," + helper.state_expression(source) + ",'security',(" + security + "),'rawLedger',(select jsonb_agg(jsonb_build_object('version',version,'name',name,'dimensions',array_dims(statements),'statements',statements) order by version) from supabase_migrations.schema_migrations),'purgeBaseline',(select jsonb_agg(to_jsonb(t)) from private.confirmed_test_purge_schema t),'receipts',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from private.confirmed_test_identity_purges t),'policies',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_'),'sensitiveRows',(select jsonb_agg(to_jsonb(t) order by value) from reporting_splice_probe.sensitive t),'otherRows',(select jsonb_agg(to_jsonb(t) order by value) from reporting_splice_other.sensitive t)); rollback;"
    result = native(database, query)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def snapshot_evidence(snapshot):
    return {'state': snapshot['state'], 'snapshotSha256': helper.sha(json.dumps(snapshot, sort_keys=True, separators=(',', ':')).encode()), 'rawQueryLog': 'query-%03d.log' % sequence}


def anonymous_rows(database):
    result = native(database, 'begin read only; set local role anon; select count(*) from reporting_splice_probe.sensitive; rollback;')
    assert result.returncode == 0, result.stderr
    return int(result.stdout)


def drop(database):
    dropped = subprocess.run(['dropdb', '-h', socket, '-p', '55439', '-U', 'postgres', database], env=env, text=True, capture_output=True)
    assert dropped.returncode == 0, dropped.stderr


def policy_clone(suffix, template=None):
    database = prefix + '_' + suffix
    assert len(database) <= 63
    created = subprocess.run(['createdb', '-h', socket, '-p', '55439', '-U', 'postgres', '--template='+(template or predecessor), database], env=env, text=True, capture_output=True)
    assert created.returncode == 0, created.stderr
    if template is None:
        setup = "create schema reporting_splice_probe; grant usage on schema reporting_splice_probe to anon,authenticated; create table reporting_splice_probe.sensitive(value integer); insert into reporting_splice_probe.sensitive values(1); grant select on reporting_splice_probe.sensitive to anon; alter table reporting_splice_probe.sensitive enable row level security; alter table reporting_splice_probe.sensitive force row level security; create policy scoped_deny on reporting_splice_probe.sensitive for select to anon using(false); create policy scoped_write on reporting_splice_probe.sensitive for all to authenticated using(false) with check(false); create schema reporting_splice_other; grant usage on schema reporting_splice_other to anon; create table reporting_splice_other.sensitive(value integer); insert into reporting_splice_other.sensitive values(1); grant select on reporting_splice_other.sensitive to anon; alter table reporting_splice_other.sensitive enable row level security; alter table reporting_splice_other.sensitive force row level security; create policy other_deny on reporting_splice_other.sensitive for select to anon using(false); insert into supabase_migrations.schema_migrations(version,name,statements) values(" + ','.join([helper.literal(helper.PREDECESSOR_VERSION), helper.literal(helper.PREDECESSOR_NAME), 'ARRAY['+helper.literal(helper.PREDECESSOR.read_text())+']']) + "); insert into supabase_migrations.schema_migrations(version,name,statements) values('20260801000001','synthetic_null_history',null),('20260801000002','synthetic_empty_history',array[]::text[]),('20260801000003','synthetic_zero_bound_history',array_fill('select 1;'::text,array[1],array[0]));"
        result = native(database, setup)
        assert result.returncode == 0, result.stderr
        fixture = (ROOT / 'tests/reporting-splice-fixture.sql').read_text().replace('\\ir sql-test-auth.sql', "\\ir '" + str(ROOT / 'tests/sql-test-auth.sql').replace("'", "''") + "'")
        receipt = "insert into private.confirmed_test_identity_purges(person_id,actor_user_id,company_key,manifest_hash,manifest,retained_audit,retired_identifiers,phase,completed_at) values('a7100000-0000-4000-8000-000000000099','a7100000-0000-4000-8000-000000000001','mam',repeat('b',64),'{\"synthetic\":true}','{\"retained\":true}',array['a7100000-0000-4000-8000-000000000099']::uuid[],'complete',now());"
        result = native(database, 'begin;\n' + fixture + '\n' + receipt + '\ncommit;')
        assert result.returncode == 0, result.stderr
    return database


def policy_control(database, baseline, change, policy, fields, visible, after_name=None, mode=None):
    query = "begin; " + change + "; select jsonb_build_object('state'," + helper.state_expression(source) + ",'policies',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_temp_' and n.nspname !~ '^pg_toast_temp_')); set local role anon; select count(*) from reporting_splice_probe.sensitive; rollback;"
    result = native(database, query)
    assert result.returncode == 0, result.stderr
    lines = result.stdout.strip().splitlines()
    assert len(lines) == 2, result.stdout
    control = json.loads(lines[0])
    assert int(lines[1]) == visible
    assert control['policies'] != baseline['policies']
    assert control['state']['purgeHash'] == baseline['state']['purgeHash'], 'Published collector is not an all-schema policy collector'
    assert control['state']['securityHash'] != baseline['state']['securityHash'], 'Source-derived security must detect this real policy drift'
    original = {row['polname']: row for row in baseline['policies']}
    changed = {row['polname']: row for row in control['policies']}
    if mode == 'create':
        assert policy not in original and policy in changed
    elif mode == 'drop':
        assert policy in original and policy not in changed
    else:
        assert all(original[policy][field] != changed[after_name or policy][field] for field in fields), fields
    outcome = {'rawQueryLog': 'query-%03d.log' % sequence, 'changedFields': fields, 'mode': mode, 'anonRowsUnderFault': visible, 'securityHashChanged': True, 'publishedCollectorHashUnchanged': True}
    assert policy_snapshot(database) == baseline
    assert anonymous_rows(database) == 0
    return outcome


def policy_fault(name, change, policy, fields, visible, after_name=None, mode=None, boundary='outer_final'):
    database = policy_clone(name)
    outcome = {'name': name, 'sourceSha256': source_sha, 'syntheticOnly': True, 'boundary': boundary}
    try:
        baseline = policy_snapshot(database)
        baseline_evidence = snapshot_evidence(baseline)
        before = baseline['state']
        helper.validate_before(before, source)
        assert baseline['receipts'] and before['tradeSchoolEnabledCount'] > 0
        assert baseline['security']['policies'] == baseline['policies']
        assert anonymous_rows(database) == 0
        outcome['faultControl'] = policy_control(database, baseline, change, policy, fields, visible, after_name, mode)
        transaction = helper.transaction(source, before)
        fault = '\n' + change + ';'
        if boundary == 'core_final':
            body = helper.transaction_body(source)
            anchor = '\nset constraints all immediate;\nselect pg_temp.reporting_splice_assert_delta();\ndo $reporting_splice_final$'
            assert transaction.count(body) == 1 and body.count(anchor) == 1
            offset = transaction.index(body) + body.index(anchor)
            instrumented = transaction[:offset] + fault + transaction[offset:]
        else:
            anchor = '\ndo $reporting_splice_release_final$' if boundary == 'outer_readback' else '\nset constraints all immediate;\nselect pg_temp.reporting_splice_assert_delta();\ndo $reporting_splice_release_final$'
            assert transaction.count(anchor) == 1
            instrumented = transaction.replace(anchor, fault + anchor, 1)
        assert instrumented.replace(fault, '', 1) == transaction
        result = native(database, instrumented)
        transaction_log = 'query-%03d.log' % sequence
        after = policy_snapshot(database)
        after_evidence = snapshot_evidence(after)
        final_visible = anonymous_rows(database)
        outcome.update(transactionSha256=helper.sha(transaction.encode()), instrumentedSha256=helper.sha(instrumented.encode()), transactionLog=transaction_log, singleOwnedFaultOnly=True, transactionExit=result.returncode, transactionStderr=result.stderr, anonRowsBefore=0, anonRowsAfter=final_visible, completeRollback=after == baseline, before=baseline_evidence, after=after_evidence)
        helper.retain(evidence / (name + '.json'), outcome)
        assert result.returncode != 0, 'Expected complete policy snapshot to reject ' + name
        message = '55000: Reporting splice release final state differs' if boundary == 'outer_readback' else '55000: Reporting splice differs from its exact reviewed delta.'
        assert message in result.stderr, result.stderr
        assert after == baseline, 'Complete schema/raw ledger/security/receipt/policy rollback: ' + name
        assert final_visible == 0, 'Actual anonymous visibility must remain denied: ' + name
        print('PASS: actual final guard policy fault atomic rollback: ' + name)
        return outcome
    finally:
        drop(database)


def committed_control(database):
    baseline = policy_snapshot(database)
    before_evidence = snapshot_evidence(baseline)
    assert baseline['security']['policies'] == baseline['policies']
    result = native(database, "begin read only; select jsonb_agg(attname order by attnum) from pg_attribute where attrelid='pg_policy'::regclass and attnum>0 and not attisdropped; rollback;")
    assert result.returncode == 0, result.stderr
    columns = json.loads(result.stdout)
    assert all(set(row) == set(columns) for row in baseline['security']['policies'])
    assert anonymous_rows(database) == 0
    transaction = helper.transaction(source, baseline['state'])
    result = native(database, transaction)
    assert result.returncode == 0, result.stderr
    catalog = result.stdout.strip()
    assert re.fullmatch('[a-f0-9]{64}', catalog), catalog
    after = policy_snapshot(database)
    after_evidence = snapshot_evidence(after)
    helper.verify_after(after['state'], baseline['state'], source, catalog)
    assert after['security'] == baseline['security'] and after['policies'] == baseline['policies']
    assert after['receipts'] == baseline['receipts'] and after['sensitiveRows'] == baseline['sensitiveRows'] and after['otherRows'] == baseline['otherRows']
    assert anonymous_rows(database) == 0
    helper.retain(evidence / 'policy_no_fault.json', {'committed': True, 'independentReadbackAccepted': True, 'catalogSha256': catalog, 'transactionSha256': helper.sha(transaction.encode()), 'completePolicyColumns': columns, 'before': before_evidence, 'after': after_evidence, 'anonRowsBefore': 0, 'anonRowsAfter': 0, 'runtimeDefinitionPins': {signature: spec['after'] for signature, spec in helper.function_spec(source).items()}})
    print('PASS: no-fault actual COMMIT and independent readback retain complete pg_policy rows and anonymous denial')
    return baseline, after, catalog, columns


def postcommit_fault(committed, predecessor_snapshot, committed_snapshot, catalog, variant):
    name, change, policy, fields, visible, after_name, mode = variant
    database = policy_clone('post_' + name, committed)
    try:
        baseline = policy_snapshot(database)
        before_evidence = snapshot_evidence(baseline)
        assert baseline == committed_snapshot
        helper.verify_after(baseline['state'], predecessor_snapshot['state'], source, catalog)
        result = native(database, change + ';')
        assert result.returncode == 0, result.stderr
        after = policy_snapshot(database)
        after_evidence = snapshot_evidence(after)
        assert after['policies'] != baseline['policies'] and after['security']['policies'] == after['policies']
        assert after['state']['securityHash'] != baseline['state']['securityHash']
        for field in ['major', 'dataHash', 'receiptHash', 'purgeHash', 'purgeMatches', 'predecessorExact', 'targetExact', 'ledger', 'functions', 'tradeSchoolEnabledCount', 'targetSourceArraySha256']:
            assert after['state'][field] == baseline['state'][field], field
        assert after['rawLedger'] == baseline['rawLedger'] and after['receipts'] == baseline['receipts'] and after['purgeBaseline'] == baseline['purgeBaseline']
        try:
            helper.verify_after(after['state'], predecessor_snapshot['state'], source, catalog)
        except SystemExit as error:
            assert str(error) == 'Protected readback differs: securityHash', str(error)
            rejection = str(error)
        else:
            raise AssertionError('Actual independent verifier accepted postcommit policy drift: ' + name)
        assert anonymous_rows(database) == visible
        outcome = {'name': name, 'postcommitDetection': True, 'rollbackClaimed': False, 'driftCommitted': True, 'targetStillRecorded': True, 'independentReadbackRejected': rejection, 'anonRowsBefore': 0, 'anonRowsAfter': visible, 'before': before_evidence, 'after': after_evidence}
        helper.retain(evidence / ('post_' + name + '.json'), outcome)
        print('PASS: postcommit policy drift independently detected (not rollback): ' + name)
        return outcome
    finally:
        drop(database)


variants = [
    ('policy_using', 'alter policy scoped_deny on reporting_splice_probe.sensitive using(true)', 'scoped_deny', ['polqual'], 1, None, None),
    ('policy_roles', 'alter policy scoped_deny on reporting_splice_probe.sensitive to public', 'scoped_deny', ['polroles'], 0, None, None),
    ('policy_command', 'drop policy scoped_deny on reporting_splice_probe.sensitive; create policy scoped_deny on reporting_splice_probe.sensitive for all to anon using(false)', 'scoped_deny', ['polcmd'], 0, None, None),
    ('policy_permissiveness', 'drop policy scoped_deny on reporting_splice_probe.sensitive; create policy scoped_deny on reporting_splice_probe.sensitive as restrictive for select to anon using(false)', 'scoped_deny', ['polpermissive'], 0, None, None),
    ('policy_with_check', 'alter policy scoped_write on reporting_splice_probe.sensitive with check(true)', 'scoped_write', ['polwithcheck'], 0, None, None),
    ('policy_create', 'create policy scoped_allow on reporting_splice_probe.sensitive for select to anon using(true)', 'scoped_allow', [], 1, None, 'create'),
    ('policy_drop', 'drop policy scoped_deny on reporting_splice_probe.sensitive', 'scoped_deny', [], 0, None, 'drop'),
    ('policy_rename', 'alter policy scoped_deny on reporting_splice_probe.sensitive rename to scoped_renamed', 'scoped_deny', ['polname'], 0, 'scoped_renamed', None),
    ('policy_relation', 'drop policy scoped_deny on reporting_splice_probe.sensitive; create policy scoped_deny on reporting_splice_other.sensitive for select to anon using(false)', 'scoped_deny', ['polrelid'], 0, None, None),
    ('policy_oid', 'drop policy scoped_deny on reporting_splice_probe.sensitive; create policy scoped_deny on reporting_splice_probe.sensitive for select to anon using(false)', 'scoped_deny', ['oid'], 0, None, None),
]
committed = policy_clone('policy_ok')
try:
    baseline, after, catalog, columns = committed_control(committed)
    atomic = [policy_fault(*variant) for variant in variants]
    for boundary in ['core_final', 'outer_readback']:
        name, *args = variants[0]
        atomic.append(policy_fault(name + '_' + boundary, *args, boundary=boundary))
    postcommit = [postcommit_fault(committed, baseline, after, catalog, variant) for variant in variants]
    summary = {'sourceSha256': source_sha, 'helperSha256': helper.sha((ROOT / 'scripts/deploy-employee-removal-reporting-splice.py').read_bytes()), 'runnerSha256': helper.sha(Path(__file__).read_bytes()), 'evidence': str(evidence), 'syntheticOnly': True, 'liveProviderNotCalled': True, 'oldExternalAclCases': 2, 'newAtomicPolicyCases': len(atomic), 'postcommitDetectionCases': len(postcommit), 'noFaultCommitReadbackCases': 1, 'completePolicyColumns': columns, 'atomicCases': [case['name'] for case in atomic], 'postcommitCases': [case['name'] for case in postcommit], 'cases': 2 + len(atomic)}
    helper.retain(evidence / 'summary.json', summary)
    assert helper.sha(helper.MIGRATION.read_bytes()) == source_sha
    print(json.dumps(summary))
finally:
    drop(committed)
