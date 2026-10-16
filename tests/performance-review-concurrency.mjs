import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {target,postgresEnv} from '../scripts/local-test-postgres.mjs';
import {setup,ownedRun,psql} from './performance-review-local-runner.mjs';
const database='mam_test_performance_concurrency';
const user=i=>`a1000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
const person=i=>`b1000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
const op=i=>`d2000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
const claims=i=>`select set_config('request.jwt.claims',${quote(JSON.stringify({sub:user(i),iat:1900000000}))},true);`;
const selfInput=text=>JSON.stringify({answers:Array(12).fill(text)});
const managerInput=JSON.stringify({answers:Array(12).fill(''),ratings:Array(12).fill(''),summary:'',overallRating:'',managerNote:''});
function request(i,id,revision,operation,command,input) { return `begin; set local role authenticated; ${claims(i)} select public.mutate_performance_review(${quote(op(operation))},${quote(id)},${quote(revision)},${quote(command)},${quote(input)}::jsonb); commit;`; }
function connection(socket,name,query,end=true) {
 const child=spawn('psql',[...target(socket,database),'-Atq','-v','VERBOSITY=verbose','-c',`set application_name=${quote(name)}`,'-f','-'],{env:postgresEnv,stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const result=once(child,'close').then(([status,signal])=>{const r={status,signal,stdout,stderr};console.log('CHILD '+JSON.stringify({name,...r}));return r;});
 if(end)child.stdin.end(query+'\n');else child.stdin.write(query+'\n');
 return {child,result,output:()=>stdout};
}
async function waitFor(predicate,label) {const deadline=Date.now()+12000;while(Date.now()<deadline){if(predicate())return;await delay(15);}throw Error('Timed out: '+label);}
async function finish(connection,label) {void label;return await connection.result;}
const roleLock="select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));";
export async function runPerformanceConcurrency(socket) {
 const query=q=>psql(socket,database,q);
 const start=i=>JSON.parse(query(`begin;set local role authenticated;${claims(2)}select public.start_performance_review(${quote(op(100+i))},${quote(person(i))},'2026','2026-12-31');commit;`).trim().split('\n').at(-1));
 const started=start(1);const id=started.review.id;
 const waiters=names=>Number(query(`select count(*) from pg_stat_activity where application_name=any(array[${names.map(quote).join(',')}]) and wait_event_type='Lock' and state='active'`).trim());
 const guard=async(name,sql)=>{const h=connection(socket,name,`begin; ${sql} select 'GUARD_READY';`,false);await waitFor(()=>h.output().includes('GUARD_READY'),'guard ready');return h;};
 const release=async(h,commit=false)=>{h.child.stdin.end((commit?'commit;':'rollback;')+'\n');const r=await finish(h,'guard release');assert.equal(r.status,0);};
 let h=await guard('performance_guard_cas',roleLock);
 const a=connection(socket,'performance_cas_a',request(1,id,'self:0',1,'save_self',selfInput('A')));
 const b=connection(socket,'performance_cas_b',request(1,id,'self:0',2,'save_self',selfInput('B')));
 await waitFor(()=>waiters(['performance_cas_a','performance_cas_b'])===2,'two CAS requests truly waiting');
 await release(h);const first=await Promise.all([finish(a,'CAS A'),finish(b,'CAS B')]);
 assert.deepEqual(first.map(r=>r.status).sort(),[0,3]);assert.match(first.find(r=>r.status!==0).stderr,/PT409/);
 assert.equal(query(`select self_version||':'||(select count(*) from private.performance_review_events where review_id=r.id) from private.performance_reviews r where id=${quote(id)}`).trim(),'1:2');console.log('PASS: concurrent self CAS has one winner and one PT409 without partial event');
 h=await guard('performance_guard_idempotent',roleLock);
 const replayQuery=request(1,id,'self:1',3,'save_self',selfInput('Same body'));
 const c=connection(socket,'performance_replay_a',replayQuery),d=connection(socket,'performance_replay_b',replayQuery);
 await waitFor(()=>waiters(['performance_replay_a','performance_replay_b'])===2,'same-operation requests truly waiting');
 await release(h);const replay=await Promise.all([finish(c,'replay A'),finish(d,'replay B')]);assert.ok(replay.every(r=>r.status===0));assert.equal(replay[0].stdout,replay[1].stdout);
 assert.equal(query(`select self_version||':'||(select count(*) from private.performance_review_events where review_id=r.id) from private.performance_reviews r where id=${quote(id)}`).trim(),'2:3');console.log('PASS: concurrent identical operation has one mutation and exact same receipt');
 const collision=await finish(connection(socket,'performance_collision',request(1,id,'self:2',3,'save_self',selfInput('Different body'))),'body collision');assert.equal(collision.status,3);assert.match(collision.stderr,/PT409/);
 h=await guard('performance_guard_revocation',roleLock);
 const revoked=connection(socket,'performance_revoked_actor',request(1,id,'self:2',4,'save_self',selfInput('Must not save')));
 await waitFor(()=>waiters(['performance_revoked_actor'])===1,'actor waiting at native role fence');
 query(`update public.profiles set app_role='admin' where id=${quote(user(1))}`);await release(h);
 const denied=await finish(revoked,'role revoked while waiting');assert.equal(denied.status,3);assert.match(denied.stderr,/42501/);
 assert.equal(query(`select self_version from private.performance_reviews where id=${quote(id)}`).trim(),'2');
 query(`update public.profiles set app_role='employee' where id=${quote(user(1))}`);console.log('PASS: current actor role is rechecked after observed role-fence wait');
 assert.equal((await finish(connection(socket,'performance_submit',request(1,id,'self:2',5,'submit_self',selfInput('Submitted'))),'self submit')).status,0);
 h=await guard('performance_guard_assignment',`select id from private.performance_reviews where id=${quote(id)} for update;`);
 const reassigned=connection(socket,'performance_revoked_assignment',request(2,id,'manager:3:0',6,'save_manager',managerInput));
 await waitFor(()=>waiters(['performance_revoked_assignment'])===1,'manager waiting on exact review row');
 h.child.stdin.write(`update private.performance_reviews set assigned_manager_person_id=${quote(person(3))} where id=${quote(id)};\n`);await release(h,true);
 const assignment=await finish(reassigned,'assignment revoked while waiting');assert.equal(assignment.status,3);assert.match(assignment.stderr,/42501/);
 assert.equal(query(`select manager_version from private.performance_reviews where id=${quote(id)}`).trim(),'0');
 query(`update private.performance_reviews set assigned_manager_person_id=${quote(person(2))} where id=${quote(id)}`);console.log('PASS: review assignment is rechecked after observed review-row wait');
 const other=start(6);query(`update private.performance_reviews set manager_version=91 where id=${quote(other.review.id)}`);
 assert.equal((await finish(connection(socket,'performance_independent_self',request(6,other.review.id,'self:0',7,'save_self',selfInput('Own account answer'))),'self-only revision')).status,0);
 assert.equal(query(`select self_version||':'||manager_version from private.performance_reviews where id=${quote(other.review.id)}`).trim(),'1:91');console.log('PASS: self CAS ignores hidden manager version in explicit synthetic prerequisite');
 assert.equal(query(`select count(*) from private.performance_review_operations where operation_id in (${[4,6].map(i=>quote(op(i))).join(',')})`).trim(),'0');
 console.log('PASS: revoked queued operations leave no receipts');
 h=await guard('performance_guard_manager_cas',roleLock);
 const ma=connection(socket,'performance_manager_a',request(2,id,'manager:3:0',8,'save_manager',managerInput));
 const mb=connection(socket,'performance_manager_b',request(2,id,'manager:3:0',9,'save_manager',managerInput));
 await waitFor(()=>waiters(['performance_manager_a','performance_manager_b'])===2,'two manager CAS writers truly waiting');await release(h);
 const managerRace=await Promise.all([finish(ma,'manager CAS A'),finish(mb,'manager CAS B')]);assert.deepEqual(managerRace.map(r=>r.status).sort(),[0,3]);assert.match(managerRace.find(r=>r.status===3).stderr,/PT409/);
 assert.equal(query(`select manager_version from private.performance_reviews where id=${quote(id)}`).trim(),'1');console.log('PASS: concurrent manager CAS also has exactly one winner');
 const freshStart=`begin;set local role authenticated;${claims(2)}select public.start_performance_review(${quote(op(201))},${quote(person(6))},'2027','2027-12-31');commit;`;
 h=await guard('performance_guard_start',roleLock);
 const sa=connection(socket,'performance_start_a',freshStart),sb=connection(socket,'performance_start_b',freshStart);
 await waitFor(()=>waiters(['performance_start_a','performance_start_b'])===2,'two identical starts truly waiting');await release(h);
 const starts=await Promise.all([finish(sa,'start A'),finish(sb,'start B')]);assert.ok(starts.every(r=>r.status===0));assert.equal(starts[0].stdout,starts[1].stdout);
 assert.equal(query(`select count(*) from private.performance_reviews where employee_person_id=${quote(person(6))} and cycle='2027'`).trim(),'1');console.log('PASS: concurrent same start operation creates one persistent person-cycle review');
 const freshOther=JSON.parse(query(`begin;set local role authenticated;${claims(2)}select public.start_performance_review(${quote(op(202))},${quote(person(1))},'2028','2028-12-31');commit;`).trim().split('\n').at(-1));
 const one=connection(socket,'performance_distinct_one',request(1,freshOther.review.id,'self:0',10,'save_self',selfInput('Independent one')));
 const two=connection(socket,'performance_distinct_two',request(6,other.review.id,'self:1',11,'save_self',selfInput('Independent two')));
 const distinct=await Promise.all([finish(one,'independent one'),finish(two,'independent two')]);assert.ok(distinct.every(r=>r.status===0));console.log('PASS: two people use independent visible CAS tokens without singleton conflicts');

}
if(process.argv[1]===new URL(import.meta.url).pathname) await ownedRun(async socket=>{setup(socket,database);await runPerformanceConcurrency(socket);});
