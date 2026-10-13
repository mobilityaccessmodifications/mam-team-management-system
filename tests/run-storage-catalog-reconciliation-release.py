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


with tempfile.TemporaryDirectory(prefix='storage-helper-', dir=socket) as copy:
    root = Path(copy)
    paths = ['scripts/deploy-storage-catalog-reconciliation.py', 'scripts/deploy-staff-leave-calendar.py',
             'supabase/migrations/20261013223523_reconcile_storage_0073_catalog.sql', 'supabase/migrations/20261013200000_day_one_reporting_splice_claims.sql']
    for name in paths:
        target = root/name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT/name, target)
    command(['git', '-C', copy, 'init', '--quiet'])
    command(['git', '-C', copy, 'config', 'user.name', 'mobilityaccessmodifications'])
    command(['git', '-C', copy, 'config', 'user.email', '310802599+mobilityaccessmodifications@users.noreply.github.com'])
    command(['git', '-C', copy, 'remote', 'add', 'origin', 'https://github.com/mobilityaccessmodifications/mam-team-management-system.git'])
    spec = importlib.util.spec_from_file_location('storage_catalog_native', root/paths[0])
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    source = helper.MIGRATION.read_text()
    predecessor_source = helper.PREDECESSOR.read_text()
    prefix = 'mam_test_storage_release_'+uuid.uuid4().hex[:6]
    base = prefix+'_base'
    clone(base, predecessor)
    sql(base, 'create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);')
    for migration in sorted((ROOT/'supabase/migrations').glob('*.sql')):
        version, name = migration.stem.split('_', 1)
        if version <= helper.PREDECESSOR_VERSION:
            sql(base, 'insert into supabase_migrations.schema_migrations values('+helper.literal(version)+','+helper.literal(name)+',ARRAY['+helper.literal(migration.read_text())+']) on conflict(version) do nothing;')
    major = int(sql(base, "select current_setting('server_version_num')::integer/10000;"))
    matched = prefix+'_matched'
    clone(matched, base)
    before = sql(matched, "select schema_hash from private.confirmed_test_purge_schema where singleton;")
    sql(matched, source)
    assert sql(matched, "select schema_hash from private.confirmed_test_purge_schema where singleton;") == before
    print('PASS: PostgreSQL '+str(major)+' exact matched catalog is a fingerprint no-op', flush=True)
    rejected = prefix+'_unknown'
    clone(rejected, base)
    sql(rejected, "update private.confirmed_test_purge_schema set schema_hash=repeat('0',64) where singleton;")
    try:
        sql(rejected, source)
        raise AssertionError('Unknown retained fingerprint accepted')
    except RuntimeError as failure:
        assert '55000' in str(failure)
    assert sql(rejected, 'select schema_hash from private.confirmed_test_purge_schema where singleton;') == '0'*64
    print('PASS: unrecognized catalog mismatch remains blocked without changing fingerprint', flush=True)
    database = prefix+'_exact'
    clone(database, base)
    if major == 17:
        acl_rows = re.findall(r"relacl::text='([^']*)' from pg_class where oid='([^']*)'::regclass", source)
        assert len(acl_rows) == 5
        for acl, relation in acl_rows:
            sql(database, 'alter table '+relation+' owner to supabase_storage_admin; update pg_class set relacl='+helper.literal(acl)+'::aclitem[] where oid='+helper.literal(relation)+'::regclass;')
        sql(database, "insert into storage.migrations(id,name,hash) values(73,'revoke-grants-to-unused-operations','ba9244051be09f22f714fc0170a2539f8b5f0e68') on conflict(id) do update set name=excluded.name,hash=excluded.hash;")
        current_hash = sql(database, 'select private.confirmed_test_purge_schema_hash();')
        counterfactual_sql = source.split('select value into counterfactual_hash from (', 1)[1].split(') proof(value);', 1)[0]
        old_hash = sql(database, "begin read only;set local search_path='';"+counterfactual_sql+';rollback;')
        assert old_hash != current_hash
        source = source.replace('c99a0a375681c75a4d17c7b56905a3130559a05efd4111c4badc684a8f8adc4f', old_hash).replace('bda99195a816a34310a05a0268d60c102dbc3c5f3712d87181974276330a032d', current_hash)
        helper.MIGRATION.write_text(source)
        sql(database, 'update private.confirmed_test_purge_schema set schema_hash='+helper.literal(old_hash)+' where singleton;')
        for label, fault in [
            ('unknown ACL', 'grant truncate on storage.buckets to anon;'),
            ('wrong provider checksum', "update storage.migrations set hash=repeat('f',40) where id=73;"),
            ('extra catalog object', 'create table public.storage_bridge_unreviewed(id integer);'),
        ]:
            fault_database = prefix+'_reject'+str(len(label))
            clone(fault_database, database)
            sql(fault_database, fault)
            try:
                sql(fault_database, source)
                raise AssertionError('Unreviewed drift accepted: '+label)
            except RuntimeError as failure:
                assert '55000' in str(failure)
            assert sql(fault_database, 'select schema_hash from private.confirmed_test_purge_schema where singleton;') == old_hash
            print('PASS: exact Storage transition rejects '+label, flush=True)
    race_database = prefix+'_postproof'
    clone(race_database, database)
    original_fingerprint = sql(race_database, 'select schema_hash from private.confirmed_test_purge_schema where singleton;')
    final_guard = '\ndo $storage_catalog_reconciliation_final$'
    assert source.count(final_guard) == 1
    try:
        sql(race_database, source.replace(final_guard, '\ncreate table public.bridge_late_catalog_change(id integer);'+final_guard))
        raise AssertionError('A later catalog change was incorporated into retained fingerprint')
    except RuntimeError as failure:
        assert '55000' in str(failure)
    assert sql(race_database, 'select schema_hash from private.confirmed_test_purge_schema where singleton;') == original_fingerprint
    print('PASS: standalone migration freezes the proved hash and rolls back postproof catalog drift', flush=True)
    command(['git', '-C', copy, 'add', '--', *paths])
    command(['git', '-C', copy, 'commit', '--quiet', '-m', 'Owned synthetic Storage release fixture'])
    head = command(['git', '-C', copy, 'rev-parse', 'HEAD'])
    pins = [head, *[hashlib.sha256((root/name).read_bytes()).hexdigest() for name in paths]]
    calls = {'writes': 0}
    def query(value):
        if not value.startswith('begin read only;'):
            calls['writes'] += 1
        output = sql(database, value).splitlines()
        value = next(line for line in reversed(output) if line.strip())
        return [{'state': json.loads(value)}] if value.startswith('{') else [{'resultingCatalogSha256': value}]
    before = helper.read_state(source, predecessor_source, query)
    helper.validate_before(before, source)
    release = helper.transaction(source, before, predecessor_source)
    boundary = '\nset constraints all immediate;\ndo $storage_release_final$'
    assert release.count(boundary) == 1
    for index, (label, fault) in enumerate([
        ('late unrelated grant', 'grant truncate on storage.buckets to anon;'),
        ('late data mutation', "insert into private.internal_org_domain_allowlist(domain) values('unreviewed.example');"),
        ('late ledger mutation', "update supabase_migrations.schema_migrations set name='unreviewed' where version='20261013200000';"),
    ]):
        fault_database = prefix+'_fault'+str(index)
        clone(fault_database, database)
        original = sql(fault_database, 'select '+helper.state_expression(source, predecessor_source)+';')
        try:
            sql(fault_database, release.replace(boundary, '\n'+fault+boundary))
            raise AssertionError('Late drift committed: '+label)
        except RuntimeError as failure:
            assert '55000' in str(failure), str(failure)[-1000:]
        assert sql(fault_database, 'select '+helper.state_expression(source, predecessor_source)+';') == original
        print('PASS: guarded release rolls back '+label, flush=True)
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
        assert writes == [release]
        after = helper.read_state(source, predecessor_source, query)
        helper.validate_target(after, source)
        assert all(after[key] == before[key] for key in ('major','dataHash','securityHash','catalogHash','predecessorExact'))
        assert after['ledger'][:-1] == before['ledger']
        if evidence is not None:
            (evidence/'readback.json').write_text(json.dumps({'before':before,'after':after,'fixtureClass':'OWNED_SYNTHETIC_NATIVE','pins':dict(zip(paths,pins[1:])),'writeCount':calls['writes']},indent=2))
        print('PASS: actual Storage helper reads exact guard, commits one source+ledger transaction, preserves data/security/provider ACLs, repeated apply readonly', flush=True)
    finally:
        os.chdir(previous_cwd)
