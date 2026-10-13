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
evidence = Path(sys.argv[3]) if len(sys.argv) == 4 else None
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


with tempfile.TemporaryDirectory(prefix='notes-helper-', dir=socket) as copy:
    root = Path(copy)
    paths = ['scripts/deploy-task-notes.py', 'scripts/deploy-staff-leave-calendar.py',
             'supabase/migrations/20261013213724_task_follow_up_notes.sql', 'supabase/migrations/20261013200000_day_one_reporting_splice_claims.sql']
    for name in paths:
        target = root/name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT/name, target)
        assert target.read_bytes() == (ROOT/name).read_bytes()
    command(['git', '-C', copy, 'init', '--quiet'])
    command(['git', '-C', copy, 'config', 'user.name', 'mobilityaccessmodifications'])
    command(['git', '-C', copy, 'config', 'user.email', '310802599+mobilityaccessmodifications@users.noreply.github.com'])
    command(['git', '-C', copy, 'remote', 'add', 'origin', 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git'])
    command(['git', '-C', copy, 'add', '--', *paths])
    command(['git', '-C', copy, 'commit', '--quiet', '-m', 'Synthetic release fixture'])
    spec = importlib.util.spec_from_file_location('task_notes_native', root/paths[0])
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
    prefix = 'mam_test_notes_release_'+uuid.uuid4().hex[:6]
    database = prefix+'_base'
    clone(database, predecessor)
    sql(database, "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations(version text primary key,name text,statements text[]); alter default privileges for role postgres in schema public grant execute on functions to anon,authenticated,service_role;")
    for migration in sorted((ROOT/'supabase/migrations').glob('*.sql')):
        version, name = migration.stem.split('_', 1)
        if version <= helper.PREDECESSOR_VERSION:
            sql(database, 'insert into supabase_migrations.schema_migrations values('+helper.literal(version)+','+helper.literal(name)+',ARRAY['+helper.literal(migration.read_text())+']) on conflict(version) do nothing;')
    sql(database, 'create schema review_fixture; create table review_fixture.scope(id integer primary key); alter table review_fixture.scope enable row level security; create policy closed on review_fixture.scope to anon using(false);')
    calls = {'writes': 0}
    def query(value):
        if not value.startswith('begin read only;'):
            calls['writes'] += 1
        output = sql(database, value).splitlines()
        value = next(line for line in reversed(output) if line.strip())
        if value.startswith('{'):
            return [{'state': json.loads(value)}]
        return [{'resultingCatalogSha256': value}]
    helper.query = query
    before = helper.read_state(source, predecessor_source, helper.query)
    helper.validate_before(before, source)
    release = helper.transaction(source, before, predecessor_source)
    boundary = '\nset constraints all immediate;\ndo $task_notes_release_final$'
    assert release.count(boundary) == 1
    for index, (label, fault) in enumerate([
        ('new RPC service-role ACL', "grant execute on function public.save_visible_task_notes(text,uuid,date,text,bigint) to service_role;"),
        ('Notes direct table ACL', 'grant select on private.task_follow_up_notes to authenticated;'),
        ('Notes table storage options', 'alter table private.task_follow_up_notes set(fillfactor=80);'),
        ('Notes RLS policy', 'create policy notes_open on private.task_follow_up_notes to authenticated using(true);'),
        ('unrelated column grant', 'grant select(id) on review_fixture.scope to anon;'),
        ('external RLS policy', 'alter policy closed on review_fixture.scope using(true);'),
        ('unrelated catalog function', "create function public.unreviewed_notes_fault() returns boolean language sql as $$select true$$;"),
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
        print('PASS: task Notes release rolls back '+label)
    deferred_database = prefix+'_deferred'
    clone(deferred_database, database)
    sql(deferred_database, "create function review_fixture.late_grant() returns trigger language plpgsql as $$begin execute 'grant execute on function public.save_visible_task_notes(text,uuid,date,text,bigint) to service_role'; return new; end$$; create constraint trigger late_review_acl after insert on supabase_migrations.schema_migrations deferrable initially deferred for each row execute function review_fixture.late_grant();")
    helper.query = lambda value: [{'state': json.loads(sql(deferred_database, value))}]
    original = helper.read_state(source, predecessor_source, helper.query)
    try:
        sql(deferred_database, helper.transaction(source, original, predecessor_source))
        raise AssertionError('Deferred drift committed')
    except RuntimeError as failure:
        assert '55000' in str(failure)
    assert helper.read_state(source, predecessor_source, helper.query) == original
    print('PASS: task Notes release drains deferred ledger effects and rolls back late grants')
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
                    print('PASS: task Notes release rolls back '+label)
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
    previous_modules = {key:value for key,value in sys.modules.items() if key.startswith('task_notes')}
    try:
        os.chdir(copy)
        with patch.object(urllib.request, 'urlopen', side_effect=remote), patch.dict(os.environ, {'SUPABASE_ACCESS_TOKEN':'synthetic'}):
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
        assert all(before[field] == after[field] for field in ('major','securityHash','dataHash','predecessorExact'))
        assert after['ledger'][:-1] == before['ledger']
        if evidence is not None:
            (evidence/'readback.json').write_text(json.dumps({'before':before,'after':after,'exactDispatchSha256':hashlib.sha256(writes[0].encode()).hexdigest(),'writeCount':calls['writes']}, indent=2))
        print('PASS: actual helper inspect is read-only; apply commits one exact migration, ledger and ACL readback; repeated apply is read-only')
        database = prefix+'_custody'
        clone(database, predecessor)
        sql(database, 'create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);')
        for migration in sorted((ROOT/'supabase/migrations').glob('*.sql')):
            version, name = migration.stem.split('_', 1)
            if version <= helper.PREDECESSOR_VERSION:
                sql(database, 'insert into supabase_migrations.schema_migrations values('+helper.literal(version)+','+helper.literal(name)+',ARRAY['+helper.literal(migration.read_text())+']) on conflict(version) do nothing;')
        original = helper.read_state(source, predecessor_source, query)
        for name in (paths[1], paths[2], paths[3]):
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
        assert all(original[field] == reconciled[field] for field in ('major','securityHash','dataHash','predecessorExact'))
        assert reconciled['ledger'][:-1] == original['ledger']
        if evidence is not None:
            (evidence/'postcommit-source-hold.json').write_text(json.dumps({'before':original,'after':reconciled,'writeCount':1,'classification':'POSTCOMMIT_SOURCE_DRIFT_DETECTED_AND_RECONCILED_READ_ONLY'}, indent=2))
        print('PASS: native readback source change retains one committed write and requires read-only reconciliation, not retry')
    finally:
        os.chdir(previous_cwd)
        assert dict(os.environ) == previous_environment
        assert {key:value for key,value in sys.modules.items() if key.startswith('task_notes')} == previous_modules
    print('PASS: actual helper normal/error exits preserve cwd, environment and transport module cache')
