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
 const id='b1000000-0000-4000-8000-000000000010';
 const first=connection(applicant,`select public.sr_mutate('${id}',0,'save','{}');select 'HELD';`,true);
 await until(()=>first.output().includes('HELD'),'First create holds request');
 const second=connection(applicant,`select public.sr_mutate('${id}',0,'save','{}');`);await waiting(second);
 first.child.stdin.end('commit;\n');assert.equal((await first.done).code,0);const loser=await second.done;assert.match(loser.error,/PT409:/);assert.notEqual(loser.code,0);
 assert.equal(sql(socket,database,`select count(*) from private.subscription_request_events where request_id='${id}';`).trim(),'1');
 console.log('PASS: concurrent duplicate create has one winner and one immutable event');
 const control=connection(p0,"select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));select 'HELD';",true,true);await until(()=>control.output().includes('HELD'),'Control held');
 const pending=connection(applicant,`select public.sr_mutate('${id}',1,'save','{}');`);await waiting(pending);
 control.child.stdin.end("set local role authenticated;select public.replace_subscription_management_delegates('{}'::uuid[]);commit;\n");assert.equal((await control.done).code,0);
 const denied=await pending.done;assert.match(denied.error,/42501:/);assert.equal(sql(socket,database,`select version from private.subscription_requests where id='${id}';`).trim(),'1');
 console.log('PASS: queued writer rechecks delegation revocation after observable role-control wait');
 sql(socket,database,`begin;${claims(p0)}set local role authenticated;select public.replace_subscription_management_delegates(array['${applicant}']::uuid[]);commit;`);
 const terms='{"kind":"new_purchase","service":"Synthetic decision race","purpose":"Work","company":"mam","payer":"MAM","duration":"Year","billing":"annual","currency":"AUD","tax":"Inclusive","quoteCents":100,"audEstimateCents":100,"payment":"non_card","intendedUsers":"Team"}';
 sql(socket,database,`begin;${claims(applicant)}set local role authenticated;select public.sr_mutate('${id}',1,'submit','${terms}');commit;`);
 const approver='a1000000-0000-4000-8000-000000000004';
 const approved=connection(approver,`select public.sr_mutate('${id}',2,'approve');select 'HELD';`,true);
 await until(()=>approved.output().includes('HELD'),'First decision holds request');
 const rejected=connection(approver,`select public.sr_mutate('${id}',2,'reject',null,'Opposing decision');`);await waiting(rejected);
 approved.child.stdin.end('commit;\n');assert.equal((await approved.done).code,0);const stale=await rejected.done;assert.match(stale.error,/PT409:/);
 assert.equal(sql(socket,database,`select count(*) from private.subscription_request_notifications where request_id='${id}';`).trim(),'2');
 assert.equal(sql(socket,database,`select count(*) from private.subscription_request_events where request_id='${id}' and operation in ('approve','reject');`).trim(),'1');
 console.log('PASS: opposing concurrent decisions produce one decision and one decision notification intent');
}finally{for(const child of sessions){child.stdin.end('rollback;\n');child.kill('SIGTERM');}}
