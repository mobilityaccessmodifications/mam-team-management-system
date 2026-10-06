import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { command, createDatabase, sql, target, postgresEnv } from '../scripts/local-test-postgres.mjs';
import { loadModule } from './helpers/contact-lifetime-harness.mjs';

const [socket, group = 'all', evidenceName = 'native_'+process.pid] = process.argv.slice(2);
assert.ok(['all','core','authority','routines'].includes(group));
assert.match(evidenceName,/^[a-z0-9_-]+$/);
const evidenceDir = path.join('output/onboarding-review-fixes',evidenceName);
assert.equal(existsSync(evidenceDir),false,'Never overwrite historical test evidence');
mkdirSync(evidenceDir,{recursive:true});
const prefix = 'mam_test_onboarding_review_'+process.pid+'_';
target(socket,prefix+'ownership');
const migration = 'supabase/migrations/20261006105000_onboarding_credential_review.sql';
const source = readFileSync(migration, 'utf8');
const predecessor = prefix+'predecessor';
const history = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql') && f < path.basename(migration)).sort();
const inputs = [migration, 'tests/run-onboarding-review-sql.mjs', 'tests/onboarding-review.sql', 'tests/onboarding-review-setup.sql',
  'src/app/onboarding-review/actions.ts', 'scripts/local-test-postgres.mjs',
  'tests/helpers/contact-lifetime-harness.mjs', ...history.map(f => 'supabase/migrations/'+f),
  ...['0001-supabase-platform.sql', 'operator-session-platform.sql', 'canonical-roles-storage-platform.sql',
    'canonical-roles-hosted-member-predecessor.sql', 'canonical-roles-release-plan.sql', 'canonical-roles-release-readback.sql'].map(f => 'tests/migrations/'+f)];
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const beforeSources = inputs.map(file => ({ file, sha256: sha(file) }));
const results = [], sessions = new Set(), databases = new Set(), executions = [], processEvidence = [], lockEvidence = [], snapshotEvidence = [];
let sequence = 0;
const actor = '73000000-0000-4000-8000-000000000001';
const otherActor = '73000000-0000-4000-8000-000000000002';
const person = '74000000-0000-4000-8000-000000000006';
const stamp = '2026-10-01T05:00:00.123456+00:00';
const literal = value => "'"+String(value).replaceAll("'", "''")+"'";
const record = label => { results.push(label); console.log('PASS: '+label); };
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))+end.length);
const collector = extract('create function pg_temp.onboarding_review_catalog()', '$catalog$;');
const stateCollector = extract('create function pg_temp.onboarding_review_state()', '$state$;');
function snapshot(database) {
  const value = JSON.parse(sql(socket, database, `begin; set local search_path=''; ${collector}\n${stateCollector}
    select jsonb_build_object('catalog', (select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(c)
      order by kind collate "C",object_identity collate "C"),'[]'::jsonb)::text,'sha256'),'hex') from pg_temp.onboarding_review_catalog() c),
      'actual',private.confirmed_test_purge_schema_hash(),'stored',(select schema_hash from private.confirmed_test_purge_schema),
      'state',pg_temp.onboarding_review_state()); rollback;`).trim());
  snapshotEvidence.push({database,...value});
  return value;
}
const protectedStateSQL = `select encode(extensions.digest(jsonb_build_object(
  'credentials',(select jsonb_agg(to_jsonb(c) order by id) from private.employee_onboarding_credentials c),
  'events',(select jsonb_agg(to_jsonb(e) order by id) from private.employee_onboarding_credential_events e),
  'receipts',(select jsonb_agg(to_jsonb(r) order by event_key) from private.notification_delivery_receipts r),
  'purges',(select jsonb_agg(to_jsonb(r) order by id) from private.confirmed_test_identity_purges r),
  'auth',(select jsonb_agg(to_jsonb(u) order by id) from auth.users u),
  'profiles',(select jsonb_agg(to_jsonb(p) order by id) from public.profiles p),
  'people',(select jsonb_agg(to_jsonb(p) order by id) from public.internal_org_people p))::text,'sha256'),'hex')`;
function protectedDigest(database) {
  return sql(socket,database,protectedStateSQL+';').trim();
}
function clone(label, template = predecessor) {
  assert.match(label,/^[a-z0-9_]+$/);
  assert.ok(databases.has(template),'Only a database created by this run may be cloned');
  const database = prefix+label;
  assert.ok(database.length<=63,'Owned database name must fit PostgreSQL without truncation');
  assert.equal(databaseExists(database),false,'New owned database name must be absent');
  command('createdb', ['-h',socket,'-p','55439','-U','postgres','--template='+template,database]);
  databases.add(database);
  return database;
}
function runSource(database, input = source) {
  const inputFile = path.join(evidenceDir,'migration-'+executions.length+'.sql');
  writeFileSync(inputFile,input);
  const execution = {database,inputFile,sha256:createHash('sha256').update(input).digest('hex')};
  executions.push(execution);
  try {
    const output = command('psql', [...target(socket,database),'-v','VERBOSITY=verbose','-Atq'], { input, maxBuffer: 16*1024*1024 });
    execution.exit=0; return output;
  } catch (error) {
    execution.exit=Number(error.message.match(/exit=(\d+)/)?.[1]);
    execution.error=error.message; throw error;
  }
}
function databaseExists(database) {
  return command('psql',['-X','-h',socket,'-p','55439','-U','postgres','-d','postgres','-Atq','-v','ON_ERROR_STOP=1',
    '-c',`select exists(select 1 from pg_database where datname=${literal(database)});`]).trim()==='t';
}
function claims(user = actor, role = 'authenticated') {
  return `set local role ${role}; do $claims$ begin
    perform set_config('request.jwt.claim.sub',${literal(user)},true);
    perform set_config('request.jwt.claim.role',${literal(role)},true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',${literal(user)},'iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text,true);
  end $claims$;`;
}
function session(database, statement, { user = actor, role = 'authenticated', hold = false } = {}) {
  const app = `onboarding_review_${process.pid}_${++sequence}`;
  const child = spawn('psql', [...target(socket,database),'-Atq'], { env: {...postgresEnv,PGAPPNAME:app}, stdio:['pipe','pipe','pipe'] });
  sessions.add(child);
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  const input = `\\set VERBOSITY verbose\nbegin; set local statement_timeout='8s'; ${claims(user,role)}\n${statement}\n`;
  const receipt = {database,app,pid:child.pid};
  const inputHash=createHash('sha256');
  const track=chunk=>{ if(chunk!==undefined && chunk!==null) { inputHash.update(chunk); receipt.input_sha256=inputHash.copy().digest('hex'); } };
  const originalWrite=child.stdin.write.bind(child.stdin), originalEnd=child.stdin.end.bind(child.stdin);
  child.stdin.write=(chunk,...args)=>{ track(chunk); return originalWrite(chunk,...args); };
  child.stdin.end=(chunk,...args)=>{ track(chunk); return originalEnd(chunk,...args); };
  processEvidence.push(receipt);
  const done = new Promise((resolve,reject) => { child.on('error',reject); child.on('close',code => { sessions.delete(child); receipt.exit=code; receipt.error=error; resolve({code,output,error}); }); });
  child.stdin.write(input);
  if (!hold) child.stdin.end('commit;\n');
  return {app,child,done,output:()=>output};
}
async function until(condition, label) {
  const deadline = Date.now()+6000;
  while (!condition()) { if (Date.now()>deadline) throw new Error('Timeout: '+label); await delay(20); }
}
const waitForLock = async (database, process) => {
  await until(() => sql(socket,database,
    `select wait_event_type from pg_stat_activity where application_name=${literal(process.app)};`).trim()==='Lock',process.app+' observable lock wait');
  const lock = JSON.parse(sql(socket,database,`select jsonb_build_object('pid',pid,'wait_event_type',wait_event_type,
    'wait_event',wait_event,'blockers',pg_blocking_pids(pid)) from pg_stat_activity where application_name=${literal(process.app)};`).trim());
  assert.equal(lock.wait_event_type,'Lock'); assert.ok(lock.blockers.length>0);
  lockEvidence.push({database,app:process.app,...lock});
};
const delivery = database => sql(socket,database,`select id from private.employee_onboarding_credentials where person_id=${literal(person)};`).trim();
const cancel = id => `select public.cancel_onboarding_credential_review(${literal(id)},${literal(stamp)}::timestamptz);`;
let completed = false;
try {
  assert.equal(databaseExists(predecessor),false,'Never reuse or reset an existing database');
  createDatabase(socket, predecessor); databases.add(predecessor);
  sql(socket,predecessor,readFileSync('tests/migrations/0001-supabase-platform.sql','utf8'));
  for (const file of history) {
    if (file==='20261003090000_payroll_operator_session_proof.sql') {
      sql(socket,predecessor,readFileSync('tests/migrations/operator-session-platform.sql','utf8'));
      sql(socket,predecessor,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;');
    }
    if (file==='20261006104000_unified_portal_roles.sql') {
      for (const fixture of ['canonical-roles-storage-platform.sql','canonical-roles-hosted-member-predecessor.sql']) sql(socket,predecessor,readFileSync('tests/migrations/'+fixture,'utf8'));
      sql(socket,predecessor,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;');
      command('psql',[...target(socket,predecessor),'-f','tests/migrations/canonical-roles-release-plan.sql',
        '-f','supabase/migrations/'+file,'-f','tests/migrations/canonical-roles-release-readback.sql']);
    } else sql(socket,predecessor,readFileSync('supabase/migrations/'+file,'utf8'));
  }
  sql(socket,predecessor,readFileSync('tests/onboarding-review-setup.sql','utf8'));
  const baseline = snapshot(predecessor);
  assert.equal(baseline.actual,baseline.stored);
  record(`all ${history.length} byte-preserved predecessors replay with the checked-in synthetic role-release inputs`);
  const positive = clone('positive');
  runSource(positive);
  const after = snapshot(positive);
  assert.equal(after.state,baseline.state);
  assert.equal(after.actual,after.stored);
  command('psql',[...target(socket,positive),'-f','tests/onboarding-review.sql']);
  record('positive actual RPC authorization, safe metadata, microsecond CAS, actor audit, unchanged receipts/Auth/accounts and no resend');

  if (group==='all' || group==='authority') {
    const failures=[];
    for (const operation of ['list','cancel']) for (const change of ['demotion','disabled','legitimate']) {
      const database=clone(operation+'_'+change,positive);
      sql(socket,database,`insert into public.internal_org_people(id,full_name,node_kind,company_key,position_title,auth_user_id,started_date)
        values('75000000-0000-4000-8000-000000000001','Synthetic linked privileged reviewer','person','mam','Synthetic tester',${literal(actor)},current_date+1);`);
      const revoker=session(database,"select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0)); select 'HELD';",{user:otherActor,role:'postgres',hold:true});
      await until(()=>revoker.output().includes('HELD'),'authority '+operation+' '+change+' fence');
      const queued=session(database,operation==='list' ? "select count(*) from public.list_onboarding_credential_reviews();" : cancel(delivery(database)));
      await waitForLock(database,queued);
      assert.equal(lockEvidence.at(-1).wait_event,'advisory','The caller must actually wait at the held role-control advisory fence');
      if (change==='demotion') revoker.child.stdin.write(`update public.profiles set app_role='admin' where id=${literal(actor)};\n`);
      if (change==='disabled') revoker.child.stdin.write(`update public.profiles set account_status='disabled',disabled_at=clock_timestamp() where id=${literal(actor)};\n`);
      revoker.child.stdin.write(`select 'PROTECTED:'||(${protectedStateSQL}); select 'CHANGED';\n`);
      await until(()=>revoker.output().includes('CHANGED'),'authority mutation before release');
      const beforeProtected=revoker.output().match(/PROTECTED:([a-f0-9]{64})/)?.[1];
      assert.ok(beforeProtected,'Writer must bind exact post-role-change/pre-RPC state before releasing the authority fence');
      const before=snapshot(database);
      revoker.child.stdin.end('commit;\n');
      const changed=await revoker.done; assert.equal(changed.code,0,changed.error);
      const result=await queued.done;
      const after=snapshot(database);
      const afterProtected=protectedDigest(database);
      const policy=await session(database,'select app_role,account_status,is_super_admin from public.get_portal_role_capabilities();').done;
      const finalState={operation,change,database,result,before,after,policy,protected_before:beforeProtected,protected_after:afterProtected};
      writeFileSync(path.join(evidenceDir,operation+'-'+change+'.json'),JSON.stringify(finalState,null,2));
      try {
        if (change==='legitimate') {
          assert.equal(result.code,0,result.error);
          assert.equal(result.output.trim(),operation==='list' ? '2' : 't');
          if (operation==='list') assert.deepEqual(after,before);
          else assert.equal(sql(socket,database,`select count(*) from private.employee_onboarding_credential_events where event_type='review_cancelled';`).trim(),'1');
        } else {
          assert.notEqual(result.code,0,operation+' '+change+' must refuse after the observable authority wait');
          assert.match(result.error,/42501:/); assert.equal(result.output.trim(),'','No disclosure on denied list');
          assert.equal(afterProtected,beforeProtected,'Denied operation must preserve credential/event/Auth/people/receipt rows');
          assert.equal(after.catalog,before.catalog); assert.equal(after.actual,before.actual); assert.equal(after.stored,before.stored);
          assert.equal(sql(socket,database,`select status from private.employee_onboarding_credentials where person_id=${literal(person)};`).trim(),'needs_review');
          assert.equal(sql(socket,database,"select count(*) from private.employee_onboarding_credential_events where event_type='review_cancelled';").trim(),'0');
        }
        if (change==='demotion') { assert.equal(policy.code,0,policy.error); assert.equal(policy.output.trim(),'admin|active|f'); }
        if (change==='legitimate') { assert.equal(policy.code,0,policy.error); assert.equal(policy.output.trim(),'system_admin|active|t'); }
        if (change==='disabled') { assert.notEqual(policy.code,0); assert.match(policy.error,/42501:/); }
        record(operation+' '+change+' after real role-control wait preserves ordinary policy and exact protected outcome');
      } catch(error) { failures.push(error); console.error('FAIL: '+operation+' '+change+': '+error.message); }
    }
    assert.equal(failures.length,0,failures.map(e=>e.message).join('\n'));
  }

  if (group==='all' || group==='routines') {
    const failures=[];
    const firstBoundary='set constraints all immediate;\nselect pg_temp.assert_onboarding_review_transition();';
    const refreshBoundary='end;\n$review_refresh$;';
    const routineFaults=[
      ['procedure', "create procedure private.unreviewed_review_marker() language sql as $$ select 1; $$;"],
      ['aggregate', "create aggregate private.unreviewed_review_marker(integer) (sfunc=pg_catalog.int4pl,stype=integer,initcond='0');"],
      ['window', "create function private.unreviewed_review_marker() returns bigint language internal window as 'window_row_number';"],
    ];
    for (const [kind,ddl] of routineFaults) for (const phase of ['initial','pre','post','deferred']) {
      const database=clone(phase+'_'+kind);
      const fault=ddl+` do $null_acl$ begin assert (select proacl is null from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='private' and p.proname='unreviewed_review_marker'),'Default NULL ACL is required for the regression'; end $null_acl$;`;
      let input=source;
      if (phase==='initial') input=source.replace('do $review_before$',()=>fault+'\ndo $review_before$');
      if (phase==='pre') input=source.replace(firstBoundary,()=>fault+'\n'+firstBoundary);
      if (phase==='post') input=source.replace(refreshBoundary,()=>refreshBoundary+'\n'+fault);
      if (phase==='deferred') {
        sql(socket,database,`create schema review_fixture;
          create function review_fixture.late_routine() returns trigger language plpgsql as $late$
            begin if current_setting('mam.review_fault',true)='on' then execute ${literal(fault)}; end if; return new; end $late$;
          create constraint trigger late_routine after update on private.confirmed_test_purge_schema
            deferrable initially deferred for each row execute function review_fixture.late_routine();
          update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;`);
        const control=clone('control_'+kind,database), controlBefore=snapshot(control);
        assert.equal(controlBefore.actual,controlBefore.stored);
        runSource(control);
        assert.equal(snapshot(control).state,controlBefore.state);
        assert.equal(snapshot(control).actual,snapshot(control).stored);
        record('same-baseline conditional deferred '+kind+' positive control');
        input=source.replace("set local search_path = '';",()=>"set local search_path = '';\nset local mam.review_fault='on';");
      }
      const before=snapshot(database);
      try {
        assert.throws(()=>runSource(database,input),/55000:/,phase+' '+kind+' default-NULL-ACL routine must fail closed');
        assert.deepEqual(snapshot(database),before,'Full routine/catalog/state/fingerprint rollback');
        assert.equal(sql(socket,database,"select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname='unreviewed_review_marker';").trim(),'0');
        record(phase+' '+kind+' default NULL ACL is rejected with complete atomic rollback');
      } catch(error) { failures.push(error); console.error('FAIL: '+phase+' '+kind+': '+error.message); }
    }
    for (const [kind,fault] of [
      ['aggregate_definition', "update pg_aggregate set agginitval='0' where aggfnoid='pg_catalog.sum(integer)'::regprocedure;"],
      ['window_security', "alter function pg_catalog.row_number() security definer;"],
      ['third_public_rpc', "create function public.unreviewed_review_marker() returns integer language sql as $$ select 1; $$;"],
      ['private_default_function', "create function private.unreviewed_review_marker() returns integer language sql as $$ select 1; $$;"],
    ]) for (const phase of ['pre','post']) {
      const database=clone(phase+'_'+kind), before=snapshot(database);
      const input=phase==='pre' ? source.replace(firstBoundary,()=>fault+'\n'+firstBoundary)
        : source.replace(refreshBoundary,()=>refreshBoundary+'\n'+fault);
      assert.throws(()=>runSource(database,input),/55000:/,phase+' '+kind+' must fail closed');
      assert.deepEqual(snapshot(database),before,phase+' '+kind+' exact full rollback');
      record(phase+' '+kind+' is inventoried and rejected outside the exact two-RPC delta');
    }
    assert.equal(failures.length,0,failures.map(e=>e.message).join('\n'));
  }

  if (group==='all' || group==='core') {

  const provider = clone('provider_grants');
  sql(socket,provider,'alter default privileges in schema public grant execute on functions to anon,service_role;');
  runSource(provider);
  command('psql',[...target(socket,provider),'-f','tests/onboarding-review.sql']);
  record('permissive provider-style inherited EXECUTE is explicitly revoked from anon and service_role');

  const firstBoundary = 'set constraints all immediate;\nselect pg_temp.assert_onboarding_review_transition();';
  const refreshBoundary = 'end;\n$review_refresh$;';
  assert.equal(source.split(firstBoundary).length,3);
  assert.equal(source.split(refreshBoundary).length,2);
  const faults = [
    ['composite', 'create type private.unreviewed_review_marker as (marker text);'],
    ['domain', 'create domain pg_catalog.unreviewed_review_marker as uuid check(value is not null);'],
    ['index_attribute', 'create index unreviewed_review_marker on private.employee_onboarding_credentials(review_code);'],
    ['trigger', 'alter table public.profiles disable trigger guard_onboarding_account;'],
    ['body', "create or replace function public.cancel_onboarding_credential_review(p_delivery_id uuid,p_expected_updated_at timestamptz) returns boolean language sql security definer set search_path='' as $$ select true; $$;"],
    ['rpc_acl', 'grant execute on function public.cancel_onboarding_credential_review(uuid,timestamptz) to service_role;'],
    ['column_acl', 'grant select(claimed_login) on private.employee_onboarding_credentials to service_role;'],
    ['auth_column_acl', 'grant select(raw_user_meta_data) on auth.users to anon;'],
    ['schema_acl', 'grant create on schema auth to anon;'],
    ['default_acl', 'alter default privileges for role authenticated grant execute on functions to service_role;'],
    ['role_attribute', 'alter role anon createrole;'],
    ['credential_data', `update private.employee_onboarding_credentials set review_code='unreviewed' where person_id=${literal(person)};`],
    ['receipt_data', "update private.notification_delivery_receipts set recipient='unreviewed@example.test' where state='processing';"],
  ];
  for (const [label,fault] of faults) for (const phase of ['pre','post']) {
    const database = clone(phase+'_'+label);
    const input = phase==='pre' ? source.replace(firstBoundary,()=>fault+'\n'+firstBoundary)
      : source.replace(refreshBoundary,()=>refreshBoundary+'\n'+fault);
    assert.throws(()=>runSource(database,input), /55000:/,label+' '+phase+' must fail closed');
    assert.deepEqual(snapshot(database),baseline,label+' '+phase+' exact catalog/data/fingerprint rollback');
    record(`${phase}-refresh ${label} drift rejected with complete atomic rollback`);
  }
  const staleBaseline = clone('stale_baseline');
  sql(socket,staleBaseline,"update private.confirmed_test_purge_schema set schema_hash=repeat('f',64);");
  const staleBefore = snapshot(staleBaseline);
  assert.throws(()=>runSource(staleBaseline),/55000:/);
  assert.deepEqual(snapshot(staleBaseline),staleBefore);
  record('mismatched stored predecessor rejected before additive DDL');

  const deferred = clone('deferred');
  sql(socket,deferred,`create schema review_fixture;
    create function review_fixture.late_grant() returns trigger language plpgsql as $$ begin
      if current_setting('mam.review_grant_fault',true)='on' then
        execute 'grant select(claimed_login) on private.employee_onboarding_credentials to service_role';
      end if; return new; end $$;
    create constraint trigger late_grant after update on private.confirmed_test_purge_schema
      deferrable initially deferred for each row execute function review_fixture.late_grant();
    update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;`);
  const deferredControl=clone('deferred_control',deferred), deferredControlBefore=snapshot(deferredControl);
  assert.equal(deferredControlBefore.actual,deferredControlBefore.stored);
  runSource(deferredControl);
  assert.equal(snapshot(deferredControl).state,deferredControlBefore.state);
  assert.equal(snapshot(deferredControl).actual,snapshot(deferredControl).stored);
  record('same-baseline existing deferred grant positive control');
  const deferredBefore = snapshot(deferred);
  assert.throws(()=>runSource(deferred,source.replace("set local search_path = '';",()=>"set local search_path = '';\nset local mam.review_grant_fault='on';")),/55000:/);
  assert.deepEqual(snapshot(deferred),deferredBefore);
  record('conditional deferred fingerprint-write grant is drained and rolls back the complete feature');

  }
  if (group==='all' || group==='core') {

  const concurrent = clone('concurrent',positive);
  const id = delivery(concurrent);
  const winner = session(concurrent,cancel(id)+" select 'HELD';",{hold:true});
  await until(()=>winner.output().includes('HELD'),'first cancellation commit barrier');
  const loser = session(concurrent,cancel(id));
  await waitForLock(concurrent,loser);
  winner.child.stdin.end('commit;\n');
  assert.equal((await winner.done).code,0);
  const rejected = await loser.done;
  assert.notEqual(rejected.code,0); assert.match(rejected.error,/55000:/);
  assert.equal(sql(socket,concurrent,`select count(*) from private.employee_onboarding_credential_events where delivery_id=${literal(id)} and event_type='review_cancelled';`).trim(),'1');
  record('two concurrent P0 cancellations serialize and produce exactly one committed audit event');

  const workerFirst = clone('worker_first',positive);
  sql(socket,workerFirst,`update private.employee_onboarding_credentials set status='claimed',review_code=null,claimed_login=null,
    claimed_work_email=null,updated_at=${literal(stamp)},claim_expires_at=clock_timestamp()+interval '10 minutes' where person_id=${literal(person)};`);
  const workerId = delivery(workerFirst);
  const token = sql(socket,workerFirst,`select claim_token from private.employee_onboarding_credentials where id=${literal(workerId)};`).trim();
  const worker = session(workerFirst,`select public.begin_onboarding_credential_delivery(${literal(workerId)},${literal(token)},'synthetic-review-race-6@example.test','synthetic-review-race-6@example.test',null); select 'HELD';`,{role:'service_role',user:'',hold:true});
  await until(()=>worker.output().includes('HELD'),'worker begin barrier');
  assert.match(worker.output(),/\bt\b/);
  const duringWorker = session(workerFirst,cancel(workerId));
  await waitForLock(workerFirst,duringWorker);
  worker.child.stdin.end('commit;\n'); assert.equal((await worker.done).code,0);
  const workerDenial = await duringWorker.done;
  assert.notEqual(workerDenial.code,0); assert.match(workerDenial.error,/55000:/);
  assert.equal(sql(socket,workerFirst,`select status from private.employee_onboarding_credentials where id=${literal(workerId)};`).trim(),'sending');
  record('actual active-worker begin wins the credential row and cancellation refuses the sending row');

  const cancelFirst = clone('cancel_first',positive);
  const cancelledId = delivery(cancelFirst);
  const oldToken = sql(socket,cancelFirst,`select claim_token from private.employee_onboarding_credentials where id=${literal(cancelledId)};`).trim();
  const cancelling = session(cancelFirst,cancel(cancelledId)+" select 'HELD';",{hold:true});
  await until(()=>cancelling.output().includes('HELD'),'cancellation row barrier');
  const blockedWorker = session(cancelFirst,`select public.begin_onboarding_credential_delivery(${literal(cancelledId)},${literal(oldToken)},'synthetic-review-race-6@example.test','synthetic-review-race-6@example.test',null);`,{role:'service_role',user:''});
  await waitForLock(cancelFirst,blockedWorker);
  cancelling.child.stdin.end('commit;\n'); assert.equal((await cancelling.done).code,0);
  const noBegin = await blockedWorker.done; assert.equal(noBegin.code,0,noBegin.error); assert.match(noBegin.output,/\bf\b/);
  const noWorker = await session(cancelFirst,`select public.complete_onboarding_credential_delivery(${literal(cancelledId)},${literal(oldToken)}),
    public.fail_onboarding_credential_delivery(${literal(cancelledId)},${literal(oldToken)},'delivery_uncertain');
    select count(*) from public.claim_due_onboarding_credentials(10);`,{role:'service_role',user:''}).done;
  assert.equal(noWorker.code,0,noWorker.error); assert.match(noWorker.output,/f\|f\n0/);
  record('cancellation-first prevents actual worker begin/complete/fail/claim without clearing claim context or requeueing');

  const revoked = clone('revocation',positive);
  const revoker = session(revoked,"select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0)); select 'HELD';",{user:otherActor,role:'postgres',hold:true});
  await until(()=>revoker.output().includes('HELD'),'authority fence');
  const queued = session(revoked,cancel(delivery(revoked)));
  await waitForLock(revoked,queued);
  revoker.child.stdin.end(`update public.profiles set account_status='disabled',disabled_at=clock_timestamp() where id=${literal(actor)}; commit;\n`);
  const revokeResult = await revoker.done; assert.equal(revokeResult.code,0,revokeResult.error);
  const deniedAfterWait = await queued.done; assert.notEqual(deniedAfterWait.code,0); assert.match(deniedAfterWait.error,/42501:/);
  assert.equal(sql(socket,revoked,`select status from private.employee_onboarding_credentials where person_id=${literal(person)};`).trim(),'needs_review');
  record('queued cancellation rechecks deployed P0 policy after the role-control fence and refuses a revoked actor');

  const actionDatabase = clone('actual_actions',positive);
  const actionCalls = [];
  const client = {auth:{getUser:async()=>({data:{user:{id:actor}},error:null})},rpc:async(name,args)=>{
    actionCalls.push({name,args});
    const statement = name==='can_change_employee_view' ? 'select to_jsonb(public.can_change_employee_view());'
      : name==='list_onboarding_credential_reviews' ? "select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) from public.list_onboarding_credential_reviews() r;"
      : name==='cancel_onboarding_credential_review' ? `select to_jsonb(public.cancel_onboarding_credential_review(${literal(args.p_delivery_id)},${literal(args.p_expected_updated_at)}::timestamptz));`
      : assert.fail('Unexpected actual action RPC '+name);
    try { return {data:JSON.parse(command('psql',[...target(socket,actionDatabase),'-v','VERBOSITY=verbose','-Atq'],{input:`begin; ${claims()} ${statement} commit;`}).trim()),error:null}; }
    catch(error) { const code=error.message.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1]; if(!code) throw error; return {data:null,error:{code,message:'synthetic withheld SQL detail'}}; }
  }};
  const actions = loadModule('src/app/onboarding-review/actions.ts',{'@/lib/supabase/server':{createClient:async()=>client},'next/cache':{revalidatePath(){throw new Error('synthetic cache failure');}}});
  const list = await actions.listOnboardingCredentialReviews(); assert.equal(list.ok,true);
  const row = list.reviews.find(r=>r.employeeName==='Synthetic review race employee 6'); assert.ok(row);
  assert.match(row.updatedAt,/\.123456(?:Z|[+-]\d{2}:\d{2})$/);
  assert.equal(sql(socket,actionDatabase,`select ${literal(row.updatedAt)}::timestamptz=${literal(stamp)}::timestamptz;`).trim(),'t');
  assert.equal((await actions.cancelOnboardingCredentialReview({deliveryId:row.deliveryId,updatedAt:row.updatedAt.replace('123456','123455')})).ok,false);
  const committed = await actions.cancelOnboardingCredentialReview({deliveryId:row.deliveryId,updatedAt:row.updatedAt});
  assert.equal(committed.ok,true); assert.equal(committed.committed,true);
  assert.deepEqual(actionCalls.filter(c=>c.name==='cancel_onboarding_credential_review').at(-1).args,{p_delivery_id:row.deliveryId,p_expected_updated_at:row.updatedAt});
  assert.equal(sql(socket,actionDatabase,`select status from private.employee_onboarding_credentials where id=${literal(row.deliveryId)};`).trim(),'cancelled');
  record('actual exported Server Actions execute real authenticated RPCs, exact microseconds, stale rejection and committed cache-warning readback');
  }
  assert.deepEqual(inputs.map(file=>({file,sha256:sha(file)})),beforeSources,'All tested inputs stayed byte-frozen');
  completed = true;
} finally {
  for (const child of sessions) { child.stdin.end('rollback;\n'); child.kill('SIGTERM'); }
  await until(()=>sessions.size===0,'owned psql sessions cleanup');
  for (const database of [...databases].reverse()) command('dropdb',['-h',socket,'-p','55439','-U','postgres',database]);
  const cleanup=[...databases].map(database=>({database,exists:databaseExists(database)}));
  assert.ok(cleanup.every(r=>!r.exists));
  for (const receipt of processEvidence) {
    try { process.kill(receipt.pid,0); receipt.alive=true; } catch(error) { if(error.code!=='ESRCH') throw error; receipt.alive=false; }
  }
  assert.ok(processEvidence.every(r=>!r.alive));
  writeFileSync(path.join(evidenceDir,'results.json'),JSON.stringify({completed,group,postgres:command('psql',['--version']).trim(),
    results,inputs:beforeSources,executions,lockEvidence,snapshotEvidence,processEvidence,cleanup,owned_databases_removed:[...databases],owned_sessions_remaining:sessions.size,
    unverified:['formal Management non-superuser ledger wrapper','PG17','production acceptance']},null,2));
  console.log(`Onboarding review SQL: completed=${completed}; checks=${results.length}; owned sessions=${sessions.size}; databases cleaned=${databases.size}`);
}
