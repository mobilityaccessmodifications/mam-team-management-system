import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {readFileSync} from 'node:fs';
import {sql,target,postgresEnv} from '../scripts/local-test-postgres.mjs';
const [socket,database]=process.argv.slice(2);
const applicant='a1000000-0000-4000-8000-000000000001',p0='a1000000-0000-4000-8000-000000000009';
const sessions=new Set();let counter=0;
const claims=actor=>`select set_config('request.jwt.claim.sub','${actor}',true);select set_config('request.jwt.claims',jsonb_build_object('sub','${actor}','iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text,true);`;
function connection(actor,statement,hold=false,owner=false){
 const app=`sr_race_${process.pid}_${++counter}`;const child=spawn('psql',[...target(socket,database),'-Atq','-v','VERBOSITY=verbose'],{env:{...postgresEnv,PGAPPNAME:app}});sessions.add(child);
 let output='',error='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>error+=c);
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>{sessions.delete(child);resolve({code,output,error});});});
 child.stdin.write(`begin;set statement_timeout='8s';${claims(actor)}${owner?'':'set local role authenticated;'}${statement}\n`);
 if(!hold)child.stdin.end('commit;\n');return {app,child,done,output:()=>output};
}
async function until(check,label){const deadline=Date.now()+5000;while(!check()){assert.ok(Date.now()<deadline,label);await delay(15);}}
async function waiting(c){await until(()=>sql(socket,database,`select count(*) from pg_stat_activity where application_name='${c.app}' and wait_event_type='Lock';`).trim()==='1','Expected real PostgreSQL lock wait');}
try{
 const fixture=readFileSync('tests/unified-role-fixture.sql','utf8').replace('\\ir sql-test-auth.sql',()=>readFileSync('tests/sql-test-auth.sql','utf8'));
 sql(socket,database,fixture+`update private.subscription_request_config set enabled=true,approver_user_id='a1000000-0000-4000-8000-000000000004',approver_person_id='a1000000-0000-4000-8000-000000000004';begin;${claims(p0)}set local role authenticated;select public.replace_subscription_management_delegates(array['${applicant}']::uuid[]);commit;`);
 const approver='a1000000-0000-4000-8000-000000000004',owner='a1000000-0000-4000-8000-000000000013';
 const terms='{"formVersion":2,"kind":"new_purchase","service":"Synthetic activation race","purpose":"Work","company":"mam","duration":"ongoing","billing":"annual","currency":"AUD","monthlyCostCents":1000,"annualCostCents":10000,"quoteCents":10000,"audEstimateCents":10000,"payment":"non_card","intendedUsers":"Team"}';
 function prepare(id){sql(socket,database,`begin;${claims(applicant)}set local role authenticated;select public.sr_mutate('${id}',0,'submit','${terms}');commit;begin;${claims(approver)}set local role authenticated;select public.sr_mutate('${id}',1,'approve');commit;`);}
 const activate=id=>`select public.sr_activate('${id}',2,1,current_date,null,'${owner}','{}');`;
 const id='b2000000-0000-4000-8000-000000000010';prepare(id);
 const first=connection(applicant,activate(id)+"select 'HELD';",true);await until(()=>first.output().includes('HELD'),'First activation holds request');
 const second=connection(applicant,activate(id));await waiting(second);first.child.stdin.end('commit;\n');assert.equal((await first.done).code,0);assert.match((await second.done).error,/PT409:/);
 assert.equal(sql(socket,database,`select count(*) from private.subscription_register where source_request_id='${id}';`).trim(),'1');
 assert.equal(sql(socket,database,`select count(*) from private.subscription_request_events where request_id='${id}' and operation='activate';`).trim(),'1');
 console.log('PASS: simultaneous activation creates one register row and one immutable activation event');
 const withdrawnId='b2000000-0000-4000-8000-000000000011';prepare(withdrawnId);
 const withdrawing=connection(applicant,`select public.sr_mutate('${withdrawnId}',2,'withdraw');select 'HELD';`,true);await until(()=>withdrawing.output().includes('HELD'),'Withdrawal holds request');
 const staleActivation=connection(applicant,activate(withdrawnId));await waiting(staleActivation);withdrawing.child.stdin.end('commit;\n');assert.equal((await withdrawing.done).code,0);assert.match((await staleActivation.done).error,/PT409:/);
 assert.equal(sql(socket,database,`select count(*) from private.subscription_register where source_request_id='${withdrawnId}';`).trim(),'0');
 console.log('PASS: committed withdrawal prevents queued activation');
 const activatedId='b2000000-0000-4000-8000-000000000012';prepare(activatedId);
 const activating=connection(applicant,activate(activatedId)+"select 'HELD';",true);await until(()=>activating.output().includes('HELD'),'Activation holds request');
 const staleWithdrawal=connection(applicant,`select public.sr_mutate('${activatedId}',2,'withdraw');`);await waiting(staleWithdrawal);activating.child.stdin.end('commit;\n');assert.equal((await activating.done).code,0);assert.match((await staleWithdrawal.done).error,/PT409:/);
 console.log('PASS: committed activation prevents queued withdrawal');
 const revokedId='b2000000-0000-4000-8000-000000000013';prepare(revokedId);
 const control=connection(p0,"select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));select 'HELD';",true,true);await until(()=>control.output().includes('HELD'),'Role authority lock held');
 const pending=connection(applicant,activate(revokedId));await waiting(pending);control.child.stdin.end("set local role authenticated;select public.replace_subscription_management_delegates('{}'::uuid[]);commit;\n");assert.equal((await control.done).code,0);assert.match((await pending.done).error,/42501:/);
 assert.equal(sql(socket,database,`select version from private.subscription_requests where id='${revokedId}';`).trim(),'2');
 console.log('PASS: queued activation rechecks revoked Register delegation after authority lock');
 sql(socket,database,`begin;${claims(p0)}set local role authenticated;select public.replace_subscription_management_delegates(array['${applicant}']::uuid[]);commit;`);
 const inactiveId='b2000000-0000-4000-8000-000000000014';prepare(inactiveId);
 const disabling=connection(p0,`update public.internal_org_people set is_active=false where id='${owner}';select 'HELD';`,true,true);await until(()=>disabling.output().includes('HELD'),'Owner record lock held');
 const ownerPending=connection(applicant,activate(inactiveId));await waiting(ownerPending);disabling.child.stdin.end('commit;\n');assert.equal((await disabling.done).code,0);assert.match((await ownerPending.done).error,/23503:/);
 assert.equal(sql(socket,database,`select count(*) from private.subscription_register where source_request_id='${inactiveId}';`).trim(),'0');
 console.log('PASS: inactive-owner change is rechecked after observable employee row lock');
}finally{for(const child of sessions){child.stdin.end('rollback;\n');child.kill('SIGTERM');}}
