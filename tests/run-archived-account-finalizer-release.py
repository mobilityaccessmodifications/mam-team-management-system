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
import time
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
HELPER_PATH=ROOT/'scripts/deploy-archived-account-finalizer.py'
spec=importlib.util.spec_from_file_location('archived_finalizer_native_release',HELPER_PATH)
assert spec is not None and spec.loader is not None
helper=importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def run(socket,predecessor,prefix,evidence_dir=None,head=None):
 socket=str(Path(socket).resolve())
 assert json.loads((Path(socket)/'mam-test-cluster.json').read_bytes())=={'owner':'mam-local-tests-v1','socket':socket,'port':55439}
 assert Path(socket).parent==Path(tempfile.gettempdir()).resolve()
 assert all(re.fullmatch('mam_test_[a-z0-9_]+',n) for n in (predecessor,prefix)) and len(prefix)<42
 env={'PATH':os.environ['PATH'],'TMPDIR':str(Path(socket).parent),'LANG':'C','LC_ALL':'C','PGPASSFILE':'/dev/null','PGSERVICEFILE':'/dev/null','PGCONNECT_TIMEOUT':'5','PYTHONDONTWRITEBYTECODE':'1'}
 evidence=Path(tempfile.mkdtemp(prefix='finalizer-native-',dir=evidence_dir or socket))
 paths=[helper.MIGRATION,HELPER_PATH,ROOT/'scripts/deploy-staff-leave-calendar.py',helper.PREDECESSOR,ROOT/'tests/archived-account-finalizer.sql',Path(__file__)]
 pins={str(p.relative_to(ROOT)):helper.sha(p.read_bytes()) for p in paths}
 for path in paths:
  captured=evidence/'executed-source'/path.relative_to(ROOT)
  captured.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  captured.write_bytes(path.read_bytes())
  captured.chmod(0o600)
 source=helper.candidate(pins[str(helper.MIGRATION.relative_to(ROOT))])
 databases=[]
 sequence=0
 results=[]
 commands=[]
 context_role='postgres'
 initial=None
 fault_role=prefix+'_role'
 role_created=False
 failure=None

 def retain(name,value):
  path=evidence/name
  path.write_text(json.dumps(value,indent=2,sort_keys=True)+'\n')
  path.chmod(0o600)

 def command(binary,args):
  r=subprocess.run([binary,*map(str,args)],env=env,text=True,capture_output=True,timeout=90)
  assert r.returncode==0,r.stderr
  return r.stdout

 def native(db,text,success=True,role='postgres'):
  nonlocal sequence
  sequence+=1
  path=evidence/('query-%03d.sql'%sequence)
  path.write_text(text)
  path.chmod(0o600)
  r=subprocess.run(['psql','-X','-h',socket,'-p','55439','-U',role,'-d',db,'-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-Atq','-f',str(path)],env=env,text=True,capture_output=True,timeout=90)
  log=evidence/('query-%03d.log'%sequence)
  log.write_text(r.stdout+r.stderr)
  log.chmod(0o600)
  commands.append({'sequence':sequence,'database':db,'executionRole':role,'querySha256':helper.sha(text.encode()),'queryFile':path.name,'logFile':log.name,'exit':r.returncode})
  retain('queries.json',commands)
  if success:
   assert r.returncode==0,'Native query %s failed; see retained log'%sequence
  else:
   assert r.returncode!=0 and '55000' in r.stderr,'Expected exact guarded 55000 rollback; see query %s'%sequence
  return r.stdout.strip() if success else r.stderr

 def state(db):
  return json.loads(native(db,"begin read only;set local search_path='';select "+helper.state_expression(source)+";rollback;"))

 def clone(suffix):
  db=prefix+'_'+suffix
  command('createdb',['-h',socket,'-p','55439','-U','postgres','--template='+predecessor,db])
  databases.append(db)
  present=int(native(db,"select count(*) from supabase_migrations.schema_migrations where version="+helper.literal(helper.PREDECESSOR_VERSION)+";"))
  assert present in (0,1)
  if not present:
   native(db,'insert into supabase_migrations.schema_migrations(version,name,statements) values('+helper.literal(helper.PREDECESSOR_VERSION)+','+helper.literal(helper.PREDECESSOR_NAME)+',ARRAY['+helper.literal(helper.PREDECESSOR.read_text())+']);')
  return db

 def anonymous_rows(db):
  return int(native(db,'begin read only;set local role anon;select count(*) from finalizer_probe.sensitive;rollback;',role=context_role))

 def regressions(db):
  baseline=state(db)
  for scenario in ('leaf','one-child'):
   text=(ROOT/'tests/archived-account-finalizer.sql').read_text().replace(" :'finalizer_scenario'::text scenario,"," '%s'::text scenario,"%scenario)
   frames=[json.loads(x) for x in native(db,text,role=context_role).splitlines() if x.startswith('{')]
   labels=[x['phase'] for x in frames]
   assert len(labels)==len(set(labels))
   assert sum(x.startswith('negative_') for x in labels)==17
   assert 'after_actual_finalise' in labels and 'after_idempotent_finalise' in labels and 'ordinary_login_control_finalised' in labels
   assert state(db)==baseline
   results.append({'case':'native_'+scenario,'passed':True,'negativeCases':17,'frames':frames,'rollbackReadbackEqual':True})
   print('PASS: native archived finalizer '+scenario+'; 17 exact negative boundaries, ordinary and idempotent controls')

 retain('source-pins.json',pins)
 try:
  initial=state(predecessor)
  observer=json.loads(native(predecessor,"begin read only;select jsonb_build_object('current',current_user,'session',session_user,'database',current_database(),'major',current_setting('server_version_num')::integer/10000,'superuser',rolsuper,'bypass',rolbypassrls,'socketOnly',inet_server_addr() is null and current_setting('listen_addresses')='','fixtureBootstrapExists',exists(select 1 from pg_roles where rolname='fixture_bootstrap')) from pg_roles where rolname=current_user;rollback;"))
  assert observer['current']==observer['session']=='postgres' and observer['socketOnly'] and observer['major'] in (16,17)
  context_role='fixture_bootstrap' if observer['fixtureBootstrapExists'] else 'postgres'
  assert observer['superuser'] or context_role=='fixture_bootstrap','Nonsuperuser fixture needs its separately authorised setup/context observer'
  retain('execution-identity.json',dict(observer,contexts='SET LOCAL ROLE authenticated/service_role from '+context_role,migrationExecution='postgres'))
  assert native(predecessor,"select count(*) from pg_roles where rolname="+helper.literal(fault_role)+";")=='0'
  native(predecessor,'create role '+fault_role+' nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication;')
  role_created=True
  base=clone('base')
  setup="create schema finalizer_probe;grant usage on schema finalizer_probe to anon,authenticated;create table finalizer_probe.sensitive(value integer);insert into finalizer_probe.sensitive values(1);grant select on finalizer_probe.sensitive to anon;alter table finalizer_probe.sensitive enable row level security;alter table finalizer_probe.sensitive force row level security;create policy scoped_deny on finalizer_probe.sensitive for select to anon using(false);"
  setup+="insert into supabase_migrations.schema_migrations(version,name,statements) values('19000101000001','synthetic_null_history',null),('19000101000002','synthetic_empty_history',array[]::text[]),('19000101000003','synthetic_zero_bound_history',array_fill('select 1;'::text,array[1],array[0]));"
  setup+="insert into auth.users(id,email,email_confirmed_at) values('a7300000-0000-4000-8000-000000000001','finalizer-preserve-actor@example.test',clock_timestamp());insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after) values('a7300000-0000-4000-8000-000000000001','Synthetic Preservation Actor','admin','finalizer-preserve-actor@example.test',clock_timestamp()-interval '1 day');"
  setup+="insert into private.confirmed_test_identity_purges(id,person_id,auth_user_id,actor_user_id,company_key,manifest_hash,manifest,retained_audit,retired_identifiers,phase,completed_at) values('a7300000-0000-4000-8001-000000000099','a7300000-0000-4000-8000-000000000099',null,'a7300000-0000-4000-8000-000000000001','mam',repeat('b',64),'{\"synthetic\":true}','{\"retained\":true}',array['a7300000-0000-4000-8000-000000000099']::uuid[],'complete',clock_timestamp());"
  native(base,setup)
  before=state(base)
  helper.validate_before(before,source)
  assert anonymous_rows(base)==0
  assert native(base,'begin;alter policy scoped_deny on finalizer_probe.sensitive using(true);set local role anon;select count(*) from finalizer_probe.sensitive;rollback;',role=context_role)=='1'
  assert state(base)==before and anonymous_rows(base)==0
  baseline_path=evidence/'before.json'
  helper.retain(baseline_path,before)
  captured=helper.load_json(baseline_path.read_bytes())
  transaction=helper.transaction(source,captured)
  (evidence/'exact-generated-transaction.sql').write_bytes(transaction.encode())
  attested=native(base,transaction)
  catalog=helper.resulting_catalog([{'archivedFinalizerResultingCatalogSha256':attested}])
  after=state(base)
  helper.verify_after(after,captured,source,catalog)
  assert anonymous_rows(base)==0
  retain('after.json',after)
  results.append({'case':'exact_generated_commit','passed':True,'querySha256':helper.sha(transaction.encode()),'snapshotSha256':helper.sha(baseline_path.read_bytes()),'catalogSha256':catalog,'independentReadbackVerified':True,'historicalRawArraysUnchanged':True,'businessAndReceiptsUnchanged':True,'allSchemaSecurityUnchanged':True})
  print('PASS: exact generated native COMMIT and independent full catalog/security/data/raw-ledger/receipt readback')
  regressions(base)

  race=prefix+'_race'
  command('createdb',['-h',socket,'-p','55439','-U','postgres','--template='+base,race])
  databases.append(race)
  regression=(ROOT/'tests/archived-account-finalizer.sql').read_text()
  archive_end="select pg_temp.diag_frame('after_actual_archive');"
  seed=regression[:regression.index(archive_end)+len(archive_end)]+'\ncommit;'
  native(race,seed,role=context_role)
  context="set local role postgres;select set_config('request.jwt.claim.sub','a7200000-0000-4000-8000-000000000001',true);select set_config('request.jwt.claim.role','authenticated',true);select set_config('request.jwt.claims',jsonb_build_object('sub','a7200000-0000-4000-8000-000000000001','role','authenticated','iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text,true);"
  finish="create temporary table finalizer_inputs as select change_token from private.portal_account_status_change_claims where auth_user_id='a7200000-0000-4000-8000-000000000002';grant select on finalizer_inputs to authenticated;set local role authenticated;select row_to_json(r) from public.finalise_portal_account_status_change('a7200000-0000-4000-8000-000000000002','a7200000-0000-4000-8000-000000000002',(select change_token from finalizer_inputs)) r;commit;"
  holder="set application_name='finalizer_holder';begin;"+context+"select private.lock_portal_role_actor();select pg_advisory_xact_lock(hashtextextended('portal_account:a7200000-0000-4000-8000-000000000002',0));"
  waiter="set application_name='finalizer_waiter';begin;"+context+finish
  for name,text in [('holder.sql',holder+'\n'+finish+'\n\\q\n'),('waiter.sql',waiter)]:
   (evidence/name).write_text(text)
  processes=[]
  streams=[]
  target=['psql','-X','-h',socket,'-p','55439','-U',context_role,'-d',race,'-v','ON_ERROR_STOP=1','-Atq']
  def observed(query):
   return native(race,'begin read only;set local statement_timeout=\'3s\';'+query+';rollback;',role=context_role)=='t'
  try:
   hlog=(evidence/'holder.log').open('w')
   streams.append(hlog)
   first=subprocess.Popen(target,env=env,text=True,stdin=subprocess.PIPE,stdout=hlog,stderr=subprocess.STDOUT)
   processes.append(first)
   assert first.stdin is not None
   first.stdin.write(holder+'\n')
   first.stdin.flush()
   deadline=time.monotonic()+5
   while not observed("select exists(select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.datname=current_database() and a.application_name='finalizer_holder' and l.locktype='advisory' and l.granted)"):
    assert time.monotonic()<deadline and first.poll() is None,'Owned finalizer holder did not acquire its real fences'
    time.sleep(0.05)
   wlog=(evidence/'waiter.log').open('w')
   streams.append(wlog)
   second=subprocess.Popen(target+['-f',str(evidence/'waiter.sql')],env=env,text=True,stdout=wlog,stderr=subprocess.STDOUT)
   processes.append(second)
   deadline=time.monotonic()+5
   while not observed("select exists(select 1 from pg_stat_activity where datname=current_database() and application_name='finalizer_waiter' and wait_event_type='Lock')"):
    assert time.monotonic()<deadline and second.poll() is None,'Competing native finalizer did not wait on the preserved fence'
    time.sleep(0.05)
   first.stdin.write(finish+'\n\\q\n')
   first.stdin.close()
   assert first.wait(timeout=10)==0 and second.wait(timeout=10)==0
  finally:
   for process in processes:
    if process.poll() is None:
     process.kill()
     process.wait(timeout=5)
   for stream in streams:
    stream.close()
  outputs=[]
  for name in ('holder.log','waiter.log'):
   rows=[json.loads(x) for x in (evidence/name).read_text().splitlines() if x.startswith('{"person_id"')]
   assert len(rows)==1 and rows[0]['account_status']=='disabled' and rows[0]['account_version']==2 and rows[0]['login_name'] is None
   outputs.append(rows[0])
  assert outputs[0]==outputs[1]
  committed=json.loads(native(race,"begin read only;select jsonb_build_object('claims',count(*),'finalised',bool_and(c.status='finalised' and c.provider_status='succeeded' and c.final_account_version=2),'profile',bool_and(f.account_status='disabled' and f.account_version=2 and f.login_name is null),'person',bool_and(not p.is_active and p.auth_user_id=f.id)) from private.portal_account_status_change_claims c join public.profiles f on f.id=c.auth_user_id join public.internal_org_people p on p.id=c.person_id where c.auth_user_id='a7200000-0000-4000-8000-000000000002';rollback;"))
  assert committed=={'claims':1,'finalised':True,'profile':True,'person':True}
  results.append({'case':'competing_finalizers_committed_idempotence','passed':True,'realLockWaitObserved':True,'sameReturnedRow':True,'committedReadback':committed,'sessions':2,'contextLogin':context_role})
  print('PASS: two real native finalizers serialize on preserved fences and commit one idempotent disabled result')

  final_anchor='\nset constraints all immediate;\nselect pg_temp.archived_finalizer_assert_delta();\ndo $archived_finalizer_release_final$'
  faults=[('external_policy', 'alter policy scoped_deny on finalizer_probe.sensitive using(true)'),('external_column_acl','grant update(value) on finalizer_probe.sensitive to anon'),('auth_schema_acl','grant create on schema auth to anon'),('role_attribute','alter role '+fault_role+' createdb'),('default_acl','alter default privileges for role postgres in schema finalizer_probe grant insert on tables to anon'),('finalizer_acl','revoke execute on function public.finalise_portal_account_status_change(uuid,uuid,uuid) from service_role'),('finalizer_config',"alter function public.finalise_portal_account_status_change(uuid,uuid,uuid) set statement_timeout='1s'"),('other_function',"create or replace function private.plan_employee_removal_reporting_splice(p_person_id uuid) returns jsonb language sql volatile security definer set search_path='' as 'select null::jsonb'"),('receipt',"update private.confirmed_test_identity_purges set retained_audit='{\"fault\":true}' where id='a7300000-0000-4000-8001-000000000099'"),('historical_null',"update supabase_migrations.schema_migrations set statements=array[]::text[] where version='19000101000001'"),('historical_bound',"update supabase_migrations.schema_migrations set statements=array_fill(statements[0],array[1],array[1]) where version='19000101000003'"),('target_bound',"update supabase_migrations.schema_migrations set statements=array_fill(statements[1],array[1],array[0]) where version='20261013081500'")]
  for index,(label,fault) in enumerate(faults):
   db=clone('fault'+str(index))
   native(db,setup)
   frame=state(db)
   q=helper.transaction(source,frame)
   assert q.count(final_anchor)==1
   injected=q.replace(final_anchor,'\n'+fault+';'+final_anchor,1)
   assert injected.replace('\n'+fault+';','',1)==q
   native(db,injected,success=False)
   assert state(db)==frame and anonymous_rows(db)==0
   results.append({'case':'late_'+label,'passed':True,'atomicRollback':True,'exactFaultFreeQuerySha256':helper.sha(q.encode()),'faultQuerySha256':helper.sha(injected.encode())})
   print('PASS: final-envelope atomic rollback '+label)

  for phase,anchor in [('pre_transition','\ndo $archived_finalizer_transition$'),('post_transition','\ndo $archived_finalizer_final$')]:
   db=clone(phase)
   frame=state(db)
   q=helper.transaction(source,frame)
   body=helper.transaction_body(source)
   assert q.count(body)==1 and body.count(anchor)==1
   offset=q.index(body)+body.index(anchor)
   fault="\ncreate domain public.finalizer_unknown as integer check(value>0);"
   injected=q[:offset]+fault+q[offset:]
   native(db,injected,success=False)
   assert state(db)==frame
   results.append({'case':phase+'_catalog','passed':True,'atomicRollback':True,'faultQuerySha256':helper.sha(injected.encode())})
   print('PASS: exact normalized full-catalog drift rejection '+phase)

  for suffix,fault in [('policy','alter policy scoped_deny on finalizer_probe.sensitive using(true)'),('auth_acl','grant create on schema auth to anon')]:
   db=clone('final_'+suffix)
   native(db,setup)
   frame=state(db)
   q=helper.transaction(source,frame)
   anchor='\ndo $archived_finalizer_release_final$'
   assert q.count(anchor)==1
   injected=q.replace(anchor,'\n'+fault+';'+anchor,1)
   assert injected.replace('\n'+fault+';','',1)==q
   native(db,injected,success=False)
   assert state(db)==frame and anonymous_rows(db)==0
   results.append({'case':'final_security_'+suffix,'passed':True,'atomicRollback':True,'afterCoreAndAfterLedger':True})
   print('PASS: complete final envelope security rejects '+suffix)

  db=clone('deferred')
  hook="create function supabase_migrations.finalizer_deferred_fault() returns trigger language plpgsql as $$begin if new.version='20261013081500' then grant create on schema auth to anon;end if;return new;end$$;create constraint trigger finalizer_deferred_fault after insert on supabase_migrations.schema_migrations deferrable initially deferred for each row execute function supabase_migrations.finalizer_deferred_fault();"
  native(db,hook)
  frame=state(db)
  q=helper.transaction(source,frame)
  ledger_anchor='\ninsert into supabase_migrations.schema_migrations(version,name,statements)'
  assert q.count(ledger_anchor)==1
  injected=q.replace(ledger_anchor,'\nset constraints supabase_migrations.finalizer_deferred_fault deferred;'+ledger_anchor,1)
  native(db,injected,success=False)
  assert state(db)==frame
  results.append({'case':'deferred_ledger_privilege','passed':True,'atomicRollback':True,'reDeferredImmediatelyBeforeLedger':True})
  print('PASS: actual deferred ledger effect drained and atomically rejected')

  drift=prefix+'_postcommit'
  command('createdb',['-h',socket,'-p','55439','-U','postgres','--template='+base,drift])
  databases.append(drift)
  native(drift,'alter policy scoped_deny on finalizer_probe.sensitive using(true);')
  actual=state(drift)
  assert actual['securityHash']!=after['securityHash'] and anonymous_rows(drift)==1
  try:
   helper.verify_after(actual,captured,source,catalog)
  except SystemExit:
   detected=True
  else:
   detected=False
  assert detected,'Post-COMMIT policy drift must fail independent readback'
  results.append({'case':'postcommit_policy_readback_denial','passed':True,'postCommitDetectionOnly':True,'rollbackClaimed':False,'anonymousRowsUnderCommittedFixtureFault':1})
  print('PASS: committed synthetic policy drift detected by independent verifier; detection only, no rollback claim')

  if head is not None:
   db=clone('entry')
   snap=evidence/'entry-before.json'
   helper.retain(snap,state(db))
   expected=helper.transaction(source,helper.load_json(snap.read_bytes()))
   receipt=evidence/'entry-attestation.json'
   dispatch=evidence/'entry-dispatch.json'
   writes=[]
   stdout=io.StringIO()
   def fixture_query(query):
    if query.startswith('begin read only;'):
     return [{'state':json.loads(native(db,query))}]
    assert query==expected,'Actual apply bytes differ from exact frozen public builder'
    writes.append(helper.sha(query.encode()))
    return [{'archivedFinalizerResultingCatalogSha256':native(db,query)}]
   args=['apply','--source-sha',pins[str(helper.MIGRATION.relative_to(ROOT))],'--snapshot',str(snap),'--snapshot-sha',helper.sha(snap.read_bytes()),'--head',head,'--helper-sha',pins[str(HELPER_PATH.relative_to(ROOT))],'--attestation',str(receipt),'--dispatch',str(dispatch)]
   try:
    with patch.object(helper,'api',return_value={'id':helper.PROJECT,'organization_id':helper.ORGANISATION}),patch.object(helper,'query',side_effect=fixture_query),contextlib.redirect_stdout(stdout):
     helper.main(args)
     assert len(writes)==1
     helper.main(args+['--attestation-sha',helper.sha(receipt.read_bytes())])
     assert len(writes)==1
   finally:
    (evidence/'entry-stdout.log').write_text(stdout.getvalue())
    retain('entry-dispatches.json',writes)
   results.append({'case':'clean_committed_apply_entrypoint','passed':True,'providerTransport':'synthetic native only','querySha256':writes[0],'writeCount':1,'replayReadOnly':True})

  native(predecessor,'drop role '+fault_role+';')
  role_created=False
  assert state(predecessor)==initial
  assert pins=={str(p.relative_to(ROOT)):helper.sha(p.read_bytes()) for p in paths}
  retain('result.json',{'status':'PASS','major':observer['major'],'sourcePins':pins,'cases':results,'syntheticOnly':True,'liveProviderCalled':False,'cleanCommittedApply':'PASS' if head else 'BLOCKED_UNCOMMITTED_SOURCE','hostedAcceptance':'NOT_RUN','predecessorUnchanged':True})
  print(json.dumps({'evidence':str(evidence),'cases':len(results),'faults':len(faults)+5,'major':observer['major'],'syntheticOnly':True,'cleanCommittedApply':'PASS' if head else 'BLOCKED_UNCOMMITTED_SOURCE'}))
 except BaseException as exc:
  failure={'type':type(exc).__name__,'message':str(exc)}
  raise
 finally:
  for db in reversed(databases):
   command('dropdb',['-h',socket,'-p','55439','-U','postgres',db])
  if role_created:
   native(predecessor,'drop role '+fault_role+';')
   role_created=False
  absent=not any(native(predecessor,"select count(*) from pg_database where datname="+helper.literal(db)+";")!='0' for db in databases)
  retain('cleanup.json',{'ownedClonesDropped':absent,'originalPreserved':state(predecessor)==initial if initial is not None else None})
  retain('completion.json',{'error':failure,'completedCases':results,'sourcePins':pins,'syntheticOnly':True,'cleanCommittedApply':'BLOCKED_UNCOMMITTED_SOURCE' if head is None else 'SEE_ENTRY_EVIDENCE'})
  retain('artifact-hashes.json',{str(p.relative_to(evidence)):{'sha256':helper.sha(p.read_bytes()),'bytes':p.stat().st_size} for p in evidence.rglob('*') if p.is_file() and p.name!='artifact-hashes.json'})


def run_settings(socket,predecessor,prefix,evidence_dir):
 socket=str(Path(socket).resolve())
 assert json.loads((Path(socket)/'mam-test-cluster.json').read_bytes())=={'owner':'mam-local-tests-v1','socket':socket,'port':55439}
 assert Path(socket).parent==Path(tempfile.gettempdir()).resolve()
 assert all(re.fullmatch('mam_test_[a-z0-9_]+',n) for n in (predecessor,prefix)) and len(prefix)<35
 assert evidence_dir is not None
 evidence=Path(tempfile.mkdtemp(prefix='settings-native-',dir=evidence_dir))
 env={'PATH':os.environ['PATH'],'TMPDIR':str(Path(socket).parent),'LANG':'C','LC_ALL':'C','PGPASSFILE':'/dev/null','PGSERVICEFILE':'/dev/null','PGCONNECT_TIMEOUT':'5','PYTHONDONTWRITEBYTECODE':'1'}
 paths=[helper.MIGRATION,HELPER_PATH,ROOT/'scripts/deploy-staff-leave-calendar.py',helper.PREDECESSOR,Path(__file__)]
 pins={str(p.relative_to(ROOT)):helper.sha(p.read_bytes()) for p in paths}
 for path in paths:
  target=evidence/'executed-source'/path.relative_to(ROOT)
  target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  target.write_bytes(path.read_bytes())
  target.chmod(0o600)
 source=helper.candidate(pins[str(helper.MIGRATION.relative_to(ROOT))])
 role=prefix+'_login'
 databases=[]
 created=False
 initial=None
 initial_settings=None
 commands=[]
 cases=[]
 failure=None

 def retain(name,value):
  target=evidence/name
  target.write_text(json.dumps(value,indent=2,sort_keys=True)+'\n')
  target.chmod(0o600)

 def command(binary,args):
  result=subprocess.run([binary,*map(str,args)],env=env,capture_output=True,text=True,timeout=90)
  assert result.returncode==0,'Owned fixture command failed'

 def native(db,text,login='postgres'):
  sequence=len(commands)+1
  path=evidence/('query-%03d.sql'%sequence)
  path.write_bytes(text.encode())
  path.chmod(0o600)
  execution_env=dict(env,PGOPTIONS='-c default_transaction_read_only=off') if login=='postgres' else env
  result=subprocess.run(['psql','-X','-h',socket,'-p','55439','-U',login,'-d',db,'-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-Atq','-f',str(path)],env=execution_env,capture_output=True,text=True,timeout=90)
  for suffix,value in [('stdout',result.stdout),('stderr',result.stderr)]:
   target=evidence/('query-%03d.%s'%(sequence,suffix))
   target.write_text(value)
   target.chmod(0o600)
  commands.append({'sequence':sequence,'database':db,'login':login,'exit':result.returncode,'querySha256':helper.sha(text.encode())})
  retain('commands.json',commands)
  return result

 def checked(db,text,login='postgres'):
  result=native(db,text,login)
  assert result.returncode==0,'Native settings query failed; see retained command %s'%len(commands)
  return result.stdout.strip()

 def state(db):
  with patch.object(helper,'query',side_effect=lambda text:[{'state':json.loads(checked(db,text))}]):
   return helper.read_state(source)

 def setting_hash(db):
  return checked(db,"begin read only;select encode(extensions.digest(coalesce(jsonb_agg((to_jsonb(s)-'setconfig')||jsonb_build_object('configSha256',encode(extensions.digest(coalesce(s.setconfig::text,'<NULL>'),'sha256'),'hex')) order by s.setdatabase,s.setrole),'[]')::text,'sha256'),'hex') from pg_db_role_setting s;rollback;")

 def fresh(db):
  return checked(db,'show default_transaction_read_only;',role)

 def clone(label):
  db=prefix+'_'+label
  command('createdb',['-h',socket,'-p','55439','-U','postgres','--template='+predecessor,db])
  databases.append(db)
  present=checked(db,'select count(*) from supabase_migrations.schema_migrations where version='+helper.literal(helper.PREDECESSOR_VERSION)+';')
  assert present in ('0','1')
  if present=='0':
   checked(db,'insert into supabase_migrations.schema_migrations(version,name,statements) values('+helper.literal(helper.PREDECESSOR_VERSION)+','+helper.literal(helper.PREDECESSOR_NAME)+',ARRAY['+helper.literal(helper.PREDECESSOR.read_text())+']);')
  return db

 def setup(db,scope):
  if scope=='role_database':
   checked(db,'alter role '+role+' in database '+db+' set default_transaction_read_only=on;')
  elif scope=='database_default':
   checked(db,'alter database '+db+' set default_transaction_read_only=on;')
  elif scope=='global_role':
   checked(db,'alter role '+role+' set default_transaction_read_only=on;')
  if scope!='empty':
   assert fresh(db)=='on'

 def fault(db,scope,operation):
  base='alter role '+role+' in database '+db if scope=='role_database' else 'alter database '+db if scope=='database_default' else 'alter role '+role
  return base+(' reset default_transaction_read_only' if operation=='delete' else ' set default_transaction_read_only=off')+';'

 def release(db,frame):
  snap=evidence/(db+'-before.json')
  helper.retain(snap,frame)
  captured=helper.load_json(snap.read_bytes())
  text=helper.transaction(source,captured)
  (evidence/(db+'-generated.sql')).write_bytes(text.encode())
  return captured,text

 def inject(text,anchor,block):
  assert text.count(anchor)==1
  position=text.index(anchor)
  actual=text[:position]+block+text[position:]
  assert actual[:position]+actual[position+len(block):]==text
  return actual

 try:
  identity=json.loads(checked(predecessor,"begin read only;select jsonb_build_object('current',current_user,'session',session_user,'database',current_database(),'major',current_setting('server_version_num')::integer/10000,'superuser',rolsuper,'socketOnly',inet_server_addr() is null and current_setting('listen_addresses')='') from pg_roles where rolname=current_user;rollback;"))
  assert identity['current']==identity['session']=='postgres' and not identity['superuser'] and identity['socketOnly'] and identity['major'] in (16,17)
  retain('identity.json',identity)
  initial=state(predecessor)
  initial_settings=setting_hash(predecessor)
  assert checked(predecessor,'select count(*) from pg_roles where rolname='+helper.literal(role)+';')=='0'
  checked(predecessor,'create role '+role+' login nosuperuser nobypassrls nocreatedb nocreaterole noreplication;')
  created=True
  anchor='\ndo $archived_finalizer_release_final$'
  for scope in ('role_database','database_default','global_role','empty'):
   db=clone('control_'+scope)
   setup(db,scope)
   before=state(db)
   settings=setting_hash(db)
   captured,text=release(db,before)
   catalog=helper.resulting_catalog([{'archivedFinalizerResultingCatalogSha256':checked(db,text)}])
   after=state(db)
   helper.verify_after(after,captured,source,catalog)
   assert setting_hash(db)==settings
   assert fresh(db)==('off' if scope=='empty' else 'on')
   retain(db+'-after.json',after)
   cases.append({'case':'control_'+scope,'passed':True,'commit':True,'independentReadback':True,'freshReadOnly':fresh(db),'querySha256':helper.sha(text.encode()),'settingsSha256':settings})
   if scope=='global_role':
    checked(db,'alter role '+role+' reset default_transaction_read_only;')
  for scope in ('role_database','database_default'):
   for operation in ('change','add','delete'):
    db=clone(scope+'_'+operation)
    setup(db,scope if operation!='add' else 'empty')
    before=state(db)
    settings=setting_hash(db)
    effective=fresh(db)
    captured,text=release(db,before)
    block='\n'+fault(db,scope,operation)
    actual=inject(text,anchor,block)
    result=native(db,actual)
    after=state(db)
    detected=False
    if result.returncode==0:
     catalog=helper.resulting_catalog([{'archivedFinalizerResultingCatalogSha256':result.stdout.strip()}])
     try:
      helper.verify_after(after,captured,source,catalog)
     except SystemExit:
      detected=True
    row={'case':scope+'_'+operation,'passed':result.returncode!=0 and '55000' in result.stderr and after==before and setting_hash(db)==settings and fresh(db)==effective,'exit':result.returncode,'sqlstate55000':'55000' in result.stderr,'atomicRollback':after==before,'settingsRestored':setting_hash(db)==settings,'freshBefore':effective,'freshAfter':fresh(db),'independentVerifierRejected':detected,'querySha256':helper.sha(actual.encode()),'baseQuerySha256':helper.sha(text.encode()),'removingOnlyFaultRestoresExactQuery':True}
    cases.append(row)
    retain('cases.json',cases)
    assert row['passed'],'pg_db_role_setting fault committed or escaped atomic rollback: '+row['case']
   for phase in ('core','deferred','postcommit'):
    db=clone(scope+'_'+phase)
    setup(db,scope)
    if phase=='deferred':
     hook="create function supabase_migrations.finalizer_settings_fault() returns trigger language plpgsql as $$begin if new.version='20261013081500' then execute "+helper.literal(fault(db,scope,'change'))+";end if;return new;end$$;create constraint trigger finalizer_settings_fault after insert on supabase_migrations.schema_migrations deferrable initially deferred for each row execute function supabase_migrations.finalizer_settings_fault();"
     checked(db,hook)
    before=state(db)
    settings=setting_hash(db)
    captured,text=release(db,before)
    if phase=='postcommit':
     catalog=helper.resulting_catalog([{'archivedFinalizerResultingCatalogSha256':checked(db,text)}])
     after=state(db)
     helper.verify_after(after,captured,source,catalog)
     checked(db,fault(db,scope,'change'))
     actual=state(db)
     detected=False
     try:
      helper.verify_after(actual,captured,source,catalog)
     except SystemExit:
      detected=True
     row={'case':scope+'_'+phase,'passed':detected and actual['securityHash']!=after['securityHash'] and setting_hash(db)!=settings and fresh(db)=='off','independentReadbackRejected':detected,'postCommitDetectionOnly':True,'rollbackClaimed':False,'freshAfter':'off','querySha256':helper.sha(text.encode())}
    else:
     if phase=='core':
      body=helper.transaction_body(source)
      core_anchor='\nset constraints all immediate;\nselect pg_temp.archived_finalizer_assert_delta();'
      assert body.count(core_anchor)==2 and text.count(body)==1
      position=text.index(body)+body.index(core_anchor)
      block='\n'+fault(db,scope,'change')
      actual=text[:position]+block+text[position:]
      assert actual[:position]+actual[position+len(block):]==text
     else:
      ledger='\ninsert into supabase_migrations.schema_migrations(version,name,statements)'
      actual=inject(text,ledger,'\nset constraints supabase_migrations.finalizer_settings_fault deferred;')
     result=native(db,actual)
     row={'case':scope+'_'+phase,'passed':result.returncode!=0 and '55000' in result.stderr and state(db)==before and setting_hash(db)==settings and fresh(db)=='on','atomicRollback':state(db)==before,'sqlstate55000':'55000' in result.stderr,'deferredRearmedImmediatelyBeforeLedger':phase=='deferred','querySha256':helper.sha(actual.encode()),'baseQuerySha256':helper.sha(text.encode()),'removingOnlyFaultRestoresExactQuery':True}
    cases.append(row)
    retain('cases.json',cases)
    assert row['passed'],'Settings boundary did not reject: '+row['case']
  assert len(cases)==16 and len({row['case'] for row in cases})==16
  assert pins=={str(p.relative_to(ROOT)):helper.sha(p.read_bytes()) for p in paths}
 except BaseException as exc:
  failure={'type':type(exc).__name__,'message':str(exc)}
  raise
 finally:
  for db in reversed(databases):
   command('dropdb',['-h',socket,'-p','55439','-U','postgres',db])
  if created:
   checked(predecessor,'drop role '+role+';')
  cleanup={'ownedDatabasesAbsent':all(checked(predecessor,'select count(*) from pg_database where datname='+helper.literal(db)+';')=='0' for db in databases),'ownedRoleAbsent':checked(predecessor,'select count(*) from pg_roles where rolname='+helper.literal(role)+';')=='0','predecessorUnchanged':state(predecessor)==initial if initial is not None else None,'settingsRestored':setting_hash(predecessor)==initial_settings if initial is not None else None}
  retain('result.json',{'status':'PASS' if failure is None else 'FAIL','failure':failure,'sourcePins':pins,'cases':cases,'caseCount':len(cases),'cleanup':cleanup,'syntheticOnly':True,'providerCalled':False,'rawSettingValuesExported':False})
  retain('artifact-hashes.json',{str(p.relative_to(evidence)):{'sha256':helper.sha(p.read_bytes()),'bytes':p.stat().st_size} for p in evidence.rglob('*') if p.is_file() and p.name!='artifact-hashes.json'})
  print(json.dumps({'evidence':str(evidence),'caseCount':len(cases),'status':'PASS' if failure is None else 'FAIL','cleanup':cleanup}))


if __name__=='__main__':
 parser=argparse.ArgumentParser()
 parser.add_argument('socket')
 parser.add_argument('predecessor')
 parser.add_argument('prefix')
 parser.add_argument('--evidence-dir',type=Path)
 parser.add_argument('--head')
 parser.add_argument('--settings-only',action='store_true')
 args=parser.parse_args()
 if args.settings_only:
  assert args.head is None
  run_settings(args.socket,args.predecessor,args.prefix,args.evidence_dir)
 else:
  run(args.socket,args.predecessor,args.prefix,args.evidence_dir,args.head)
