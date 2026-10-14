import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
import urllib.request
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
socket, predecessor = sys.argv[1:3]
predecessor_file = Path(sys.argv[3]) if len(sys.argv) == 4 else ROOT/'supabase/migrations/20261014220111_subscription_request_template_completion.sql'
assert predecessor_file.name == '20261014220111_subscription_request_template_completion.sql'
evidence = None
if evidence is not None:
    evidence.mkdir(parents=True, exist_ok=False)
records = []
marker = json.loads((Path(socket)/'mam-test-cluster.json').read_text())
assert marker == {'owner': 'mam-local-tests-v1', 'socket': str(Path(socket).resolve()), 'port': 55439}
assert Path(socket).parent.resolve() == Path(os.environ['TMPDIR']).resolve()
assert re.fullmatch('mam_test_[a-z0-9_]+', predecessor)
env = {'PATH': os.environ['PATH'], 'LANG': 'C', 'LC_ALL': 'C', 'PGPASSFILE': '/dev/null', 'PGSERVICEFILE': '/dev/null', 'PYTHONDONTWRITEBYTECODE': '1'}


def command(args):
    return subprocess.run(args, env=env, capture_output=True, text=True, check=True).stdout.strip()


def sql(database, query):
    with tempfile.NamedTemporaryFile(mode='w', suffix='.sql', dir=socket) as handle:
        handle.write(query)
        handle.flush()
        result = subprocess.run(['psql', '-X', '-h', socket, '-p', '55439', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-Atq', '-f', handle.name], env=env, capture_output=True, text=True)
    if evidence is not None:
        index = len(records)
        (evidence/(str(index)+'.sql')).write_text(query)
        (evidence/(str(index)+'.stdout')).write_text(result.stdout)
        (evidence/(str(index)+'.stderr')).write_text(result.stderr)
        records.append({'database': database, 'exit': result.returncode, 'sqlSha256': hashlib.sha256(query.encode()).hexdigest()})
        (evidence/'commands.json').write_text(json.dumps(records, indent=2))
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def clone(name, template):
    assert re.fullmatch('mam_test_[a-z0-9_]+', name)
    command(['createdb', '-h', socket, '-p', '55439', '-U', 'postgres', '--template='+template, name])


with tempfile.TemporaryDirectory(prefix='start-date-helper-', dir=socket) as copy:
    root = Path(copy)
    paths = ['scripts/deploy-subscription-request-start-date.py', 'scripts/deploy-staff-leave-calendar.py',
             'supabase/migrations/20261014233948_subscription_request_start_date.sql', 'supabase/migrations/20261014220111_subscription_request_template_completion.sql']
    for name in paths:
        target = root/name
        target.parent.mkdir(parents=True, exist_ok=True)
        original = predecessor_file if name == paths[3] else ROOT/name
        shutil.copyfile(original, target)
        assert target.read_bytes() == original.read_bytes()
    command(['git', '-C', copy, 'init', '--quiet'])
    command(['git', '-C', copy, 'config', 'user.name', 'mobilityaccessmodifications'])
    command(['git', '-C', copy, 'config', 'user.email', '310802599+mobilityaccessmodifications@users.noreply.github.com'])
    command(['git', '-C', copy, 'remote', 'add', 'origin', 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git'])
    command(['git', '-C', copy, 'add', '--', *paths])
    command(['git', '-C', copy, 'commit', '--quiet', '-m', 'Synthetic release fixture'])
    spec = importlib.util.spec_from_file_location('subscription_start_date_native', root/paths[0])
    assert spec and spec.loader
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    raw = helper.MIGRATION.read_bytes()
    source = helper.candidate(hashlib.sha256(raw).hexdigest(), raw)
    predecessor_source = helper.PREDECESSOR.read_bytes().decode('utf-8')
    head = command(['git', '-C', copy, 'rev-parse', 'HEAD'])
    pins = [head, *[hashlib.sha256((root/name).read_bytes()).hexdigest() for name in paths]]
    if evidence is not None:
        (evidence/'source.json').write_text(json.dumps({'head':head, 'pins':dict(zip(paths, pins[1:])), 'fixtureClass':'OWNED_SYNTHETIC_NATIVE'}, indent=2))
    prefix = 'mam_test_start_date_release_'+uuid.uuid4().hex[:6]
    database = prefix+'_base'
    clone(database, predecessor)
    sql(database, "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations(version text primary key,name text,statements text[]); alter default privileges for role postgres in schema public grant execute on functions to anon,authenticated,service_role;")
    for migration in sorted((ROOT/'supabase/migrations').glob('*.sql')):
        version, name = migration.stem.split('_', 1)
        if version <= helper.PREDECESSOR_VERSION:
            sql(database, 'insert into supabase_migrations.schema_migrations values('+helper.literal(version)+','+helper.literal(name)+',ARRAY['+helper.literal(migration.read_text())+']) on conflict(version) do nothing;')
    sql(database, 'insert into supabase_migrations.schema_migrations values('+helper.literal(helper.PREDECESSOR_VERSION)+','+helper.literal(helper.PREDECESSOR_NAME)+',ARRAY['+helper.literal(predecessor_source)+']) on conflict(version) do nothing;')
    sql(database, 'create schema review_fixture; create table review_fixture.scope(id integer primary key); alter table review_fixture.scope enable row level security; create policy closed on review_fixture.scope to anon using(false);')
    fixture = (ROOT/'tests/unified-role-fixture.sql').read_text().replace('\\ir sql-test-auth.sql', (ROOT/'tests/sql-test-auth.sql').read_text())
    sql(database, "begin;\n"+fixture+"\nselect pg_temp.set_test_actor('a1000000-0000-4000-8000-000000000004'); set role authenticated; select public.create_subscription_v4('Synthetic preexisting free','Plan','free',null,null,null,null,null,null,null,'a1000000-0000-4000-8000-000000000004','mam','{}'); reset role; commit;")
    calls = {'writes': 0}
    def query(value):
        if not value.startswith('begin read only;'):
            calls['writes'] += 1
        try:
            output = sql(database, value).splitlines()
        except RuntimeError as failure:
            print(str(failure)[-6000:], file=sys.stderr)
            raise
        value = next(line for line in reversed(output) if line.strip())
        if value.startswith('{'):
            return [{'state': json.loads(value)}]
        return [{'resultingCatalogSha256': value}]
    helper.query = query
    before = helper.read_state(source, predecessor_source, helper.query)
    helper.validate_before(before, source)
    assert before['major'] in helper.SCHEMA_SHA256_BY_MAJOR
    release = helper.transaction(source, before, predecessor_source)
    boundary = '\nset constraints all immediate;\ndo $subscription_start_date_release_final$'
    assert release.count(boundary) == 1
    for index, (label, fault) in enumerate([
        ('new RPC service-role ACL', "grant execute on function public.create_subscription_v5(text,text,text,text,integer,date,integer,boolean,text,date,uuid,text,uuid[],date) to service_role;"),
        ('private setter ACL', 'grant execute on function private.set_subscription_start_date(uuid,date) to authenticated;'),
        ('new column ACL', 'grant select(start_date) on private.subscription_register to authenticated;'),
        ('unexpected date backfill', "update private.subscription_register set start_date=date '2026-10-15';"),
        ('date column options drift', 'alter table private.subscription_register alter column start_date set statistics 10;'),
        ('date default drift', "alter table private.subscription_register alter column start_date set default date '2026-10-15';"),
        ('date constraint removed', 'alter table private.subscription_register drop constraint subscription_start_date_valid;'),
        ('date constraint weakened', 'alter table private.subscription_register drop constraint subscription_start_date_valid; alter table private.subscription_register add constraint subscription_start_date_valid check(true);'),
        ('audit constraint weakened', 'alter table private.subscription_audit_events drop constraint subscription_audit_changed_fields_valid; alter table private.subscription_audit_events add constraint subscription_audit_changed_fields_valid check(true);'),
        ('register RLS disabled', 'alter table private.subscription_register disable row level security;'),
        ('register storage options', 'alter table private.subscription_register set(fillfactor=80);'),
        ('register RLS policy', 'create policy start_date_open on private.subscription_register to authenticated using(true);'),
        ('register approval trigger disabled', 'alter table private.subscription_register disable trigger subscription_request_register_gate;'),
        ('config/data drift', 'update private.subscription_request_config set enabled=not enabled;'),
        ('existing RPC drift', "do $$begin execute replace(pg_get_functiondef('public.list_subscriptions_v2()'::regprocedure),'SECURITY DEFINER','SECURITY INVOKER'); end$$;"),
        ('existing domain constraint', 'alter domain information_schema.yes_or_no drop constraint yes_or_no_check;'),
        ('unrelated column grant', 'grant select(id) on review_fixture.scope to anon;'),
        ('external RLS policy', 'alter policy closed on review_fixture.scope using(true);'),
        ('unrelated catalog function', "create function public.unreviewed_start_date_fault() returns boolean language sql as $$select true$$;"),
    ]):
        fault_database = prefix+'_fault'+str(index)
        clone(fault_database, database)
        helper.query = lambda value, db=fault_database: [{'state': json.loads(sql(db, value))}]
        original = helper.read_state(source, predecessor_source, helper.query)
        try:
            sql(fault_database, release.replace(boundary, '\n'+fault+';'+boundary))
            raise AssertionError('Unreviewed drift committed: '+label)
        except RuntimeError as failure:
            assert '55000' in str(failure), str(failure)[-1000:]
        assert helper.read_state(source, predecessor_source, helper.query) == original, 'Complete rollback failed: '+label
        print('PASS: subscription start date release rolls back '+label)
    deferred_database = prefix+'_deferred'
    clone(deferred_database, database)
    sql(deferred_database, "create function review_fixture.late_grant() returns trigger language plpgsql as $$begin execute 'grant execute on function public.create_subscription_v5(text,text,text,text,integer,date,integer,boolean,text,date,uuid,text,uuid[],date) to service_role'; return new; end$$; create constraint trigger late_review_acl after insert on supabase_migrations.schema_migrations deferrable initially deferred for each row execute function review_fixture.late_grant();")
    helper.query = lambda value: [{'state': json.loads(sql(deferred_database, value))}]
    original = helper.read_state(source, predecessor_source, helper.query)
    try:
        sql(deferred_database, helper.transaction(source, original, predecessor_source))
        raise AssertionError('Deferred drift committed')
    except RuntimeError as failure:
        assert '55000' in str(failure)
    assert helper.read_state(source, predecessor_source, helper.query) == original
    print('PASS: subscription start date release drains deferred ledger effects and rolls back late grants')
    failures = []
    for category, fault in [
        ('role_membership', 'grant service_role to authenticated;'),
        ('role_database_setting', "execute format('alter role authenticated in database %I set search_path=public',current_database());"),
    ]:
        for deferred in (False, True):
            label = category+('_deferred' if deferred else '_direct')
            fault_database = prefix+'_'+label
            clone(fault_database, database)
            trigger = 'create constraint trigger' if deferred else 'create trigger'
            timing = 'deferrable initially deferred' if deferred else ''
            action = "execute 'grant service_role to authenticated';" if category == 'role_membership' else fault
            sql(fault_database, 'create function review_fixture.security_fault() returns trigger language plpgsql as $$begin '+action+" raise notice 'RF01 hook executed: "+label+"'; return new; end$$; "+trigger+' security_fault after insert on supabase_migrations.schema_migrations '+timing+' for each row execute function review_fixture.security_fault();')
            helper.query = lambda value, db=fault_database: [{'state': json.loads(sql(db, value))}]
            original = helper.read_state(source, predecessor_source, helper.query)
            release_fault = helper.transaction(source, original, predecessor_source)
            if deferred:
                insertion = 'insert into supabase_migrations.schema_migrations(version,name,statements)'
                assert release_fault.count(insertion) == 1
                release_fault = release_fault.replace(insertion, 'set constraints supabase_migrations.security_fault deferred;\n'+insertion)
            try:
                try:
                    sql(fault_database, release_fault)
                    failures.append('Unreviewed drift committed: '+label)
                except RuntimeError as failure:
                    assert '55000' in str(failure), str(failure)[-1000:]
                    assert 'RF01 hook executed: '+label in str(failure)
                    assert helper.read_state(source, predecessor_source, helper.query) == original, 'Complete rollback failed: '+label
                    print('PASS: subscription start date release rolls back '+label)
            finally:
                sql(fault_database, 'revoke service_role from authenticated;' if category == 'role_membership' else 'alter role authenticated in database '+fault_database+' reset search_path;')
    assert not failures, '; '.join(failures)
    before = helper.read_state(source, predecessor_source, query)
    helper.validate_before(before, source)
    release = helper.transaction(source, before, predecessor_source)
    submitted = []
    def remote(request, **kwargs):
        if request.full_url == 'https://api.supabase.com/v1/projects/xtwlrjqbusadghavchqm':
            value = {'id':'xtwlrjqbusadghavchqm', 'organization_id':'fwlmbmospuwoaosffvmw'}
        else:
            assert request.full_url == 'https://api.supabase.com/v1/projects/xtwlrjqbusadghavchqm/database/query'
            payload = json.loads(request.data)
            assert set(payload) == {'query'}
            submitted.append(payload['query'])
            value = query(payload['query'])
        return io.BytesIO(json.dumps(value).encode())
    previous_cwd = Path.cwd()
    previous_environment = dict(os.environ)
    previous_modules = {key:value for key,value in sys.modules.items() if key.startswith('subscription_start_date')}
    try:
        os.chdir(copy)
        def wrong_target(request, **kwargs):
            assert request.full_url == 'https://api.supabase.com/v1/projects/xtwlrjqbusadghavchqm'
            return io.BytesIO(json.dumps({'id':'wrong', 'organization_id':'wrong'}).encode())
        with patch.object(urllib.request, 'urlopen', side_effect=wrong_target), patch.dict(os.environ, {'SUPABASE_ACCESS_TOKEN':'synthetic'}):
            try:
                helper.main(['apply', *pins])
                raise AssertionError('Wrong provider target accepted')
            except SystemExit as failure:
                assert 'Wrong MAM organization/project' in str(failure)
        assert calls['writes'] == 0 and not submitted
        with patch.object(urllib.request, 'urlopen', side_effect=remote), patch.dict(os.environ, {'SUPABASE_ACCESS_TOKEN':'synthetic'}):
            for index in range(len(pins)):
                invalid = pins.copy()
                invalid[index] = '0'*len(invalid[index])
                try:
                    helper.main(['apply', *invalid])
                    raise AssertionError('Wrong source/HEAD pin accepted')
                except SystemExit as failure:
                    assert 'differ' in str(failure)
            assert calls['writes'] == 0 and not submitted
            helper.main(['inspect', *pins])
            assert calls['writes'] == 0
            helper.main(['apply', *pins])
            assert calls['writes'] == 1
            helper.main(['apply', *pins])
            assert calls['writes'] == 1
        writes = [value for value in submitted if not value.startswith('begin read only;')]
        assert writes == [release], 'Actual entrypoint dispatched a different query than the frozen builder'
        after = helper.read_state(source, predecessor_source, query)
        helper.validate_target(after, source)
        assert after['dateSchemaHash'] == helper.SCHEMA_SHA256_BY_MAJOR[before['major']]
        try:
            helper.validate_target({**after, 'dateSchemaHash':'0'*64}, source)
            raise AssertionError('Unreviewed date schema accepted')
        except SystemExit as failure:
            assert 'column, constraint or ACL differs' in str(failure)
        assert all(before[field] == after[field] for field in ('major','existingMetadataHash','securityHash','dataHash','predecessorExact'))
        assert after['ledger'][:-1] == before['ledger']
        if evidence is not None:
            (evidence/'readback.json').write_text(json.dumps({'before':before,'after':after,'exactDispatchSha256':hashlib.sha256(writes[0].encode()).hexdigest(),'writeCount':calls['writes']}, indent=2))
        print('PASS: PostgreSQL '+str(after['major'])+' exact optional date schema accepted; unreviewed shape rejected')
        print('PASS: wrong provider/source/HEAD pins stop before dispatch; inspect is read-only; apply commits one exact migration, ledger and ACL readback; repeated apply is read-only')
        sql(database, "update private.subscription_register set start_date=date '2026-10-15' where service_name='Synthetic preexisting free';")
        used = helper.read_state(source, predecessor_source, query)
        assert used['allDatesNull'] is False
        helper.validate_target(used, source)
        calls['writes'] = 0
        with patch.object(urllib.request, 'urlopen', side_effect=remote), patch.dict(os.environ, {'SUPABASE_ACCESS_TOKEN':'synthetic'}):
            helper.main(['inspect', *pins])
        assert calls['writes'] == 0
        print('PASS: recorded target inspection accepts legitimate dates added after migration without writes')

        database = prefix+'_custody'
        clone(database, predecessor)
        sql(database, 'create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);')
        for migration in sorted((ROOT/'supabase/migrations').glob('*.sql')):
            version, name = migration.stem.split('_', 1)
            if version <= helper.PREDECESSOR_VERSION:
                sql(database, 'insert into supabase_migrations.schema_migrations values('+helper.literal(version)+','+helper.literal(name)+',ARRAY['+helper.literal(migration.read_text())+']) on conflict(version) do nothing;')
        sql(database, 'insert into supabase_migrations.schema_migrations values('+helper.literal(helper.PREDECESSOR_VERSION)+','+helper.literal(helper.PREDECESSOR_NAME)+',ARRAY['+helper.literal(predecessor_source)+']) on conflict(version) do nothing;')
        original = helper.read_state(source, predecessor_source, query)
        for name in paths:
            target = root/name
            raw = target.read_bytes()
            calls['writes'] = 0
            def changed_preflight(request, **kwargs):
                response = remote(request, **kwargs)
                if request.full_url.endswith('/database/query'):
                    target.write_bytes(raw+b'\n')
                return response
            try:
                with patch.object(urllib.request,'urlopen',side_effect=changed_preflight), patch.dict(os.environ, {'SUPABASE_ACCESS_TOKEN':'synthetic'}):
                    try:
                        helper.main(['apply', *pins])
                        raise AssertionError('Changed source dispatched')
                    except SystemExit as failure:
                        assert 'Source custody' in str(failure) and 'phase=preflight' in str(failure)
                assert calls['writes'] == 0
            finally:
                target.write_bytes(raw)
            assert helper.read_state(source, predecessor_source, query) == original
            print('PASS: native preflight source change stops before dispatch: '+name)
        calls['writes'] = 0
        reads = []
        raw = helper.TRANSPORT.read_bytes()
        def changed_readback(request, **kwargs):
            response = remote(request, **kwargs)
            if request.full_url.endswith('/database/query') and json.loads(request.data)['query'].startswith('begin read only;'):
                reads.append(True)
                if len(reads) == 2:
                    helper.TRANSPORT.write_bytes(raw+b'\n')
            return response
        try:
            with patch.object(urllib.request,'urlopen',side_effect=changed_readback), patch.dict(os.environ, {'SUPABASE_ACCESS_TOKEN':'synthetic'}):
                try:
                    helper.main(['apply', *pins])
                    raise AssertionError('Changed readback source certified success')
                except SystemExit as failure:
                    assert 'Source custody' in str(failure) and 'phase=readback' in str(failure)
            assert calls['writes'] == 1 and len(reads) == 2
        finally:
            helper.TRANSPORT.write_bytes(raw)
        reconciled = helper.read_state(source, predecessor_source, query)
        helper.validate_target(reconciled, source)
        assert all(original[field] == reconciled[field] for field in ('major','existingMetadataHash','securityHash','dataHash','predecessorExact'))
        assert reconciled['ledger'][:-1] == original['ledger']
        if evidence is not None:
            (evidence/'postcommit-source-hold.json').write_text(json.dumps({'before':original,'after':reconciled,'writeCount':1,'classification':'POSTCOMMIT_SOURCE_DRIFT_DETECTED_AND_RECONCILED_READ_ONLY'}, indent=2))
        print('PASS: native readback source change retains one committed write and requires read-only reconciliation, not retry')
    finally:
        os.chdir(previous_cwd)
        assert dict(os.environ) == previous_environment
        assert {key:value for key,value in sys.modules.items() if key.startswith('subscription_start_date')} == previous_modules
    print('PASS: actual helper normal/error exits preserve cwd, environment and transport module cache')
