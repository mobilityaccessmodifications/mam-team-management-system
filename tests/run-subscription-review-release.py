import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
socket, predecessor = sys.argv[1:]
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
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def clone(name, template):
    assert re.fullmatch('mam_test_[a-z0-9_]+', name)
    command(['createdb', '-h', socket, '-p', '55439', '-U', 'postgres', '--template='+template, name])


with tempfile.TemporaryDirectory(prefix='review-helper-', dir=socket) as copy:
    root = Path(copy)
    paths = ['scripts/deploy-subscription-review-tasks.py', 'scripts/deploy-staff-leave-calendar.py',
             'supabase/migrations/20261013120000_subscription_review_tasks.sql', 'supabase/migrations/20261012110000_trade_school_leave.sql']
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
    spec = importlib.util.spec_from_file_location('subscription_review_native', root/paths[0])
    assert spec and spec.loader
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    source = helper.candidate(hashlib.sha256(helper.MIGRATION.read_bytes()).hexdigest())
    prefix = 'mam_test_sr_release_'+uuid.uuid4().hex[:6]
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
    helper.api = lambda path: {'id': helper.SHARED.PROJECT, 'organization_id': helper.SHARED.ORGANISATION}
    before = helper.read_state(source)
    helper.validate_before(before, source)
    release = helper.transaction(source, before)
    boundary = '\nset constraints all immediate;\nselect pg_temp.subscription_review_assert_delta();\ndo $subscription_review_release_final$'
    assert release.count(boundary) == 1
    for index, (label, fault) in enumerate([
        ('new RPC service-role ACL', "grant execute on function public.complete_my_subscription_review_task(uuid,bigint) to service_role;"),
        ('unrelated column grant', 'grant select(id) on review_fixture.scope to anon;'),
        ('external RLS policy', 'alter policy closed on review_fixture.scope using(true);'),
        ('unrelated catalog function', "create function public.unreviewed_subscription_fault() returns boolean language sql as $$select true$$;"),
    ]):
        fault_database = prefix+'_fault'+str(index)
        clone(fault_database, database)
        helper.query = lambda value, db=fault_database: [{'state': json.loads(sql(db, value))}]
        original = helper.read_state(source)
        try:
            sql(fault_database, release.replace(boundary, '\n'+fault+';'+boundary))
            raise AssertionError('Unreviewed drift committed: '+label)
        except RuntimeError as failure:
            assert '55000' in str(failure), str(failure)[-1000:]
        assert helper.read_state(source) == original, 'Complete rollback failed: '+label
        print('PASS: subscription review release rolls back '+label)
    deferred_database = prefix+'_deferred'
    clone(deferred_database, database)
    sql(deferred_database, "create function review_fixture.late_grant() returns trigger language plpgsql as $$begin execute 'grant execute on function public.complete_my_subscription_review_task(uuid,bigint) to service_role'; return new; end$$; create constraint trigger late_review_acl after insert on supabase_migrations.schema_migrations deferrable initially deferred for each row execute function review_fixture.late_grant();")
    helper.query = lambda value: [{'state': json.loads(sql(deferred_database, value))}]
    original = helper.read_state(source)
    try:
        sql(deferred_database, helper.transaction(source, original))
        raise AssertionError('Deferred drift committed')
    except RuntimeError as failure:
        assert '55000' in str(failure)
    assert helper.read_state(source) == original
    print('PASS: subscription review release drains deferred ledger effects and rolls back late grants')
    helper.query = query
    previous_cwd = Path.cwd()
    try:
        os.chdir(copy)
        helper.main(['inspect'])
        assert calls['writes'] == 0
        helper.main(['apply', hashlib.sha256(source.encode()).hexdigest()])
        assert calls['writes'] == 1
        helper.main(['apply', hashlib.sha256(source.encode()).hexdigest()])
        assert calls['writes'] == 1
    finally:
        os.chdir(previous_cwd)
    print('PASS: actual helper inspect is read-only; apply commits one exact migration, ledger and ACL readback; repeated apply is read-only')
