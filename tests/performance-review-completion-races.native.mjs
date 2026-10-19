import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {ownedCluster,rows,actor,q,person,env,evidence} from './performance-review-production-harness.mjs';
const migration='supabase/migrations/20261017103000_performance_review_completion_guards.sql';
const input=value=>({answers:Array(12).fill(value),ratings:Array(12).fill('2 Meets expectations'),summary:'Summary',overallRating:'2 Meets expectations',managerNote:'PRIVATE-NOTE'});
const meeting={date:'2026-01-02',time:'10:00',duration:30,mode:'in_person',location:'Synthetic room',notes:'Synthetic notes',held:true};
const mutate=(id,revision,command,value,op)=>`select public.mutate_performance_review('${op}',${q(id)},${q(revision)},${q(command)},${q(JSON.stringify(value))}::jsonb);`;
function connection(c,db,name) {
 const child=spawn('psql',['-X','-h',c.socket,'-p',String(c.port),'-U','postgres','-d',db,'-At','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-f','-'],{env,stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const closed=new Promise(resolve=>child.on('close',(exit,signal)=>{const prefix=path.join(evidence,name);writeFileSync(prefix+'.stdout.log',stdout);writeFileSync(prefix+'.stderr.log',stderr);writeFileSync(prefix+'.receipt.json',JSON.stringify({exit,signal}));resolve({exit,signal,stdout,stderr});}));
 return {child,closed,get stdout(){return stdout;}};
}
async function wait(predicate) {const until=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<until,'Owned native barrier timed out');await new Promise(r=>setTimeout(r,15));}}

test('completion delta retains canonical role self HR Admin P0 privacy meeting CAS replay and sticky mail guards',()=>{
 const c=ownedCluster(17);
 try {const db='mam_test_pr_completion_retained';c.setup(db);c.sql(db,readFileSync(migration,'utf8'));const core=readFileSync('tests/performance-review-production-core.sql','utf8');c.sql(db,core);const end=core.indexOf("select pg_temp.assert_true(current_setting('test.final')");assert.ok(end>0);c.sql(db,core.slice(0,end)+'reset role;\n'+['claim','begin','finish'].map(x=>readFileSync(`tests/performance-review-production-${x}.sql`,'utf8')).join('\n')+'rollback;');}
 finally {c.stop();}
});
test('queued direct final evaluates the locked current revision and actual current Word content',async()=>{
 const c=ownedCluster(17);let holder,queued;
 try {
  const db='mam_test_pr_completion_race';c.setup(db);c.sql(db,readFileSync(migration,'utf8'));
  const started=rows(c.sql(db,actor(2,`select public.start_performance_review('f0000000-0000-4000-8000-000000000001',${q(person(1))},'2026','2026-12-31');`))).find(r=>r.committed),id=started.review.id;
  c.sql(db,actor(1,mutate(id,'self:0','submit_self',{answers:Array(12).fill('x'.repeat(8000))},'f0000000-0000-4000-8000-000000000002')));
  c.sql(db,actor(2,mutate(id,'manager:1:0','complete_manager',input('Evidence'),'f0000000-0000-4000-8000-000000000003')));
  holder=connection(c,db,'completion-holder');queued=connection(c,db,'completion-queued');
  const prefix=actor(2,'').split('commit;')[0];
  const huge=input('\t'.repeat(7999)+'X');
  holder.child.stdin.write(prefix+mutate(id,'manager:1:1','save_manager',huge,'f0000000-0000-4000-8000-000000000004')+mutate(id,'manager:1:2','complete_manager',huge,'f0000000-0000-4000-8000-000000000005')+"select 'holder-ready';\n");
  await wait(()=>holder.stdout.includes('holder-ready'));
  queued.child.stdin.end("set application_name='completion-owned-queued';"+actor(2,mutate(id,'manager:1:3','submit_review',meeting,'f0000000-0000-4000-8000-000000000006')));
  await wait(()=>c.sql(db,"select exists(select 1 from pg_stat_activity where datname=current_database() and application_name='completion-owned-queued' and wait_event_type='Lock' and wait_event='advisory');").trim()==='t');
  holder.child.stdin.end('commit;\n');assert.equal((await holder.closed).exit,0);
  const result=await queued.closed;assert.equal(result.exit,3,result.stderr);assert.match(result.stderr,/22023/);
  assert.equal(c.sql(db,'select count(*) from private.performance_review_mail_outbox;').trim(),'0');
  const state=rows(c.sql(db,`select jsonb_build_object('final',finalised_at is not null,'held',meeting_held_at is not null,'version',manager_version,'answers',manager_answers) from private.performance_reviews where id=${q(id)};`))[0];
  assert.deepEqual(state,{final:false,held:false,version:3,answers:huge.answers});
  const stale=c.run(db,actor(2,mutate(id,'manager:1:1','submit_review',meeting,'f0000000-0000-4000-8000-000000000007')));assert.equal(stale.status,3);assert.match(stale.stderr,/PT409/);
 } finally {
  if(holder?.child.stdin.writable)holder.child.stdin.end('rollback;\n');
  if(queued?.child.stdin.writable)queued.child.stdin.end('rollback;\n');
  await Promise.all([holder?.closed,queued?.closed]);c.stop();
 }
});
