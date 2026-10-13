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
HELPER_PATH = ROOT/'scripts/deploy-offboarding-version-conflicts.py'
RAW_HELPER = HELPER_PATH.read_bytes()
spec = importlib.util.spec_from_file_location('version_conflict_native', HELPER_PATH)
assert spec is not None
helper = importlib.util.module_from_spec(spec)
exec(compile(RAW_HELPER, str(HELPER_PATH), 'exec'), helper.__dict__)


def source_context(root):
    if not (root / '.git').exists():
        return {'git': False, 'cleanCommittedApply': 'UNAVAILABLE_NON_GIT_SOURCE'}
    dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=root).strip())
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root).decode().strip()
    return {'git': True, 'dirty': dirty, 'head': head,
            'cleanCommittedApply': 'BLOCKED_UNCOMMITTED_SOURCE' if dirty else 'NOT_RUN'}


def run(socket, predecessor, prefix, evidence_dir):
    socket = Path(socket).resolve()
    assert socket.parent == Path(tempfile.gettempdir()).resolve()
    assert all(re.fullmatch('mam_test_[a-z0-9_]+', name) for name in (predecessor,prefix)) and len(prefix)<34
    marker = socket/'vc-fix-owner.json'
    if marker.exists():
        owner = helper.load_json(marker.read_bytes())
        assert owner['task']=='offboarding-four-site-version-conflict' and owner['socket']==str(socket) and owner['port']==55439
    else:
        assert helper.load_json((socket/'mam-test-cluster.json').read_bytes())=={'owner':'mam-local-tests-v1','socket':str(socket),'port':55439}
    evidence = Path(tempfile.mkdtemp(prefix='version-conflict-native-',dir=evidence_dir or socket))
    env = {'PATH':os.environ['PATH'],'TMPDIR':str(socket.parent),'LANG':'C','LC_ALL':'C','PGPASSFILE':str(socket.parent/'vc-no-pass-file'),'PGSERVICEFILE':'/dev/null','PGCONNECT_TIMEOUT':'5','PYTHONDONTWRITEBYTECODE':'1'}
    source_sha = helper.sha(helper.MIGRATION.read_bytes())
    source = helper.candidate(source_sha)
    paths = [HELPER_PATH,helper.MIGRATION,helper.PREDECESSOR,helper.F65,helper.TRANSPORT,ROOT/'tests/offboarding-version-conflicts.sql',Path(__file__).resolve()]
    pins = {str(path.relative_to(ROOT)):helper.sha(path.read_bytes()) for path in paths}
    databases,commands,cases = [],[],[]
    role = prefix+'_login'
    role_created = False
    initial = None
    failure = None
    context_role = 'postgres'
    clean_committed_apply = 'NOT_RUN'

    def retain(name,value):
        target = evidence/name
        target.write_text(json.dumps(value,sort_keys=True,indent=2)+'\n')
        target.chmod(0o600)

    def native(db,text,name,login='postgres',success=True):
        query = evidence/(name+'.sql')
        assert not query.exists()
        query.write_bytes(text.encode())
        query.chmod(0o600)
        execution_env=dict(env,PGOPTIONS='-c default_transaction_read_only=off') if login=='postgres' else env
        result = subprocess.run(['psql','-X','-h',str(socket),'-p','55439','-U',login,'-d',db,'-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-At','-f',str(query)],env=execution_env,capture_output=True,text=True,timeout=90)
        for suffix,output in [('stdout',result.stdout),('stderr',result.stderr)]:
            (evidence/(name+'.'+suffix)).write_text(output)
            (evidence/(name+'.'+suffix)).chmod(0o600)
        commands.append({'query':query.name,'database':db,'login':login,'exit':result.returncode,'querySha256':helper.sha(text.encode())})
        retain('commands.json',commands)
        if success:
            assert result.returncode==0,'Native query failed: '+name
        else:
            assert result.returncode!=0 and '55000' in result.stderr,'Expected exact guarded 55000 atomic rollback: '+name
        return result

    def rows(result):
        return [helper.load_json(line) for line in result.stdout.splitlines() if line.startswith(('{','['))]

    def state(db,name):
        frame=rows(native(db,"begin read only;set local search_path='';select "+helper.state_expression(source)+';rollback;',name))[0]
        retain(name+'.json',frame)
        return frame

    def command(binary,args):
        result=subprocess.run([binary,*map(str,args)],env=env,text=True,capture_output=True,timeout=90)
        assert result.returncode==0,result.stderr

    def clone(label,template=predecessor):
        db=prefix+'_'+label
        assert db not in databases
        command('createdb',['-h',socket,'-p','55439','-U','postgres','--template='+template,db])
        databases.append(db)
        recorded=rows(native(db,"begin read only;select jsonb_build_object('present',exists(select 1 from supabase_migrations.schema_migrations where version="+helper.literal(helper.PREDECESSOR_VERSION)+"));rollback;",db+'-predecessor-ledger'))[0]['present']
        if not recorded:
            native(db,'insert into supabase_migrations.schema_migrations(version,name,statements) values('+helper.literal(helper.PREDECESSOR_VERSION)+','+helper.literal(helper.PREDECESSOR_NAME)+',array['+helper.literal(helper.PREDECESSOR.read_text())+']::text[]);',db+'-synthetic-predecessor-ledger')
        return db

    def setup(db):
        text="create schema vc_release_probe;grant usage on schema vc_release_probe to anon;create table vc_release_probe.sensitive(value integer);insert into vc_release_probe.sensitive values(1);grant select on vc_release_probe.sensitive to anon;alter table vc_release_probe.sensitive enable row level security;alter table vc_release_probe.sensitive force row level security;create policy scoped_deny on vc_release_probe.sensitive for select to anon using(false);"
        text+="insert into supabase_migrations.schema_migrations(version,name,statements) values('19000101000001','synthetic_null_history',null),('19000101000002','synthetic_empty_history',array[]::text[]),('19000101000003','synthetic_zero_bound_history',array_fill('select 1;'::text,array[1],array[0]));"
        text+="insert into auth.users(id,email,email_confirmed_at) values('a7400000-0000-4000-8001-000000000001','vc-preserve@example.test',clock_timestamp());insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after) values('a7400000-0000-4000-8001-000000000001','Synthetic Preservation','admin','vc-preserve@example.test',clock_timestamp()-interval '1 day');"
        text+="insert into private.confirmed_test_identity_purges(id,person_id,auth_user_id,actor_user_id,company_key,manifest_hash,manifest,retained_audit,retired_identifiers,phase,completed_at) values('a7400000-0000-4000-8001-000000000099','a7400000-0000-4000-8001-000000000099',null,'a7400000-0000-4000-8001-000000000001','mam',repeat('b',64),'{\"synthetic\":true}','{\"retained\":true}',array['a7400000-0000-4000-8001-000000000099']::uuid[],'complete',clock_timestamp());"
        native(db,text,db+'-setup')

    def raw(db,name):
        expression=helper.source_function(source,'offboarding_version_conflict_security')
        reference='select to_regprocedure(signature) from offboarding_version_conflict_function_spec where to_regprocedure(signature) is not null'
        assert expression.count(reference)==1
        expression=expression.replace(reference,'select to_regprocedure(signature) from unnest(array['+','.join(helper.literal(s) for s in sorted(helper.SIGNATURES))+']::text[]) signature where to_regprocedure(signature) is not null')
        text="begin read only;set local search_path='';select jsonb_build_object('ledger',(select jsonb_agg(jsonb_build_object('version',version,'rowSha256',encode(extensions.digest(to_jsonb(m)::text,'sha256'),'hex'),'arraySha256',encode(extensions.digest(coalesce(statements::text,'<NULL>'),'sha256'),'hex'),'dimensions',array_dims(statements),'cardinality',cardinality(statements)) order by version) from supabase_migrations.schema_migrations m),'securityCategories',(select jsonb_object_agg(k,encode(extensions.digest(v::text,'sha256'),'hex')) from jsonb_each(("+expression+")) j(k,v)),'functions',(select jsonb_object_agg(signature,jsonb_build_object('definition',pg_get_functiondef(p.oid),'metadata',(to_jsonb(p)-array['prosrc','prosqlbody','proargdefaults'])||jsonb_build_object('parameter_defaults',pg_get_expr(p.proargdefaults,0)))) from unnest(array["+','.join(helper.literal(s) for s in sorted(helper.SIGNATURES))+" ]::text[]) signature join pg_proc p on p.oid=to_regprocedure(signature)));rollback;"
        value=rows(native(db,text,name))[0]
        retain(name+'.json',value)
        return value

    def release(db,frame,name):
        snapshot=evidence/(name+'-snapshot.json')
        helper.retain(snapshot,frame)
        captured=helper.load_json(snapshot.read_bytes())
        query=helper.transaction(source,captured)
        result=native(db,query,name)
        assert 'COMMIT' in result.stdout.splitlines(),'Actual native COMMIT tag required'
        values=[line for line in result.stdout.splitlines() if re.fullmatch('[0-9a-f]{64}',line)]
        assert len(values)==1
        catalog=helper.resulting_catalog([{'offboardingVersionConflictResultingCatalogSha256':values[0]}])
        after=state(db,name+'-after')
        helper.verify_after(after,captured,source,catalog)
        return captured,query,catalog,after

    def finish_case(value):
        cases.append(value)
        retain('cases.json',cases)
        print('PASS: '+value['case'],flush=True)

    try:
        identity=rows(native(predecessor,"begin read only;select jsonb_build_object('database',current_database(),'current',current_user,'session',session_user,'major',current_setting('server_version_num')::int/10000,'superuser',rolsuper,'socketOnly',inet_server_addr() is null and current_setting('listen_addresses')='','fixtureAdmin',exists(select 1 from pg_roles where rolname='fixture_bootstrap')) from pg_roles where rolname=current_user;rollback;",'identity'))[0]
        assert identity['database']==predecessor and identity['current']==identity['session']=='postgres' and identity['socketOnly'] and identity['major'] in (16,17)
        context_role='fixture_bootstrap' if identity['fixtureAdmin'] else 'postgres'
        retain('identity.json',dict(identity,migrationExecution='postgres',authContext='SQL_ACTOR_FIXTURE_NOT_PROVIDER_JWT'))
        initial=state(predecessor,'original-before')
        assert initial['predecessorFunctionsExact'] and initial['purgeMatches']
        native(predecessor,'create role '+role+' login nosuperuser nobypassrls nocreatedb nocreaterole noreplication;','owned-role')
        role_created=True
        control=clone('control')
        setup(control)
        frame=state(control,'before')
        raw_before=raw(control,'raw-before')
        captured,query,catalog,after=release(control,frame,'exact-public-transaction')
        raw_after=raw(control,'raw-after')
        assert raw_after['ledger'][:-1]==raw_before['ledger'] and raw_after['securityCategories']==raw_before['securityCategories']
        for signature in helper.SIGNATURES:
            before=raw_before['functions'][signature]
            forward=raw_after['functions'][signature]
            assert forward['metadata']==before['metadata'] and forward['definition'].replace("'PT409'","'40001'")==before['definition']
        finish_case({'case':'exact_native_commit','passed':True,'major':identity['major'],'querySha256':helper.sha(query.encode()),'rawHistoricalLedgerExact':True,'securityCategoryCount':len(raw_after['securityCategories']),'functionReversalByteExact':True,'ownerAclConfigAndMetadataExact':True,'independentReadback':True,'completeReceiptDataAndFingerprintVerified':True})
        regression=native(control,(ROOT/'tests/offboarding-version-conflicts.sql').read_text(),'actual-actor-regression',login=context_role)
        summary=next(value for value in rows(regression) if value.get('type')=='summary')
        assert summary['caseCount']==15 and summary['pass']==15 and summary['fail']==0
        assert all(row['passed'] and row['result']['footprintExact'] for row in summary['cases'])
        assert state(control,'after-actor-rollback')==after
        retain('actor-summary.json',summary)
        finish_case({'case':'actual_actor_regressions','passed':True,'caseCount':15,'nativeSqlActorFixtureOnly':True,'providerRequests':0,'providerBanClaimed':False,'allFootprintsAndSequencesExact':True})
        final_anchor='\ndo $offboarding_version_conflict_release_final$'
        faults=[('policy','alter policy scoped_deny on vc_release_probe.sensitive using(true)'),('column_acl','grant update(value) on vc_release_probe.sensitive to anon'),('schema_acl','grant create on schema auth to anon'),('default_acl','alter default privileges for role postgres in schema vc_release_probe grant insert on tables to anon'),('role_attribute','alter role '+role+' createdb'),('target_acl','revoke execute on function public.preflight_employee_removal_reporting_splice(uuid,bigint,bigint,date,text) from authenticated'),('target_config',"alter function public.archive_employee_directory_record(uuid,bigint,bigint,date,text) set statement_timeout='1s'"),('unchanged_finalizer',"alter function public.finalise_portal_account_status_change(uuid,uuid,uuid) set statement_timeout='1s'"),('receipt',"update private.confirmed_test_identity_purges set retained_audit='{\"fault\":true}' where id='a7400000-0000-4000-8001-000000000099'"),('data',"update public.profiles set full_name='Synthetic mutation' where id='a7400000-0000-4000-8001-000000000001'"),('historical_null',"update supabase_migrations.schema_migrations set statements=array[]::text[] where version='19000101000001'"),('historical_empty',"update supabase_migrations.schema_migrations set statements=null where version='19000101000002'"),('historical_bound',"update supabase_migrations.schema_migrations set statements=array_fill(statements[0],array[1],array[1]) where version='19000101000003'"),('target_bound',"update supabase_migrations.schema_migrations set statements=array_fill(statements[1],array[1],array[0]) where version='20261013153500'")]
        for index,(label,fault) in enumerate(faults):
            db=clone('f'+str(index))
            setup(db)
            before=state(db,label+'-before')
            original=helper.transaction(source,before)
            assert original.count(final_anchor)==1
            block='\n'+fault+';'
            injected=original.replace(final_anchor,block+final_anchor,1)
            assert injected.replace(block,'',1)==original
            native(db,injected,'late-'+label,success=False)
            assert state(db,label+'-after')==before
            finish_case({'case':'late_'+label,'passed':True,'atomicRollback':True,'removingFaultRestoresExactQuery':True,'baseQuerySha256':helper.sha(original.encode()),'faultQuerySha256':helper.sha(injected.encode())})
            command('dropdb',['-h',socket,'-p','55439','-U','postgres',db])
            databases.remove(db)
        for scope in ('role_database','database_default','global_role'):
            db=clone(scope)
            setup(db)
            statement='alter role '+role+' in database '+db if scope=='role_database' else 'alter database '+db if scope=='database_default' else 'alter role '+role
            native(db,statement+' set default_transaction_read_only=on;',scope+'-setup-setting')
            before=state(db,scope+'-before')
            original=helper.transaction(source,before)
            block='\n'+statement+' set default_transaction_read_only=off;'
            injected=original.replace(final_anchor,block+final_anchor,1)
            assert injected.replace(block,'',1)==original
            native(db,injected,scope+'-fault',success=False)
            assert state(db,scope+'-after')==before
            finish_case({'case':'settings_'+scope,'passed':True,'atomicRollback':True,'valuesDigestOnly':True,'roleZero':scope=='database_default','databaseZero':scope=='global_role'})
            if scope=='global_role':native(db,statement+' reset default_transaction_read_only;',scope+'-restore')
            command('dropdb',['-h',socket,'-p','55439','-U','postgres',db]);databases.remove(db)
        db=clone('deferred')
        setup(db)
        hook="create function supabase_migrations.vc_deferred_fault() returns trigger language plpgsql as $$begin if new.version='20261013153500' then grant create on schema auth to anon;end if;return new;end$$;create constraint trigger vc_deferred_fault after insert on supabase_migrations.schema_migrations deferrable initially deferred for each row execute function supabase_migrations.vc_deferred_fault();"
        native(db,hook,'deferred-setup')
        before=state(db,'deferred-before')
        original=helper.transaction(source,before)
        ledger='\ninsert into supabase_migrations.schema_migrations(version,name,statements)'
        assert original.count(ledger)==1
        injected=original.replace(ledger,'\nset constraints supabase_migrations.vc_deferred_fault deferred;'+ledger,1)
        native(db,injected,'deferred-fault',success=False)
        assert state(db,'deferred-after')==before
        finish_case({'case':'deferred_ledger_security_effect','passed':True,'atomicRollback':True,'reDeferredImmediatelyBeforeLedger':True})
        db=clone('catalog')
        setup(db)
        before=state(db,'catalog-before')
        original=helper.transaction(source,before)
        body=helper.transaction_body(source)
        anchor='\ndo $offboarding_version_conflict_transition$'
        assert original.count(body)==1 and body.count(anchor)==1
        position=original.index(body)+body.index(anchor)
        block='\ncreate domain public.vc_unknown as integer check(value>0);'
        injected=original[:position]+block+original[position:]
        assert injected.replace(block,'',1)==original
        native(db,injected,'catalog-fault',success=False)
        assert state(db,'catalog-after')==before
        finish_case({'case':'pre_transition_unknown_catalog','passed':True,'atomicRollback':True})
        db=clone('postcommit',control)
        native(db,'alter policy scoped_deny on vc_release_probe.sensitive using(true);','postcommit-policy-drift')
        changed=state(db,'postcommit-drift-state')
        rejected=False
        try:helper.verify_after(changed,captured,source,catalog)
        except SystemExit:rejected=True
        assert rejected
        finish_case({'case':'postcommit_readback_detection','passed':True,'rollbackClaimed':False,'detectionOnly':True})
        context = source_context(ROOT)
        clean_committed_apply = context['cleanCommittedApply']
        retain('source-context.json', context)
        if context.get('dirty'):
            args=['apply','--source-sha',source_sha,'--snapshot',str(evidence/'not-created-snapshot'),'--head',context['head'],'--helper-sha',helper.sha(RAW_HELPER)]
            stdout=io.StringIO()
            with patch.object(helper,'api',side_effect=AssertionError('Uncommitted source cannot call API')) as api,patch.object(helper,'query',side_effect=AssertionError('Uncommitted source cannot dispatch')) as query,contextlib.redirect_stdout(stdout):
                try:helper.main(args)
                except SystemExit as error:assert str(error)=='Release tree must be clean'
                else:raise AssertionError('Dirty source passed clean committed apply guard')
                assert api.call_count==query.call_count==0
            finish_case({'case':'actual_uncommitted_apply_blocked','passed':True,'cleanCommittedAcceptance':'BLOCKED_UNCOMMITTED_SOURCE','apiCalls':0,'sqlWrites':0})
    except BaseException as error:
        failure={'type':type(error).__name__,'message':str(error)}
        raise
    finally:
        for db in reversed(databases):command('dropdb',['-h',socket,'-p','55439','-U','postgres',db])
        if role_created:native(predecessor,'drop role '+role+';','drop-owned-role')
        cleanup=rows(native(predecessor,"begin read only;select jsonb_build_object('databasesAbsent',not exists(select 1 from pg_database where datname=any(array["+','.join(helper.literal(db) for db in databases)+"]::text[])),'roleAbsent',not exists(select 1 from pg_roles where rolname="+helper.literal(role)+"));rollback;",'cleanup-absent'))[0]
        cleanup['predecessorUnchanged']=state(predecessor,'original-after')==initial if initial is not None else None
        cleanup['sourcesUnchanged']=pins=={str(path.relative_to(ROOT)):helper.sha(path.read_bytes()) for path in paths}
        retain('result.json',{'status':'PASS' if failure is None else 'FAIL','failure':failure,'cases':cases,'caseCount':len(cases),'sourcePins':pins,'cleanup':cleanup,'syntheticOnly':True,'hostedAcceptance':False,'realAuthAcceptance':False,'cleanCommittedApply':clean_committed_apply,'providerCalled':False})
        retain('artifact-hashes.json',{str(path.relative_to(evidence)):{'sha256':helper.sha(path.read_bytes()),'bytes':path.stat().st_size} for path in sorted(evidence.rglob('*')) if path.is_file() and path.name!='artifact-hashes.json'})
        print(json.dumps({'evidence':str(evidence),'caseCount':len(cases),'cleanup':cleanup,'failure':failure,'cleanCommittedApply':clean_committed_apply}),flush=True)
        assert all(cleanup.values()),'Owned cleanup/source preservation differs'


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('socket')
    parser.add_argument('predecessor')
    parser.add_argument('prefix')
    parser.add_argument('--evidence-dir',type=Path)
    args=parser.parse_args()
    with patch('urllib.request.urlopen',side_effect=AssertionError('Focused native runner forbids network')):
        run(args.socket,args.predecessor,args.prefix,args.evidence_dir)
