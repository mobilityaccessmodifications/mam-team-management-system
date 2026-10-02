import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = Path('/Users/nixon/.hermes/profiles/mam/cache/scratch').resolve()
spec = importlib.util.spec_from_file_location('closing_helper', ROOT / 'scripts/deploy-payroll-closing-carryforward.py')
assert spec is not None and spec.loader is not None
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
p = argparse.ArgumentParser()
p.add_argument('mode', choices=['prepare', 'verify'])
p.add_argument('socket')
p.add_argument('database')
p.add_argument('reviewed_sha256')
p.add_argument('metadata')
p.add_argument('--pins', type=Path)
p.add_argument('--output-prefix', default='payroll-purge-compatible-pins')
a = p.parse_args()
assert re.fullmatch('[a-z0-9-]+', a.output_prefix)
if a.pins is not None:
    m.PINS = a.pins
assert Path(os.environ['TMPDIR']).resolve() == SCRATCH
socket = Path(a.socket).resolve()
assert socket.parent == SCRATCH and re.fullmatch(r'mam-openclaw-pg\.[A-Za-z0-9]+', socket.name)
marker = json.loads((socket / 'mam-test-cluster.json').read_text())
assert marker == dict(owner='mam-local-tests-v1', socket=str(socket), port=55439)
assert re.fullmatch('mam_test_[a-z0-9_]+', a.database)
env = {k:os.environ[k] for k in ('PATH','TMPDIR')}
env.update(LANG='C', LC_ALL='C', PGPASSFILE='/dev/null', PGSERVICEFILE='/dev/null', PGCONNECT_TIMEOUT='5')


def sql(text, user='postgres', reject=False) -> str:
    proc = subprocess.run(['psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(socket),'-p','55439','-U',user,'-d',a.database], input=text, text=True, capture_output=True, env=env)
    if reject:
        assert proc.returncode and 'Payroll closing release catalog drift' in proc.stderr, proc.stderr
        return ''
    assert proc.returncode == 0, proc.stderr
    return proc.stdout.strip()


def catalog(functions=None, tables=None):
    return json.loads(sql("BEGIN READ ONLY; SET LOCAL search_path='';"+m.catalog_query(functions,tables)+'ROLLBACK;'))


def acl(kind, target, value):
    commands = [f'REVOKE ALL ON {kind} {target} FROM PUBLIC,postgres,anon,authenticated,service_role;']
    privileges = dict(r='SELECT',w='UPDATE',a='INSERT',d='DELETE',D='TRUNCATE',x='REFERENCES',t='TRIGGER',m='MAINTAIN',U='USAGE',C='CREATE',X='EXECUTE')
    assert value is not None
    for item in value.strip('{}').split(','):
        grantee, rest = item.split('=',1)
        codes, grantor = rest.split('/',1)
        assert grantor in ('postgres','pg_database_owner') and '*' not in codes
        commands.append(f"GRANT {','.join(privileges[c] for c in codes)} ON {kind} {target} TO {grantee or 'PUBLIC'};")
    return '\n'.join(commands)


raw = m.load_candidate(a.reviewed_sha256)
fresh = json.loads(Path(a.metadata).read_text())
live = fresh['preflight']['catalog']
m.validate_core_predecessor_pins(raw,live)
source = fresh['metadata']['ledger']
legacy_local = json.loads((SCRATCH / 'carryforward-local-predecessor-catalog.json').read_text())
predecessors = []
for file in sorted(m.MIGRATION.parent.glob('*.sql')):
    if file == m.MIGRATION:
        continue
    version, name = file.stem.split('_',1)
    assert version < m.VERSION
    predecessors.append(dict(file=file.name,version=version,name=name,sha256=hashlib.sha256(file.read_bytes()).hexdigest()))
local_ledger = [dict(version=r['version'],name=r['name'],sourceHash=m.digest(json.dumps([(m.MIGRATION.parent/r['file']).read_text()],ensure_ascii=False,separators=(',',':')))) for r in predecessors]
latest_file = m.MIGRATION.parent / '20261001140000_confirmed_test_purge_delivered_leave_history.sql'
latest_raw = latest_file.read_bytes()
assert hashlib.sha256(latest_raw).hexdigest() == '09e4ba4b48f035c195ca368735210d160f9fc09e9c3153d78b7ffb453709b4ee'
latest_pin = dict(version='20261001140000',name='confirmed_test_purge_delivered_leave_history',sourceHash='62109a734e071808bb62c342d971690116678a6fc41eb61cb4aed0c09fbf45d0')
assert local_ledger == legacy_local['ledger'] + [latest_pin], 'Unknown local historical source/catalog drift'
assert source[-1]['version'] == latest_pin['version'] and source[-1]['name'] == latest_pin['name']
assert source[-1]['statements'] == [latest_raw.decode('utf-8')], 'Latest source differs'
covered = {r['version'] for r in source}
aliases = []
gaps = []
for r in predecessors:
    if r['version'] in covered:
        continue
    matches = [s for s in source if s['name'] in (r['name'],r['version']+'_'+r['name'])]
    if matches:
        assert len(matches) == 1
        aliases.append(dict(localVersion=r['version'],liveVersion=matches[0]['version'],name=r['name']))
    else:
        gaps.append(r)
assert len(predecessors) == 166 and len(source) == 141 and len(gaps) == 24 and len(aliases) == 9
local_only = [r for r in predecessors if r['version'] not in covered]
live_only = [dict(version=r['version'], name=r['name']) for r in source if r['version'] not in {s['version'] for s in predecessors}]
assert len(local_only) == 33 and len(live_only) == 8

if a.mode == 'prepare':
    proc = subprocess.run(['createdb','-h',str(socket),'-p','55439','-U','postgres','--template=template0',a.database], capture_output=True, text=True, env=env)
    assert proc.returncode == 0, proc.stderr
    sql((ROOT / 'tests/migrations/0001-supabase-platform.sql').read_text())
    sql('CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]);')
    for r in predecessors:
        sql((m.MIGRATION.parent / r['file']).read_text())
    assert all(catalog()['functions'][s]['sha256'] == legacy_local['functions'][s]['sha256'] for s in legacy_local['functions'])
    table = live['tables']['private.portal_account_test_sessions']
    columns = []
    for c in table['columns']:
        assert not c['identity'] and c['columnAcl'] is None
        columns.append(c['name']+' '+c['type']+(' DEFAULT '+c['default'] if c['default'] is not None else '')+(' NOT NULL' if c['notNull'] else ''))
    columns += ['CONSTRAINT '+c['name']+' '+c['definition'] for c in table['constraints']]
    sql('CREATE TABLE private.portal_account_test_sessions('+','.join(columns)+');')
    sql('ALTER TABLE private.portal_account_test_sessions ENABLE ROW LEVEL SECURITY;')
    assert table['rls'] and not table['forceRls'] and not table['policies']
    for signature, definition in fresh['metadata']['sessionTriggerDefinitions'].items():
        assert sql("SET search_path=''; SELECT encode(sha256(convert_to(pg_get_functiondef(to_regprocedure("+m.literal(signature)+")),'UTF8')),'hex');") == m.digest(definition)
    for t in table['triggers']:
        assert t['enabled'] == 'O'
        sql(t['definition']+';')
    sql(fresh['preflight']['definitions']['private.is_active_portal_account(uuid)'])
    assert all(catalog()['functions'][s]['sha256'] == live['functions'][s]['sha256'] for s in m.BEFORE_FUNCTIONS), 'Unknown function drift'
    sql(acl('SCHEMA','public',next(s['acl'] for s in live['schemas'] if s['name']=='public')))
    for row in live['defaultAcl']:
        assert row['owner'] == 'postgres' and row['schema'] in ('public','storage') and row['kind'] in ('S','f','r')
        kind = {'S':'SEQUENCES','f':'FUNCTIONS','r':'TABLES'}[row['kind']]
        sql('ALTER DEFAULT PRIVILEGES IN SCHEMA '+row['schema']+' REVOKE ALL ON '+kind+' FROM postgres,anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA '+row['schema']+' GRANT ALL ON '+kind+' TO postgres,anon,authenticated,service_role;')
    for name, metadata in live['tables'].items():
        got = catalog()['tables'][name]
        assert {k:v for k,v in got.items() if k!='acl'} == {k:v for k,v in metadata.items() if k!='acl'}, (name,'Unknown non-ACL table drift')
        if got['acl'] != metadata['acl']:
            sql(acl('TABLE',name,metadata['acl']))
    for r in source:
        assert 'statements' in r
        statements = 'NULL' if r['statements'] is None else 'ARRAY['+','.join(m.literal(s) for s in r['statements'])+']::text[]'
        sql('INSERT INTO supabase_migrations.schema_migrations VALUES('+m.literal(r['version'])+','+m.literal(r['name'])+','+statements+');')
    sql('ALTER ROLE postgres NOSUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS INHERIT;',user='mam_fixture_admin')
    sql("INSERT INTO private.confirmed_test_identity_purges(id,person_id,auth_user_id,actor_user_id,company_key,manifest_hash,manifest,retained_audit,retired_identifiers,phase,completed_at) VALUES ('98abcdef-0000-4000-8001-000000000001','98abcdef-0000-4000-8000-000000000001',NULL,'98abcdef-0000-4000-8000-000000000002','mam',repeat('a',64),'{}','{}',ARRAY['98abcdef-0000-4000-8000-000000000001']::uuid[],'complete',clock_timestamp()),('98abcdef-0000-4000-8001-000000000002','98abcdef-0000-4000-8000-000000000003',NULL,'98abcdef-0000-4000-8000-000000000002','mam',repeat('b',64),'{}','{}',ARRAY['98abcdef-0000-4000-8000-000000000003']::uuid[],'business_purged',NULL);")
    sql('UPDATE private.confirmed_test_purge_schema SET schema_hash=private.confirmed_test_purge_schema_hash() WHERE singleton;')
    before = catalog()
    assert before == live, 'Adapted fixture must equal exact live protected catalog'
    insert = 'INSERT INTO supabase_migrations.schema_migrations VALUES('+m.literal(m.VERSION)+','+m.literal(m.NAME)+',ARRAY['+m.literal(raw)+']);'
    signatures = "SELECT jsonb_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE (n.nspname='private' AND (p.proname LIKE 'payroll_closing_%' OR p.proname LIKE 'payroll_carryforward_%' OR p.proname LIKE 'payroll_request_%' OR p.proname='payroll_retained_hours' OR p.proname LIKE '%_before_carryforward')) OR (n.nspname='public' AND p.proname IN ('preview_payroll_closing_reconciliation','reconcile_payroll_closing','settle_payroll_carryforward','get_leave_priority_workspace_before_carryforward'));"
    new_functions = json.loads(sql("BEGIN; SET LOCAL search_path='';"+m.transaction_body(raw)+signatures+'ROLLBACK;'))
    functions = sorted(set(m.BEFORE_FUNCTIONS+new_functions))
    tables = m.BEFORE_TABLES+m.NEW_TABLES
    after = json.loads(sql("BEGIN; SET LOCAL search_path='';"+m.transaction_body(raw)+insert+m.catalog_query(functions,tables)+'ROLLBACK;'))
    assert after['functions']['private.is_active_portal_account(uuid)'] == before['functions']['private.is_active_portal_account(uuid)']
    pins = dict(project=m.PROJECT,organization=m.ORG,version=m.VERSION,baseHead=m.BASE_HEAD,migrationSha256=m.digest(raw),localPredecessors=predecessors,observedHistoricalLedgerGaps=gaps,observedLedgerVersionAliases=aliases,observedLocalOnlyHistoricalMigrations=local_only,observedLiveOnlyLedgerEntries=live_only,before=before,after=after)
    draft = m.PINS
    draft.write_text(json.dumps(pins,indent=2)+'\n')
    print(json.dumps({'prepared':True,'releaseFinal':False,'finalCandidatePins':True,'exactLiveCatalog':True,'providerPermissions':before['roles'],'liveLedger':len(source),'afterLedger':len(after['ledger']),'localPredecessors':len(predecessors),'netHistoricalLedgerGap':len(predecessors)-len(source),'unmappedHistoricFiles':len(gaps),'aliases':len(aliases),'localOnly':len(local_only),'liveOnly':len(live_only),'pins':str(draft),'sha256':hashlib.sha256(draft.read_bytes()).hexdigest(),'migrationSha256':m.digest(raw)}))
else:
    pins = json.loads(m.PINS.read_text())
    assert pins['before'] == live and pins['localPredecessors'] == predecessors
    assert pins['observedHistoricalLedgerGaps'] == gaps and pins['observedLedgerVersionAliases'] == aliases
    assert pins['migrationSha256'] == m.digest(raw)
    m.validate_local_predecessors(pins['localPredecessors'])
    before, after = pins['before'],pins['after']
    assert catalog() == before
    transaction = m.build_transaction(raw,before,after)
    transaction_path = SCRATCH / (a.output_prefix+'-transaction.sql')
    transaction_path.write_text(transaction+'\n')
    count = 0
    purge_snapshot_sql = "SELECT jsonb_build_object('guard',(SELECT jsonb_agg(to_jsonb(g)) FROM private.confirmed_test_purge_schema g),'receipts',(SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]')::text,'UTF8')),'hex') FROM private.confirmed_test_identity_purges p));"
    purge_before = sql(purge_snapshot_sql)
    security_query = m.full_security_query(raw)
    security_before = sql("BEGIN READ ONLY; SET LOCAL search_path='';"+security_query+'ROLLBACK;')
    def reject(statement, fixture_admin=False):
        global count
        if fixture_admin or 'ALTER ROLE service_role NOBYPASSRLS;' in statement:
            statement = 'SET ROLE postgres; '+statement.replace('ALTER ROLE service_role NOBYPASSRLS;', 'SET LOCAL ROLE mam_fixture_admin; ALTER ROLE service_role NOBYPASSRLS; SET LOCAL ROLE postgres;')
            sql(statement,user='mam_fixture_admin',reject=True)
        else:
            sql(statement,reject=True)
        assert catalog() == before, 'Failure did not atomically restore exact predecessor catalog'
        assert sql(purge_snapshot_sql) == purge_before, 'Failure changed global guard or completed/pending receipt rows'
        assert sql("BEGIN READ ONLY; SET LOCAL search_path='';"+security_query+'ROLLBACK;') == security_before, 'Failure changed complete security metadata'
        assert sql("SELECT to_regclass('private.payroll_closing_receipts') IS NULL;") == 't'
        count += 1
    drifts = [
        'GRANT EXECUTE ON FUNCTION private.approved_leave_hours_after(uuid,text[],date) TO service_role;',
        'GRANT SELECT(hours) ON private.employee_sick_leave_balances TO service_role;',
        'ALTER TABLE private.employee_sick_leave_balances DISABLE ROW LEVEL SECURITY;',
        'ALTER ROLE service_role NOBYPASSRLS;',
        'GRANT CREATE ON SCHEMA private TO authenticated;',
        'ALTER DEFAULT PRIVILEGES IN SCHEMA private GRANT SELECT ON TABLES TO service_role;',
        "UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['select 0;'] WHERE version='20261001140000';",
        "UPDATE supabase_migrations.schema_migrations SET statements=ARRAY[]::text[] WHERE version='20260825120000';",
        "UPDATE supabase_migrations.schema_migrations SET statements=NULL WHERE version='20260813051743';",
        "UPDATE supabase_migrations.schema_migrations SET name='unknown' WHERE version='20260813051743';",
        'ALTER FUNCTION private.is_active_portal_account(uuid) SECURITY INVOKER;',
        'ALTER TABLE public.leave_requests DISABLE TRIGGER z_leave_requests_banked_annual_limit;',
        'ALTER TABLE public.leave_requests DROP CONSTRAINT leave_requests_employee_person_id_fkey;',
    ]
    for drift in drifts:
        reject('BEGIN; '+drift+transaction[len('begin;'):])
    guard_index = transaction.rindex('do $closing_release$')
    for drift in [
        'GRANT SELECT(note) ON private.payroll_closing_receipts TO service_role;',
        'GRANT EXECUTE ON FUNCTION public.reconcile_payroll_closing(text,jsonb) TO service_role;',
        'GRANT CREATE ON SCHEMA private TO authenticated;',
        'ALTER DEFAULT PRIVILEGES IN SCHEMA private GRANT SELECT ON TABLES TO service_role;',
        'ALTER ROLE service_role NOBYPASSRLS;',
        "UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['wrong'] WHERE version='20261001150000';",
    ]:
        reject(transaction[:guard_index]+drift+transaction[guard_index:])
    retained_atomic_cases = count
    assert retained_atomic_cases == 19
    reject("BEGIN; UPDATE private.confirmed_test_purge_schema SET schema_hash=repeat('0',64);"+transaction[len('begin;'):])
    reject("BEGIN; ALTER FUNCTION private.confirmed_test_purge_census(uuid,uuid) SECURITY INVOKER;"+transaction[len('begin;'):])
    for table in m.NEW_TABLES:
        reject(transaction[:guard_index]+'ALTER TABLE '+table+' DISABLE TRIGGER reject_retired_test_identity_reference;'+transaction[guard_index:])
    for drift in [
        "UPDATE private.confirmed_test_purge_schema SET schema_hash=repeat('0',64);",
        "UPDATE private.confirmed_test_identity_purges SET retained_audit=jsonb_build_object('unexpected',true);",
        "UPDATE private.confirmed_test_identity_purges SET retired_identifiers=ARRAY[]::uuid[];",
        "UPDATE private.confirmed_test_identity_purges SET phase='auth_delete_started';",
        "CREATE TABLE private.payroll_unreviewed_guard_drift(id integer); UPDATE private.confirmed_test_purge_schema SET schema_hash=private.confirmed_test_purge_schema_hash();",
    ]:
        reject(transaction[:guard_index]+drift+transaction[guard_index:])
    purge_atomic_cases = count-retained_atomic_cases
    security_atomic_cases = count
    security_faults = [
        ('GRANT CREATE ON SCHEMA storage TO authenticated;',False),
        ('GRANT CREATE ON SCHEMA auth TO authenticated;',False),
        ('SET LOCAL ROLE mam_fixture_admin; ALTER ROLE mam_fixture_admin NOINHERIT; SET LOCAL ROLE postgres;',True),
        ('SET LOCAL ROLE mam_fixture_admin; ALTER DEFAULT PRIVILEGES FOR ROLE mam_fixture_admin IN SCHEMA storage GRANT SELECT ON TABLES TO authenticated; SET LOCAL ROLE postgres;',True),
        ('GRANT SELECT(metadata) ON storage.objects TO anon;',False),
    ]
    assert 'storage.objects' not in before['tables'] and 'mam_fixture_admin' not in {r['name'] for r in before['roles']}
    security_check_index = transaction.rindex('do $closing_release_purge$')
    for boundary in (guard_index,security_check_index):
        for drift,fixture_admin in security_faults:
            reject(transaction[:boundary]+drift+transaction[boundary:],fixture_admin)
    security_atomic_cases = count-security_atomic_cases
    commit_boundary = transaction.rindex('\ncommit;')
    reject(transaction[:commit_boundary]+"\ndo $forced_failure$ begin raise exception 'Payroll closing release catalog drift: forced failure after complete security check' using errcode='55000'; end $forced_failure$;"+transaction[commit_boundary:])
    retained_total_cases = count
    assert retained_total_cases == 40
    deferred_function = 'supabase_migrations.payroll_closing_deferred_fixture'
    deferred_trigger = 'payroll_closing_deferred_fixture'
    def install_deferred_fixture(statement):
        sql('CREATE FUNCTION '+deferred_function+"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fixture$ BEGIN "+statement+' RETURN NEW; END $fixture$; REVOKE ALL ON FUNCTION '+deferred_function+'() FROM PUBLIC,anon,authenticated,service_role; CREATE CONSTRAINT TRIGGER '+deferred_trigger+' AFTER INSERT ON supabase_migrations.schema_migrations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION '+deferred_function+'();')
    def remove_deferred_fixture():
        sql('DROP TRIGGER '+deferred_trigger+' ON supabase_migrations.schema_migrations; DROP FUNCTION '+deferred_function+'();')
    for deferred_statement in [
        'GRANT CREATE ON SCHEMA storage TO authenticated;',
        'GRANT CREATE ON SCHEMA auth TO authenticated;',
        "UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['deferred fixture drift'] WHERE version=NEW.version;",
        "UPDATE private.confirmed_test_identity_purges SET retained_audit=jsonb_build_object('deferred_fixture',true);",
    ]:
        install_deferred_fixture(deferred_statement)
        try:
            assert catalog() == before
            assert sql("BEGIN READ ONLY; SET LOCAL search_path='';"+security_query+'ROLLBACK;') == security_before
            reject(transaction)
        finally:
            remove_deferred_fixture()
    deferred_cases = count-retained_total_cases
    sql('CREATE TABLE supabase_migrations.payroll_closing_deferred_fixture_runs(id integer);')
    install_deferred_fixture('INSERT INTO supabase_migrations.payroll_closing_deferred_fixture_runs VALUES(1);')
    try:
        sql(transaction)
        assert sql('SELECT count(*) FROM supabase_migrations.payroll_closing_deferred_fixture_runs;') == '1'
    finally:
        remove_deferred_fixture()
        sql('DROP TABLE supabase_migrations.payroll_closing_deferred_fixture_runs;')
    assert sql("BEGIN READ ONLY; SET LOCAL search_path='';"+security_query+'ROLLBACK;') == security_before, 'Successful transition changed complete security metadata'
    assert json.loads(sql(purge_snapshot_sql))['receipts'] == json.loads(purge_before)['receipts']
    assert catalog(list(after['functions']),list(after['tables'])) == after
    assert sql('SELECT count(*) FROM private.payroll_closing_receipts;') == '0'
    assert json.loads(sql("SELECT array_to_json(statements) FROM supabase_migrations.schema_migrations WHERE version='20261001150000';")) == [raw]
    sql(transaction,reject=True)
    assert catalog(list(after['functions']),list(after['tables'])) == after
    def exercise_main(expected_error=False):
        calls = []
        def query(statement):
            assert statement.lower().startswith('begin read only;') and statement.lower().rstrip().endswith('rollback;'), 'Recorded helper attempted write'
            calls.append(statement)
            result = sql(statement)
            if 'select version from supabase_migrations.schema_migrations' in statement.lower():
                return [{'version':value} for value in result.splitlines()]
            return [{'catalog':json.loads(result)}]
        original_query = m.query
        try:
            outputs = iter([m.BASE_HEAD+'\n',''])
            git = SimpleNamespace(check_output=lambda *args,**kwargs:next(outputs),run=lambda *args,**kwargs:SimpleNamespace(returncode=0))
            with patch.object(m,'query',side_effect=query), patch.object(m,'api',return_value={'id':m.PROJECT,'organization_id':m.ORG}), patch.object(m,'subprocess',git), patch.object(sys,'argv',['helper','apply',m.BASE_HEAD,m.digest(raw),m.digest(m.PINS.read_text())]), contextlib.redirect_stdout(io.StringIO()):
                if expected_error:
                    try: m.main()
                    except ValueError: pass
                    else: raise AssertionError('Recorded mismatching source accepted')
                else: m.main()
        finally:
            assert m.query == original_query
        return len(calls)
    idempotent_reads = exercise_main()
    sql("UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['wrong'] WHERE version='20261001150000';")
    exercise_main(expected_error=True)
    sql('UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['+m.literal(raw)+"] WHERE version='20261001150000';")
    assert catalog(list(after['functions']),list(after['tables'])) == after
    assert m.load_candidate(a.reviewed_sha256) == raw
    assert retained_atomic_cases == 19 and purge_atomic_cases == 10 and security_atomic_cases == 10 and deferred_cases == 4 and count == retained_total_cases+deferred_cases and idempotent_reads == 3
    assert 'private.payroll_request_unconsumed_hours(uuid,date,date)' in after['functions']
    ledger_sources = json.loads(sql("BEGIN READ ONLY; SELECT jsonb_agg(jsonb_build_object('version',version,'name',name,'statements',statements) ORDER BY version) FROM supabase_migrations.schema_migrations; ROLLBACK;"))
    assert ledger_sources == source + [dict(version=m.VERSION,name=m.NAME,statements=[raw])], 'Original historical source arrays changed'
    result: dict[str,object] = dict(passed=True,releaseFinal=False,finalCandidatePins=True,exactCandidatePins=True,exactLiveAdaptation=True,providerNonSuperuser=True,legacyLedgerUnchanged=True,activeSessionGuardPreserved=True,atomicDriftCases=count,retainedAtomicDriftCases=retained_atomic_cases,purgeAtomicDriftCases=purge_atomic_cases,purgeGuardConsistent=True,pendingAndCompletedPurgeReceiptsUnchanged=True,newRetirementTriggersVerified=True,recordedReplayRejected=True,idempotentReadOnlyQueries=idempotent_reads,recordedSourceDriftRejected=True,migrationSha256=m.digest(raw),pinsSha256=m.digest(m.PINS.read_text()),helperSha256=m.digest((ROOT/'scripts/deploy-payroll-closing-carryforward.py').read_text()),transactionSha256=m.digest(transaction+'\n'),transactionPath=str(transaction_path),localPredecessors=len(predecessors),beforeLedger=len(before['ledger']),afterLedger=len(after['ledger']),netHistoricalLedgerGap=len(predecessors)-len(source),localOnly=len(local_only),liveOnly=len(live_only),aliases=len(aliases),unmappedHistoricalFiles=len(gaps))
    result['completeSecurityAtomicDriftCases'] = security_atomic_cases
    result['postSecurityCheckRollbackCases'] = 1
    result['completeSecurityMetadataUnchanged'] = True
    result['retainedTotalAtomicDriftCases'] = retained_total_cases
    result['deferredLedgerAtomicDriftCases'] = deferred_cases
    result['benignDeferredLedgerEffectVerified'] = True
    result['securityFaultBoundaries'] = ['after ledger before final catalog guard','after final catalog guard before complete security check']
    result['securityFaults'] = [drift for drift,_ in security_faults]
    (SCRATCH/(a.output_prefix+'-verification.json')).write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))
