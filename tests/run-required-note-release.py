import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('required_note_release', ROOT / 'scripts/deploy-leave-required-note.py')
assert SPEC is not None and SPEC.loader is not None
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


def run(socket, predecessor, prefix):
    marker = json.loads((Path(socket) / 'mam-test-cluster.json').read_bytes())
    assert marker == {'owner': 'mam-local-tests-v1', 'socket': str(Path(socket).resolve()), 'port': 55439}
    assert Path(socket).resolve().parent == Path(tempfile.gettempdir()).resolve()
    assert all(re.fullmatch(r'mam_test_[a-z0-9_]+', value) for value in [predecessor, prefix]) and len(prefix) < 40
    env = {key: os.environ[key] for key in ('PATH', 'HOME') if key in os.environ}
    env.update(TMPDIR=str(Path(socket).resolve().parent), LANG='C', LC_ALL='C', PGPASSFILE='/dev/null', PGSERVICEFILE='/dev/null', PGCONNECT_TIMEOUT='5', PGPASSWORD='synthetic-local-unused', PYTHONDONTWRITEBYTECODE='1')
    output = ROOT / 'output'
    output.mkdir(exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix='required-note-native-', dir=output))
    evidence.chmod(0o700)
    source = helper.candidate(helper.sha(helper.MIGRATION.read_bytes()))
    bindings = {str(p.relative_to(ROOT)): helper.sha(p.read_bytes()) for p in [helper.MIGRATION, helper.PREDECESSOR, helper.TRANSPORT, ROOT/'scripts/deploy-leave-required-note.py', ROOT/'tests/leave-required-note.sql', ROOT/'tests/leave-required-note-legacy-setup.sql', ROOT/'tests/leave-required-note-legacy.sql', Path(__file__)]}
    (evidence/'sources.json').write_text(json.dumps(bindings, sort_keys=True, indent=2)+'\n')
    databases, cases = [], []
    sequence = 0

    def command(binary, args):
        result = subprocess.run([binary, *args], env=env, text=True, capture_output=True, timeout=120)
        assert result.returncode == 0, result.stderr
        return result.stdout

    def native(database, query, failure=False):
        nonlocal sequence
        sequence += 1
        name = 'query-%03d' % sequence
        path = evidence/(name+'.sql')
        path.write_text(query)
        path.chmod(0o600)
        args = ['psql','-X','-h',socket,'-p','55439','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-Atq','-f',str(path)]
        result = subprocess.run(args, env=env, text=True, capture_output=True, timeout=120)
        (evidence/(name+'.log')).write_text(result.stdout+result.stderr)
        (evidence/(name+'.exit')).write_text(str(result.returncode)+'\n')
        (evidence/(name+'.receipt.json')).write_text(json.dumps({'command':args,'exit':result.returncode,'querySha256':helper.sha(query.encode()),'logSha256':helper.sha((result.stdout+result.stderr).encode())},indent=2)+'\n')
        if failure:
            assert result.returncode != 0 and '55000' in result.stderr and 'Required-note' in result.stderr, result.stderr
        else:
            assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    def state(database):
        return json.loads(native(database,"begin read only; set local search_path=''; select "+helper.state_expression(source)+'; rollback;'))

    def clone(suffix):
        database = prefix+'_'+suffix
        command('createdb',['-h',socket,'-p','55439','-U','postgres','--template='+predecessor,database])
        databases.append(database)
        isolation = json.loads(native(database,"select json_build_object('database',current_database(),'socketOnly',inet_server_addr() is null and current_setting('listen_addresses')='');"))
        assert isolation == {'database':database,'socketOnly':True}
        native(database,'insert into supabase_migrations.schema_migrations(version,name,statements) values('+helper.literal(helper.PREDECESSOR_VERSION)+','+helper.literal(helper.PREDECESSOR_NAME)+',ARRAY['+helper.literal(helper.PREDECESSOR.read_bytes().decode())+']);')
        return database

    def passed(case):
        cases.append(case)
        print('PASS '+case,flush=True)

    try:
        positive = clone('ok')
        seed = (ROOT/'tests/leave-required-note-legacy-setup.sql').read_text().replace('\\ir sql-test-auth.sql','\\ir '+str(ROOT/'tests/sql-test-auth.sql'))
        native(positive,seed)
        before = state(positive)
        helper.validate_before(before,source)
        release = helper.transaction(source,before)
        catalog = native(positive,release).splitlines()[-1]
        helper.verify_after(state(positive),before,source,catalog)
        passed('RNR01 exact generated COMMIT and independent catalog/security/raw-ledger/receipt/data readback')
        for file in ['leave-required-note.sql','leave-required-note-legacy.sql']:
            result = native(positive,(ROOT/'tests'/file).read_text().replace('\\ir sql-test-auth.sql','\\ir '+str(ROOT/'tests/sql-test-auth.sql')))
            print(result,flush=True)
        passed('RNR02 new self selected manager idempotent native assistant and legacy lifecycle contracts')

        for suffix, fault in [
            ('body',"alter function private.enforce_leave_request_employment_policy() security invoker;"),
            ('column',"grant select(reason) on public.leave_requests to anon;"),
            ('policy',"create policy required_note_fault on storage.objects for select to anon using (true);"),
            ('schema',"grant usage on schema storage to public;"),
        ]:
            database = clone(suffix)
            baseline = state(database)
            transaction = helper.transaction(source,baseline)
            anchor = '\ndo $required_note_release_final$'
            assert transaction.count(anchor) == 1
            transaction = transaction.replace(anchor,'\n'+fault+anchor,1)
            native(database,transaction,failure=True)
            assert state(database) == baseline, 'Fault did not roll back exact state: '+suffix
            passed('RNR03 '+suffix+' final-boundary drift atomically rejected')

        for suffix, deferred in [('late',False),('deferred',True)]:
            database = clone(suffix)
            hook = 'required_note_fault_'+suffix
            body = "create function supabase_migrations."+hook+"() returns trigger language plpgsql as $$ begin if new.version="+helper.literal(helper.VERSION)+" then grant select(reason) on public.leave_requests to anon; end if; return new; end $$;\n"
            body += ('create constraint trigger ' if deferred else 'create trigger ')+hook+' after insert on supabase_migrations.schema_migrations '
            body += 'deferrable initially deferred ' if deferred else ''
            body += 'for each row execute function supabase_migrations.'+hook+'();'
            native(database,body)
            baseline = state(database)
            transaction = helper.transaction(source,baseline)
            if deferred:
                anchor = '\ninsert into supabase_migrations.schema_migrations(version,name,statements)'
                assert transaction.count(anchor) == 1
                transaction = transaction.replace(anchor,'\nset constraints supabase_migrations.'+hook+' deferred;'+anchor,1)
            native(database,transaction,failure=True)
            assert state(database) == baseline, 'Ledger hook did not roll back exact state'
            passed('RNR04 '+suffix+' ledger fault drained and atomically rejected')

        database = clone('source')
        baseline = state(database)
        transaction = helper.transaction(source,baseline)
        native(database,"update supabase_migrations.schema_migrations set statements=array_fill('changed'::text,ARRAY[1],ARRAY[0]) where version="+helper.literal(helper.PREDECESSOR_VERSION)+';')
        changed = state(database)
        native(database,transaction,failure=True)
        assert state(database) == changed and changed != baseline
        passed('RNR05 exact predecessor source and SQL array bounds are checked before any write')
        for path, digest in bindings.items():
            assert helper.sha((ROOT/path).read_bytes()) == digest, 'Source changed during native gate'
        (evidence/'summary.json').write_text(json.dumps({'passed':True,'cases':cases,'caseCount':len(cases),'sourceBindings':bindings,'syntheticOnly':True,'liveProviderNotCalled':True,'cleanCommittedApplyEntryNotRun':True},indent=2)+'\n')
        print(json.dumps({'evidence':str(evidence),'caseCount':len(cases),'syntheticOnly':True}),flush=True)
    finally:
        for database in reversed(databases):
            command('dropdb',['-h',socket,'-p','55439','-U','postgres',database])


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('socket')
    parser.add_argument('predecessor')
    parser.add_argument('prefix')
    args=parser.parse_args()
    run(args.socket,args.predecessor,args.prefix)
