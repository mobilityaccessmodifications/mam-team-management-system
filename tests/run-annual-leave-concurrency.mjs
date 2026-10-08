import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {sql,target,command,postgresEnv} from '../scripts/local-test-postgres.mjs';

const [socket,database] = process.argv.slice(2);
assert.match(database ?? '',/^mam_test_annual_/);
const seed=readFileSync('tests/annual-leave-all-submitters.sql','utf8').split('DO $$ BEGIN\n  BEGIN')[0]
  .replace('\\ir sql-test-auth.sql',`\\ir '${path.resolve('tests/sql-test-auth.sql').replaceAll("'","''")}'`);
const file=path.join(socket,`${database}-concurrency-seed.sql`);
writeFileSync(file,seed+`update private.employee_annual_leave_balances set hours=10 where person_id::text like 'b1000000-%';
update private.leave_accrual_policies set enabled=false,requires_review=false where person_id::text like 'b1000000-%';
commit;`,{mode:0o600});
command('psql',[...target(socket,database),'-f',file]);
const manager='b1000000-0000-4000-8000-000000000003';
const employee='b1000000-0000-4000-8000-000000000002';
const claims=`select set_config('request.jwt.claim.sub','${manager}',true);
select set_config('request.jwt.claims',jsonb_build_object('sub','${manager}','iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text,true);`;
const requests=JSON.parse(sql(socket,database,`begin; ${claims} set local role authenticated;
select coalesce(jsonb_agg(id),'[]') from (
select id from public.submit_selected_employee_leave_request('${employee}','Annual leave',
(current_date+28)-(extract(isodow from current_date+28)::integer-1),(current_date+28)-(extract(isodow from current_date+28)::integer-1),'08:00','16:00')
union all select id from public.submit_selected_employee_leave_request('${employee}','Annual leave',
(current_date+35)-(extract(isodow from current_date+35)::integer-1),(current_date+35)-(extract(isodow from current_date+35)::integer-1),'08:00','16:00')) r;
commit;`).trim().split('\n').filter(x=>x.startsWith('['))[0]);
assert.equal(requests.length,2);
let serial=0;
const sessions=new Set();
function connection(statement,hold=false,owner=false) {
  const app=`annual_gate_${process.pid}_${++serial}`;
  const child=spawn('psql',[...target(socket,database),'-v','VERBOSITY=verbose','-Atq'],{env:{...postgresEnv,PGAPPNAME:app},stdio:['pipe','pipe','pipe']});
  sessions.add(child);
  let output='',error='',finished=false;
  child.stdout.on('data',v=>output+=v);
  child.stderr.on('data',v=>error+=v);
  const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>{finished=true;sessions.delete(child);resolve({code,output,error});});});
  child.stdin.write(`begin; set statement_timeout='8s'; ${claims} ${owner?'':'set local role authenticated;'} ${statement}\n`);
  if (!hold) child.stdin.end('commit;\n');
  return {app,child,done,finished:()=>finished,output:()=>output};
}
async function until(condition,label) {
  const limit=Date.now()+3000;
  while (!condition()) {if(Date.now()>limit) throw new Error(label);await delay(20);}
}
function waiting(c,b) {
  return sql(socket,database,`select count(*) from pg_stat_activity a where a.application_name='${c.app}' and a.wait_event_type='Lock'
    and exists(select 1 from pg_stat_activity x where x.pid=any(pg_blocking_pids(a.pid)) and x.application_name='${b.app}');`).trim()==='1';
}
async function race(firstSql,secondSql,owner=false) {
  const first=connection(`${firstSql}; select 'HELD';`,true,owner);
  await until(()=>first.finished()||first.output().includes('HELD'),'First annual transaction did not reach its held boundary');
  assert.ok(!first.finished(),'First annual transaction must remain open');
  const second=connection(secondSql);
  await until(()=>second.finished()||waiting(second,first),'T16: expected observable annual-budget lock wait');
  assert.ok(waiting(second,first),'T16: concurrent approval must wait for the annual budget before reading it');
  first.child.stdin.end('commit;\n');
  const a=await first.done,b=await second.done;
  assert.equal(a.code,0,a.error);
  assert.notEqual(b.code,0,'Second annual approval overspent the committed budget');
  assert.match(b.error,/22023:/,b.error);
  assert.match(b.error,/Not enough balance|Future accrual could not be confirmed/,b.error);
}
try {
  const holder=connection(`select private.lock_annual_leave_budget(); select 'HELD';`,true,true);
  await until(()=>holder.finished()||holder.output().includes('HELD'),'Metadata holder did not start');
  const metadata=connection(`update public.leave_requests set manager_note='Synthetic metadata during budget update' where id='${requests[0]}';
    update public.leave_requests set status='cancelled' where id='${requests[0]}';
    update public.leave_requests set status='rejected' where id='${requests[1]}';`,false,true);
  const metadataResult=await metadata.done;
  holder.child.stdin.end('rollback;\n');
  assert.equal((await holder.done).code,0);
  assert.equal(metadataResult.code,0,'T14: budget contention blocked unchanged metadata cancellation or rejection: '+metadataResult.error);
  sql(socket,database,`update public.leave_requests set status='submitted' where id=any(array['${requests[0]}','${requests[1]}']::uuid[]);`);
  await race(`select * from public.decide_my_managed_leave_request('${requests[0]}','Approved',null)`,
    `select * from public.decide_leave_with_balance('${requests[1]}','Approved',null)`);
  assert.equal(sql(socket,database,`select count(*) from public.leave_requests where id=any(array['${requests[0]}','${requests[1]}']::uuid[]) and status='approved';`).trim(),'1');
  sql(socket,database,`update public.leave_requests set status='cancelled' where id='${requests[0]}';`);
  await race(`update private.employee_annual_leave_balances set hours=2 where person_id='${employee}'`,
    `select * from public.decide_my_managed_leave_request('${requests[1]}','Approved',null)`,true);
  assert.equal(sql(socket,database,`select status from public.leave_requests where id='${requests[1]}';`).trim(),'submitted');
  console.log('PASS T16 actual RPC lock waits, one approved winner, and fresh balance after committed lowering');
} finally {
  for(const child of sessions) {if(!child.stdin.writableEnded) child.stdin.end('rollback;\n');}
  await delay(50);
}
