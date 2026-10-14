import contextlib
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
import urllib.request
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[1]
socket, predecessor = sys.argv[1:3]
marker = json.loads((Path(socket) / 'mam-test-cluster.json').read_text())
assert marker == {'owner': 'mam-local-tests-v1', 'socket': str(Path(socket).resolve()), 'port': 55439}
assert Path(socket).parent.resolve() == Path(tempfile.gettempdir()).resolve()
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


def clone(database, template):
    assert re.fullmatch('mam_test_[a-z0-9_]+', database)
    command(['createdb', '-h', socket, '-p', '55439', '-U', 'postgres', '--template=' + template, database])


with tempfile.TemporaryDirectory(prefix='requests-release-', dir=socket) as scratch:
    parent = Path(scratch)
    root, artifacts = parent / 'source', parent / 'artifacts'
    root.mkdir(mode=0o700)
    artifacts.mkdir(mode=0o700)
    paths = ['scripts/deploy-subscription-requests.py', 'scripts/deploy-staff-leave-calendar.py',
             'supabase/migrations/20261008160000_subscription_requests_milestone1.sql',
             'supabase/migrations/20261014100000_subscription_request_mail.sql',
             'supabase/migrations/20261013223556_task_follow_up_notes.sql']
    for relative in paths:
        destination = root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, destination)
    for args in [('init', '--quiet', '--template=', '--initial-branch=codex/native-requests'),
                 ('config', 'user.name', 'mobilityaccessmodifications'),
                 ('config', 'user.email', '310802599+mobilityaccessmodifications@users.noreply.github.com'),
                 ('remote', 'add', 'origin', 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git'),
                 ('add', '--', *paths), ('commit', '--quiet', '-m', 'Synthetic source-bound Requests release')]:
        command(['git', '-C', str(root), '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', *args])
    head = command(['git', '-C', str(root), 'rev-parse', 'HEAD'])
    spec = importlib.util.spec_from_file_location('native_requests_release', root / paths[0])
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    held = {path: path.read_bytes() for path in (helper.HELPER, helper.TRANSPORT, helper.CORE, helper.MAIL, helper.PREDECESSOR)}
    prefix = 'mam_test_requests_release_' + uuid.uuid4().hex[:6]
    base = prefix + '_base'
    clone(base, predecessor)
    fixture = "\\ir '" + str(ROOT / 'tests/unified-role-fixture.sql').replace("'", "''") + "'\n"
    sql(base, fixture)
    for migration in sorted((ROOT / 'supabase/migrations').glob('*.sql')):
        version, name = migration.stem.split('_', 1)
        if version <= '20261013223556' and version != '20261008160000':
            sql(base, 'insert into supabase_migrations.schema_migrations(version,name,statements) values(' + helper.literal(version) + ',' + helper.literal(name) + ',ARRAY[' + helper.literal(migration.read_text()) + ']) on conflict(version) do nothing;')
    relations = ['auth.users'] + sql(base, "select format('%I.%I',n.nspname,c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and c.relkind in ('r','p') and c.oid<>'private.confirmed_test_purge_schema'::regclass order by 1;").splitlines()
    before = json.loads(sql(base, 'select ' + helper.state_expression(held, relations)))
    helper.validate_before(before)
    release = helper.transaction(held, relations, before)
    boundary = '\nset constraints all immediate;do $release_final$'
    assert release.count(boundary) == 1
    faults = [
        ('request_acl', 'grant execute on function public.sr_workspace() to anon;'),
        ('mail_acl', 'grant execute on function public.claim_subscription_request_mail(uuid,integer) to authenticated;'),
        ('column_acl', 'grant select(work_email) on private.employee_directory_details to anon;'),
        ('protected_data', "update public.profiles set updated_at=updated_at+interval '1 second' where id='a1000000-0000-4000-8000-000000000004';"),
        ('historical_ledger', "update supabase_migrations.schema_migrations set name=name||'_drift' where version='20260904121500';"),
        ('target_ledger', "update supabase_migrations.schema_migrations set statements=array['drift'] where version='20261008160000';"),
        ('enabled_seed', "update private.subscription_request_config set enabled=true;"),
        ('late_role', 'alter role anon bypassrls;'),
    ]
    for index, (label, effect) in enumerate(faults):
        database = prefix + '_fault_' + str(index)
        clone(database, base)
        original = json.loads(sql(database, 'select ' + helper.state_expression(held, relations)))
        try:
            sql(database, release.replace(boundary, '\n' + effect + boundary))
            raise AssertionError('Fault committed: ' + label)
        except RuntimeError as failure:
            assert '55000' in str(failure), str(failure)[-1000:]
        assert json.loads(sql(database, 'select ' + helper.state_expression(held, relations))) == original
        print('PASS atomic complete rollback: ' + label)
    database = prefix + '_deferred'
    clone(database, base)
    deferred = "create function pg_temp.requests_late_acl() returns trigger language plpgsql as $$begin execute 'grant execute on function public.sr_workspace() to anon';return new;end$$;create constraint trigger requests_late_acl after insert on supabase_migrations.schema_migrations deferrable initially deferred for each row execute function pg_temp.requests_late_acl();"
    insert = 'insert into supabase_migrations.schema_migrations(version,name,statements)'
    candidate = release.replace(insert, deferred + insert, 1)
    try:
        sql(database, candidate)
        raise AssertionError('Deferred fault committed')
    except RuntimeError as failure:
        assert '55000' in str(failure), str(failure)[-1000:]
    assert json.loads(sql(database, 'select ' + helper.state_expression(held, relations))) == before
    print('PASS actual deferred ledger grant drained and rolled back')
    database = prefix + '_public'
    clone(database, base)
    calls = {'writes': 0}
    def fake_urlopen(request, **kwargs):
        if request.full_url == 'https://api.supabase.com/v1/projects/xtwlrjqbusadghavchqm':
            result = {'id': 'xtwlrjqbusadghavchqm', 'organization_id': 'fwlmbmospuwoaosffvmw'}
        else:
            assert request.full_url.endswith('/xtwlrjqbusadghavchqm/database/query')
            query = json.loads(request.data)['query']
            if not query.startswith('begin read only;'):
                calls['writes'] += 1
            output = sql(database, query).splitlines()
            if output[-1].startswith('{'):
                result = [{'state' if query.startswith('begin read only;') else 'receipt': json.loads(output[-1])}]
            else:
                result = [{'name': value} for value in output if value]
        return io.BytesIO(json.dumps(result).encode())
    arguments = ['--head', head]
    for name, path in zip(('helper', 'transport', 'core', 'mail', 'predecessor'), held):
        arguments += ['--' + name + '-sha', helper.sha(held[path])]
    snapshot = artifacts / 'snapshot.json'
    arguments += ['--snapshot', str(snapshot)]
    old_cwd = Path.cwd()
    try:
        os.chdir(root)
        with patch.dict(os.environ, {'SUPABASE_ACCESS_TOKEN': 'synthetic-native-no-network'}), patch.object(urllib.request, 'urlopen', fake_urlopen):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                helper.main(['prepare', *arguments])
            assert json.loads(output.getvalue())['readOnly'] and calls['writes'] == 0
            arguments += ['--snapshot-sha', helper.sha(snapshot.read_bytes())]
            with contextlib.redirect_stdout(io.StringIO()) as output:
                helper.main(['inspect', *arguments])
            assert json.loads(output.getvalue())['predecessorMatches'] and calls['writes'] == 0
            with contextlib.redirect_stdout(io.StringIO()) as output:
                helper.main(['apply', *arguments])
            assert json.loads(output.getvalue())['readbackVerified'] and calls['writes'] == 1
            try:
                helper.main(['apply', *arguments])
                raise AssertionError('Repeated dispatch was allowed')
            except SystemExit as failure:
                assert 'predecessor drift' in str(failure)
            assert calls['writes'] == 1
            with contextlib.redirect_stdout(io.StringIO()) as output:
                helper.main(['inspect', *arguments])
            assert json.loads(output.getvalue())['targetsExact'] and calls['writes'] == 1
            try:
                helper.main(['apply', *arguments[:-1], '0' * 64])
                raise AssertionError('Bad snapshot pin was accepted')
            except SystemExit as failure:
                assert 'Snapshot pin differs' in str(failure)
            assert calls['writes'] == 1
    finally:
        os.chdir(old_cwd)
    print('PASS actual public prepare/inspect/apply, one COMMIT, fresh full readback and no repeat dispatch')
