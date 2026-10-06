import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { command, startCluster, stopCluster, createDatabase, sql, target, postgresEnv } from '../scripts/local-test-postgres.mjs';

const own = !process.argv[2];
const socket = process.argv[2] ?? startCluster();
const database = process.argv[3] ?? 'mam_test_operational_role';
const evidence = process.env.MAM_OPERATIONAL_EVIDENCE;
const sessions = new Set(), results = [];
let counter = 0, completed = false;
const id = n => `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function session(actor, statement, hold = false) {
  const app = `operational_role_${process.pid}_${++counter}`;
  const child = spawn('psql', [...target(socket,database), '-v','VERBOSITY=verbose','-Atq'], {
    env: {...postgresEnv, PGAPPNAME: app}, stdio: ['pipe','pipe','pipe'],
  });
  sessions.add(child);
  let output = '', error = '', finished = false;
  child.stdout.on('data', c => output += c);
  child.stderr.on('data', c => error += c);
  const done = new Promise((resolve,reject) => {
    child.on('error',reject);
    child.on('exit',code => { finished=true; sessions.delete(child); resolve({code,output,error}); });
  });
  child.stdin.write(`begin; set statement_timeout='7s'; ${actor ? `set local role authenticated;
    select set_config('request.jwt.claim.sub','${actor}',true);
    select set_config('request.jwt.claims',jsonb_build_object('sub','${actor}','iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text,true);` : ''} ${statement}\n`);
  if (!hold) child.stdin.end('commit;\n');
  return {app,child,done,output:()=>output,finished:()=>finished};
}
async function until(check,label) {
  const end=Date.now()+5000;
  while (!check()) { if(Date.now()>end) throw new Error(`Timed out: ${label}`); await delay(20); }
}
function waits(s) {
  return sql(socket,database,`select count(*) from pg_stat_activity where application_name='${s.app}' and wait_event_type='Lock';`).trim()==='1';
}
async function held(statement) {
  const s=session(null,`${statement} select 'RESOURCE_HELD';`,true);
  await until(()=>s.output().includes('RESOURCE_HELD'),'resource held'); return s;
}
async function release(s) { s.child.stdin.end('rollback;\n'); assert.equal((await s.done).code,0); }
function asActor(actor,statement) {
  return `begin; set local role authenticated;
    select set_config('request.jwt.claim.sub','${actor}',true);
    select set_config('request.jwt.claims',jsonb_build_object('sub','${actor}','iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text,true);
    ${statement} commit;`;
}
const accountVersion=()=>sql(socket,database,`select account_version from public.profiles where id='${id(1)}';`).trim();
const resetToken=()=>sql(socket,database,`select reset_token from private.portal_password_reset_claims where auth_user_id='${id(1)}';`).trim();
const cases = [
  {name:'annual-balance',setup:`insert into private.employee_annual_leave_balances(person_id,hours,as_of,is_example,updated_by) values('${id(1)}',80,current_date,false,'${id(9)}') on conflict(person_id) do update set hours=80;`,
    lock:`select person_id from private.employee_annual_leave_balances where person_id='${id(1)}' for update;`,
    write:`select public.set_employee_annual_leave_balance('${id(1)}',17,current_date,false);`,
    state:`select to_jsonb(b) from private.employee_annual_leave_balances b where person_id='${id(1)}';`},
  {name:'sick-balance',setup:`insert into private.employee_sick_leave_balances(person_id,hours,as_of,updated_by) values('${id(1)}',80,current_date,'${id(9)}') on conflict(person_id) do update set hours=80;`,
    lock:`select person_id from private.employee_sick_leave_balances where person_id='${id(1)}' for update;`,
    write:`select public.set_employee_sick_leave_balance('${id(1)}',17,current_date);`,
    state:`select to_jsonb(b) from private.employee_sick_leave_balances b where person_id='${id(1)}';`},
  {name:'directory-address',setup:`insert into private.employee_directory_details(person_id,first_name) values('${id(1)}','Synthetic') on conflict(person_id) do nothing;`,lock:`select person_id from private.employee_directory_details where person_id='${id(1)}' for update;`,
    write:()=>`select public.update_employee_directory_address('${id(1)}','Synthetic changed address',${sql(socket,database,`select version from private.employee_directory_details where person_id='${id(1)}';`).trim()});`,
    state:`select to_jsonb(d) from private.employee_directory_details d where person_id='${id(1)}';`},
  {name:'offboarding-schedule',setup:`insert into private.employee_directory_details(person_id,first_name) values('${id(1)}','Synthetic') on conflict(person_id) do nothing; delete from private.scheduled_employee_offboarding where person_id='${id(1)}';`,
    lock:`select id from public.internal_org_people where id='${id(1)}' for update;`,
    write:()=>`select public.schedule_employee_offboarding('${id(1)}',${sql(socket,database,`select version from public.internal_org_people where id='${id(1)}';`).trim()},${sql(socket,database,`select version from private.employee_directory_details where person_id='${id(1)}';`).trim()},current_date+10,'Resigned');`,
    state:`select coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) from private.scheduled_employee_offboarding s where person_id='${id(1)}';`},
  {name:'manager-directory',actor:2,role:'manager',setup:`insert into private.employee_directory_details(person_id,first_name) values('${id(1)}','Synthetic') on conflict(person_id) do update set last_name=null;`,
    lock:`select id from public.internal_org_people where id='${id(1)}' for update;`,
    write:()=>`select public.update_managed_employee_directory_record('${id(1)}','Synthetic','Changed ${counter}',null,'Synthetic unrelated title',null,${sql(socket,database,`select version from public.internal_org_people where id='${id(1)}';`).trim()},${sql(socket,database,`select version from private.employee_directory_details where person_id='${id(1)}';`).trim()});`,
    state:`select to_jsonb(d) from private.employee_directory_details d where person_id='${id(1)}';`},
  {name:'reset-claim',setup:`delete from private.portal_password_reset_claims where auth_user_id='${id(1)}';`,
    lock:`select pg_advisory_xact_lock(hashtextextended('portal_account:${id(1)}',0));`,
    write:()=>`select public.begin_portal_password_reset('${id(1)}','${id(1)}',${sql(socket,database,`select account_version from public.profiles where id='${id(1)}';`).trim()});`,
    state:`select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) from private.portal_password_reset_claims c where auth_user_id='${id(1)}';`},
  {name:'reset-credential-wait',setup:'',lock:`lock table private.employee_onboarding_credentials in access exclusive mode;`,
    write:()=>`select public.begin_portal_password_reset('${id(1)}','${id(1)}',${sql(socket,database,`select account_version from public.profiles where id='${id(1)}';`).trim()});`,
    state:`select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) from private.portal_password_reset_claims c where auth_user_id='${id(1)}';`},
  {name:'reset-cancel',setup:()=>asActor(id(4),`select public.begin_portal_password_reset('${id(1)}','${id(1)}',${accountVersion()});`),
    lock:`select pg_advisory_xact_lock(hashtextextended('portal_account:${id(1)}',0));`,
    write:()=>`select public.cancel_portal_password_reset('${id(1)}','${resetToken()}');`,
    state:`select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) from private.portal_password_reset_claims c where auth_user_id='${id(1)}';`},
  {name:'reset-finalise',setup:()=>asActor(id(4),`select public.begin_portal_password_reset('${id(1)}','${id(1)}',${accountVersion()});`),
    lock:`select pg_advisory_xact_lock(hashtextextended('portal_account:${id(1)}',0));`,
    write:()=>`select public.finalise_portal_password_reset('${id(1)}','${id(1)}','${resetToken()}');`,
    state:`select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) from private.portal_password_reset_claims c where auth_user_id='${id(1)}';`},
  {name:'account-status-claim',setup:'',lock:`select pg_advisory_xact_lock(hashtextextended('portal_account:${id(1)}',0));`,
    write:()=>`select public.begin_portal_account_status_change('${id(1)}','${id(1)}',false,${accountVersion()});`,
    state:`select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) from private.portal_account_status_change_claims c where auth_user_id='${id(1)}';`},
  {name:'account-status-cancel',setup:()=>asActor(id(4),`select public.begin_portal_account_status_change('${id(1)}','${id(1)}',false,${accountVersion()});`),
    lock:`select pg_advisory_xact_lock(hashtextextended('portal_account:${id(1)}',0));`,
    write:()=>`select public.cancel_portal_account_status_change('${id(1)}','${sql(socket,database,`select change_token from private.portal_account_status_change_claims where auth_user_id='${id(1)}';`).trim()}');`,
    state:`select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) from private.portal_account_status_change_claims c where auth_user_id='${id(1)}';`},
  {name:'login-rename',setup:'',lock:`select id from public.profiles where id='${id(1)}' for update;`,
    write:()=>`select public.update_portal_login('${id(1)}','${id(1)}','synthetic-renamed-${counter}@example.test',${sql(socket,database,`select account_version from public.profiles where id='${id(1)}';`).trim()});`,
    state:`select to_jsonb(p) from public.profiles p where id='${id(1)}';`},
];
try {
  if (own) {
    createDatabase(socket,database);
    sql(socket,database,readFileSync('tests/migrations/0001-supabase-platform.sql','utf8'));
    for(const f of readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort()) sql(socket,database,readFileSync(`supabase/migrations/${f}`,'utf8'));
  }
  command('psql',[...target(socket,database),'-f','tests/unified-role-security.sql']);
  command('psql',[...target(socket,database),'-f','tests/unified-role-operational-fencing.sql']);
  command('psql',[...target(socket,database),'-f','tests/unified-role-concurrency-setup.sql']);
  const authBefore=sql(socket,database,`select jsonb_agg(to_jsonb(u)#-'{raw_app_meta_data,org_role}' order by u.id) from auth.users u;`).trim();
  const protectedAuthBefore=sql(socket,database,`select jsonb_agg(to_jsonb(u) order by u.id) from auth.users u where u.id in ('${id(5)}','${id(9)}');`).trim();
  const protectedBefore=sql(socket,database,`select jsonb_agg(to_jsonb(p) order by p.id) from public.profiles p where p.id in ('${id(5)}','${id(9)}');`).trim();
  for (const c of cases) {
    const actor=id(c.actor ?? 4), role=c.role ?? 'admin';
    for (const mode of ['writer-first','demoter-first','direct-stale']) {
      sql(socket,database,`update public.profiles set app_role='${role}' where id='${actor}'; delete from private.portal_password_reset_claims where auth_user_id='${id(1)}'; delete from private.portal_account_status_change_claims where auth_user_id='${id(1)}';`);
      sql(socket,database,typeof c.setup==='function' ? c.setup() : c.setup);
      const statement=typeof c.write==='function' ? c.write() : c.write;
      const before=sql(socket,database,c.state).trim();
      let writer,demoter,holder,wr,dr,observed=false;
      try {
        if(mode==='writer-first') {
          holder=await held(c.lock);
          writer=session(actor,statement);
          await until(()=>waits(writer)||writer.finished(),'writer resource wait');
          assert(!writer.finished(),'writer must reach actual resource wait');
          if(c.name==='reset-claim' || c.name==='reset-credential-wait') {
            const targetProbe=await session(null,`select id from public.internal_org_people where id='${id(1)}' for share nowait; select id from public.profiles where id='${id(1)}' for share nowait;`).done;
            assert.equal(targetProbe.code,0,'Reset authority/account/credential wait precedes either target row lock');
          }
          demoter=session(id(9),`select public.update_employee_directory_role('${actor}','account','${role}');`);
          await until(()=>waits(demoter)||demoter.finished(),'demoter wait or completion');
          observed=waits(demoter);
          await release(holder); holder=null;
          wr=await writer.done; dr=await demoter.done;
          assert.equal(wr.code,0,wr.error); assert.equal(dr.code,0,dr.error);
          assert(observed,'role demotion committed while an authorized operational writer was still waiting on its resource');
          assert.notEqual(sql(socket,database,c.state).trim(),before,'one authorized mutation committed');
        } else if(mode==='demoter-first') {
          demoter=session(id(9),`select public.update_employee_directory_role('${actor}','account','${role}'); select 'DEMOTER_HELD';`,true);
          await until(()=>demoter.output().includes('DEMOTER_HELD'),'demotion held');
          writer=session(actor,statement);
          await until(()=>waits(writer)||writer.finished(),'writer authority wait');
          observed=waits(writer);
          demoter.child.stdin.end('commit;\n'); dr=await demoter.done;
          wr=await writer.done;
          assert.equal(dr.code,0,dr.error); assert.notEqual(wr.code,0,'demoted writer committed');
          assert.match(wr.error,/42501:/); assert(observed,'writer did not observe the authority wait');
          assert.equal(sql(socket,database,c.state).trim(),before,'denial preserves entire resource');
        } else {
          sql(socket,database,`update public.profiles set app_role='account' where id='${actor}';`);
          holder=await held(c.lock);
          writer=session(actor,`set statement_timeout='700ms'; ${statement}`);
          wr=await writer.done;
          assert.notEqual(wr.code,0); assert.match(wr.error,/42501:/);
          assert.equal(sql(socket,database,c.state).trim(),before,'stale direct denial preserves resource');
          await release(holder); holder=null;
        }
        results.push({name:c.name,mode,pass:true,observed_lock_wait:observed});
        console.log(`PASS: operational ${c.name} ${mode}`);
      } catch(error) {
        results.push({name:c.name,mode,pass:false,observed_lock_wait:observed,error:error.message,writer:wr,demoter:dr});
        console.log(`FAIL: operational ${c.name} ${mode}: ${error.message}`);
      } finally {
        if(holder) await release(holder);
        for(const s of [writer,demoter]) if(s && !s.finished()) {s.child.stdin.end('rollback;\n'); await s.done;}
      }
    }
  }
  sql(socket,database,`update public.profiles set app_role='admin' where id='${id(4)}';`);
  const readFence=session(id(9),`select public.update_employee_directory_role('${id(4)}','account','admin'); select 'READ_FENCE_HELD';`,true);
  await until(()=>readFence.output().includes('READ_FENCE_HELD'),'role control held for pure reads');
  const pureRead=await session(id(4),`set statement_timeout='700ms'; select public.can_manage_portal_accounts(); select public.list_portal_account_summaries(); select public.can_access_non_roster_system_admin_workspace(); select public.inspect_portal_account_status_change('${id(1)}',gen_random_uuid()); select public.inspect_portal_account_status_request('${id(1)}','${id(1)}',false,${accountVersion()}); select public.list_it_assets();`).done;
  readFence.child.stdin.end('rollback;\n'); assert.equal((await readFence.done).code,0);
  assert.equal(pureRead.code,0,pureRead.error);
  results.push({name:'pure-read-projections',mode:'held-role-control',pass:true,observed_lock_wait:false});
  console.log('PASS: operational pure-read projections do not wait on mutation control');

  const disabledActor=session(null,`update public.profiles set account_status='disabled',disabled_at=clock_timestamp() where id='${id(4)}'; select 'ACTOR_DISABLE_HELD';`,true);
  await until(()=>disabledActor.output().includes('ACTOR_DISABLE_HELD'),'actor disable held');
  const balanceBefore=sql(socket,database,cases[0].state).trim();
  const disabledWrite=session(id(4),cases[0].write); await until(()=>waits(disabledWrite),'actor profile wait');
  disabledActor.child.stdin.end('commit;\n'); assert.equal((await disabledActor.done).code,0);
  const disabledResult=await disabledWrite.done; assert.notEqual(disabledResult.code,0); assert.match(disabledResult.error,/42501:/);
  assert.equal(sql(socket,database,cases[0].state).trim(),balanceBefore);
  sql(socket,database,`update public.profiles set account_status='active',disabled_at=null where id='${id(4)}';`);
  results.push({name:'actor-status-freshness',mode:'actor-row-wait',pass:true,observed_lock_wait:true});
  console.log('PASS: operational actor disable committed during actor-row wait denies before resources');

  const accountHold=await held(`select id from public.profiles where id='${id(13)}' for update;`);
  const renameFirst=session(id(4),`select public.update_portal_login('${id(13)}','${id(13)}','synthetic-opposing-first@example.test',${sql(socket,database,`select account_version from public.profiles where id='${id(13)}';`).trim()});`);
  await until(()=>waits(renameFirst),'first opposing account target wait');
  const renameSecond=session(id(13),`select public.update_portal_login('${id(4)}','${id(4)}','synthetic-opposing-second@example.test',${sql(socket,database,`select account_version from public.profiles where id='${id(4)}';`).trim()});`);
  await until(()=>waits(renameSecond),'second opposing account authority wait');
  await release(accountHold);
  const opposingResults=await Promise.all([renameFirst.done,renameSecond.done]);
  for(const result of opposingResults) assert.equal(result.code,0,result.error);
  assert.equal(sql(socket,database,`select login_name from public.profiles where id='${id(13)}';`).trim(),'synthetic-opposing-first@example.test');
  assert.equal(sql(socket,database,`select login_name from public.profiles where id='${id(4)}';`).trim(),'synthetic-opposing-second@example.test');
  results.push({name:'opposing-account-writers',mode:'actor-target-order',pass:true,observed_lock_wait:true});
  console.log('PASS: operational opposing account writers serialize authority before actor/target rows without inversion');

  assert.equal(sql(socket,database,`select jsonb_agg(to_jsonb(p) order by p.id) from public.profiles p where p.id in ('${id(5)}','${id(9)}');`).trim(),protectedBefore,'both independent P0 profiles remain byte-equivalent');
  assert.equal(sql(socket,database,`select jsonb_agg(to_jsonb(u) order by u.id) from auth.users u where u.id in ('${id(5)}','${id(9)}');`).trim(),protectedAuthBefore,'Both P0 Auth identities, logins and credentials remain byte-equivalent');
  for(const p0 of [id(5),id(9)]) {
    const abilities=await session(p0,`select can_manage_accounts and can_manage_roles and can_change_employee_view and can_manage_subscription_management_grants from public.get_portal_role_capabilities();`).done;
    assert.equal(abilities.code,0,abilities.error); assert.match(abilities.output,/\nt\n/,'Linked and standalone P0 retain independent capabilities');
  }
  sql(socket,database,`update public.profiles set app_role='admin' where id='${id(4)}';`);
  assert.equal(sql(socket,database,`select jsonb_agg(to_jsonb(u)#-'{raw_app_meta_data,org_role}' order by u.id) from auth.users u;`).trim(),authBefore,'No reset/provider Auth password or identity write');
  console.log(`Operational concurrency: ${results.filter(r=>r.pass).length}/${results.length}`);
  assert.equal(results.length,cases.length*3+3);
  assert.equal(results.filter(r=>!r.pass).length,0,JSON.stringify(results.filter(r=>!r.pass)));
  completed=true;
} finally {
  for(const child of sessions) { child.stdin.end('rollback;\n'); child.kill('SIGTERM'); }
  let cleanup=null;
  if(own) {
    const pid=Number(readFileSync(`${socket}/data/postmaster.pid`,'utf8').split('\n')[0]);
    stopCluster(socket);
    const status=spawnSync('pg_ctl',['-D',`${socket}/data`,'status'],{env:postgresEnv,encoding:'utf8'});
    assert.equal(status.status,3,status.stdout+status.stderr);
    let alive=false; try {process.kill(pid,0); alive=true;} catch(error) {assert.equal(error.code,'ESRCH');}
    assert.equal(alive,false,'Owned PostgreSQL process stopped');
    rmSync(socket,{recursive:true,force:true}); assert.equal(existsSync(socket),false);
    cleanup={socket,pid,pg_ctl_status:status.status,pid_alive:alive,path_removed:true};
    console.log('Verified task-owned PostgreSQL stopped and removed');
  }
  if(evidence) writeFileSync(evidence,JSON.stringify({completed,migration_sha256:createHash('sha256').update(readFileSync('supabase/migrations/20261006104000_unified_portal_roles.sql')).digest('hex'),results,cleanup},null,2));
}
