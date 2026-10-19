import assert from 'node:assert/strict';
import {test, before, after} from 'node:test';
import {existsSync, readFileSync} from 'node:fs';
import {ownedCluster, actor, person, q, rows} from './performance-review-production-harness.mjs';
import {binding as canonicalBinding,fixture} from './performance-review-master-sync-fixtures.mjs';
import {harness,request} from './performance-review-master-sync-harness.mjs';
import {runMasterJob} from '../deploy/n8n/performance-review-master-sync-v1/classify-result.mjs';
import {psqlSession,waitForOwnedLocks} from './performance-review-master-sync-concurrency.mjs';

export const migration = 'supabase/migrations/20261019000000_performance_review_master_sync.sql';
let c;
const db = 'mam_test_pr_master';
const binding = canonicalBinding;
const start = (op='c5100000-0000-4000-8000-000000000001',cycle='2026',employee=1) => actor(2,`select public.start_performance_review(${q(op)},${q(person(employee))},${q(cycle)},'2026-12-31');`);
const get = sql => rows(c.sql(db,sql))[0];
before(()=>{
  c=ownedCluster(17); c.setup(db);
  c.sql(db,readFileSync('supabase/migrations/20261017103000_performance_review_completion_guards.sql','utf8'));
  c.sql('postgres',`create database mam_test_pr_master_predecessor template ${db};`);
  if(existsSync(migration))c.sql(db,readFileSync(migration,'utf8'));
  c.sql('postgres',`create database mam_test_pr_master_template template ${db};`);
});

test('new migration rolls back a post-DDL unrelated ACL fault instead of adopting a new purge baseline',()=>{
 const database='mam_test_pr_master_guard_red';c.sql('postgres',`create database ${database} template mam_test_pr_master_predecessor;`);
 const source=readFileSync(migration,'utf8');const fault=source.replace('update private.confirmed_test_purge_schema set schema_hash=',"grant select on public.profiles to authenticated;\nupdate private.confirmed_test_purge_schema set schema_hash=");
 const result=c.run(database,fault);assert.equal(result.status,3,'the new Master transaction must preserve every unrelated ACL');assert.match(result.stderr,/55000/);
 assert.match(c.sql(database,"select to_regclass('private.performance_review_master_queue') is null;"),/^t$/m);
});
after(()=>c?.stop());

for(const [index,label,faultSql] of [
 [1,'new routine security','alter function public.begin_performance_review_master_sync(uuid,uuid,bigint,text,text) security invoker;'],
 [2,'new table columns','alter table private.performance_review_master_queue add column unreviewed text;'],
 [3,'default ACL','alter default privileges in schema private revoke select on tables from authenticated;'],
 [4,'old RLS policy',"create policy master_fault on public.profiles for select to authenticated using(true);"],
 [5,'old routine configuration',"alter function private.performance_review_text(jsonb) set search_path=public;"],
])test('new migration rejects '+label+' drift atomically',()=>{
 const database='mam_test_pr_master_fault_'+index;c.sql('postgres',`create database ${database} template mam_test_pr_master_predecessor;`);
 const fault=readFileSync(migration,'utf8').replace('update private.confirmed_test_purge_schema set schema_hash=',faultSql+'\nupdate private.confirmed_test_purge_schema set schema_hash=');
 const result=c.run(database,fault);assert.equal(result.status,3,'must reject the exact injected drift');assert.match(result.stderr,/55000/);
 assert.match(c.sql(database,"select to_regclass('private.performance_review_master_queue') is null;"),/^t$/m);
});

test('committed native start reaches a durable service claim, exact row receipt and settlement',()=>{
  assert.match(c.sql(db,"select to_regprocedure('public.claim_performance_review_master_sync(text,integer)') is not null;"),/^t$/m,'native Master service must exist');
  c.sql(db,`update private.performance_review_master_targets set enabled=true,writer_admitted=true,capture_after=clock_timestamp(),binding=${q(JSON.stringify(binding))}::jsonb where target_key='master-reviews-v1';`);
  const started=rows(c.sql(db,start())).at(-1); const reviewId=started.review.id;
  const result=get("set role service_role; select public.claim_performance_review_master_sync('master-reviews-v1',1);");
  assert.equal(result.length,1); const job=result[0];
  assert.equal(job.reviewId,reviewId); assert.equal(job.revision,1);assert.equal(job.approvedColumnValues.length,53);
  assert.equal(job.approvedColumnValues[0],reviewId);assert.equal(job.approvedColumnValues[1],'Synthetic person 1');assert.equal(job.slot,0);
  assert.match(c.sql(db,`set role service_role; select public.begin_performance_review_master_sync(${q(job.jobId)},${q(job.claimToken)},1,${q(job.projectionSha256)},${q(job.targetFingerprint)});`),/^t$/m);
  const receipt={targetFingerprint:job.targetFingerprint,reviewId,revision:1,projectionSha256:job.projectionSha256,range:'C7:BC7',values:job.approvedColumnValues};
  assert.match(c.sql(db,`set role service_role; select public.finish_performance_review_master_sync(${q(job.jobId)},${q(job.claimToken)},1,${q(job.projectionSha256)},'verified',${q(JSON.stringify(receipt))}::jsonb);`),/^t$/m);
  const state=get(`select jsonb_build_object('applied',applied_revision,'desired',desired_revision,'hash',desired_sha256) from private.performance_review_master_queue where review_id=${q(reviewId)};`);
  assert.equal(state.applied,1);assert.equal(state.desired,1);assert.equal(state.hash,job.projectionSha256);
  assert.equal(get("set role service_role; select public.claim_performance_review_master_sync('master-reviews-v1',1);").length,0);
});

test('real native committed change traverses the actual protected handler, Excel worker and SQL receipt',async()=>{
  const started=rows(c.sql(db,start('c5100000-0000-4000-8000-000000000002','2027'))).at(-1);
  const h=harness({rpc:(name,args)=>{
    const call=Object.entries(args).map(([key,value])=>key+'=>'+(value!==null && typeof value==='object'?q(JSON.stringify(value))+'::jsonb':q(value))).join(',');
    return {error:null,data:get(`set role service_role; select jsonb_build_object('data',public.${name}(${call}));`).data};
  }});
  const response=await h.handle(request({phase:'claim'}));assert.equal(response.status,200,'real SQL claim must pass the real closed service validator');
  const job=(await response.json()).jobs[0];assert.equal(job.reviewId,started.review.id);
  const f=fixture();f.job=job;f.state.keys[0]=get("select desired_values from private.performance_review_master_queue where slot=0;")[0];
  const originalRead=f.ports.read;
  f.ports.read=async req=>{const r=await originalRead(req);if(req.kind==='row'){r.body.address="'Consolidated Reviews'!C8:BC8";r.body.rowIndex=7;}return r;};
  f.ports.patch=async req=>{f.state.writes.push(req);f.state.row=req.body.values[0].slice();f.state.keys[job.slot]=job.reviewId;return {status:200,body:{address:"'Consolidated Reviews'!C8:BC8",rowIndex:7,columnIndex:2,rowCount:1,columnCount:53,values:[f.state.row.slice()],formulas:[f.state.formulas.slice()],numberFormat:[f.state.formats.slice()]}};};
  async function phase(body){const r=await h.handle(request(body));assert.equal(r.status,200);return r.json();}
  f.ports.begin=async()=> (await phase({phase:'begin',jobId:job.jobId,claimToken:job.claimToken,revision:job.revision,projectionSha256:job.projectionSha256,targetFingerprint:job.targetFingerprint})).allowed;
  f.ports.finish=async(outcome,receipt)=> (await phase({phase:'finish',jobId:job.jobId,claimToken:job.claimToken,revision:job.revision,projectionSha256:job.projectionSha256,outcome,receipt})).recorded;
  assert.equal((await runMasterJob(job,binding,f.ports)).status,'verified');
  assert.equal(f.state.writes.length,1);assert.equal(get(`select jsonb_build_object('applied',applied_revision) from private.performance_review_master_queue where review_id=${q(job.reviewId)};`).applied,1);
  assert.equal(h.counts.claims,0);assert.deepEqual(h.logs,[]);
});

let caseNumber=0;
function newCase(enabled=true){
 const database='mam_test_pr_master_case_'+(++caseNumber);
 c.sql('postgres',`create database ${database} template mam_test_pr_master_template;`);
 if(enabled)c.sql(database,`update private.performance_review_master_targets set enabled=true,writer_admitted=true,capture_after=clock_timestamp(),binding=${q(JSON.stringify(binding))}::jsonb;`);
 const json=sql=>rows(c.sql(database,sql)).at(-1);
 const rpc=(name,args)=>json(`set role service_role;select jsonb_build_object('data',public.${name}(${args}));`).data;
 const claim=()=>rpc('claim_performance_review_master_sync',"'master-reviews-v1',1");
 const begin=job=>rpc('begin_performance_review_master_sync',`${q(job.jobId)},${q(job.claimToken)},${job.revision},${q(job.projectionSha256)},${q(job.targetFingerprint)}`);
 const receipt=job=>({targetFingerprint:job.targetFingerprint,reviewId:job.reviewId,revision:job.revision,projectionSha256:job.projectionSha256,range:`C${7+job.slot}:BC${7+job.slot}`,values:job.approvedColumnValues});
 const finish=(job,outcome='verified',r=outcome==='verified'?receipt(job):null)=>rpc('finish_performance_review_master_sync',`${q(job.jobId)},${q(job.claimToken)},${job.revision},${q(job.projectionSha256)},${q(outcome)},${r===null?'null':q(JSON.stringify(r))+'::jsonb'}`);
 const create=(cycle='2026',employee=1,op='c7100000-0000-4000-8000-000000000001')=>json(start(op,cycle,employee)).review.id;
 return {database,json,rpc,claim,begin,finish,receipt,create};
}

test('all actual business stages enforce preview privacy, immutable final, rollback and Careers preservation',()=>{
 const f=newCase();c.sql(f.database,readFileSync('tests/performance-review-master-sync.sql','utf8'));
 const job=f.claim()[0];assert.equal(f.begin(job),true);assert.equal(f.finish(job,'unknown'),true);
 assert.deepEqual(f.json("select jsonb_build_object('count',count(*),'queued',bool_and(state='queued')) from private.performance_review_mail_outbox;"),{count:1,queued:true});
 assert.equal(f.json("select jsonb_build_object('final',bool_and(finalised_at is not null)) from private.performance_reviews;").final,true);
});

test('final 53-column native projection traverses the protected entry and literal Excel writer without the private note',async()=>{
 const f=newCase();c.sql(f.database,readFileSync('tests/performance-review-master-sync.sql','utf8'));
 const h=harness({rpc:(name,args)=>{const call=Object.entries(args).map(([key,value])=>key+'=>'+(value!==null && typeof value==='object'?q(JSON.stringify(value))+'::jsonb':q(value))).join(',');return {error:null,data:f.json(`set role service_role;select jsonb_build_object('data',public.${name}(${call}));`).data};}});
 async function phase(body){const response=await h.handle(request(body));assert.equal(response.status,200);return response.json();}
 const job=(await phase({phase:'claim'})).jobs[0],excel=fixture();assert.equal(job.revision,5);assert.equal(job.approvedColumnValues[3],'Submitted');assert.equal(job.approvedColumnValues[19],'Synthetic FINAL notes');assert.equal(job.approvedColumnValues[15],5);assert.equal(JSON.stringify(job).includes('SYNTHETIC_PRIVATE_NOTE'),false);
 excel.state.formats[15]='0';excel.ports.begin=async()=> (await phase({phase:'begin',jobId:job.jobId,claimToken:job.claimToken,revision:job.revision,projectionSha256:job.projectionSha256,targetFingerprint:job.targetFingerprint})).allowed;
 excel.ports.finish=async(outcome,receipt)=> (await phase({phase:'finish',jobId:job.jobId,claimToken:job.claimToken,revision:job.revision,projectionSha256:job.projectionSha256,outcome,receipt})).recorded;
 assert.equal((await runMasterJob(job,binding,excel.ports)).status,'verified');assert.deepEqual(excel.state.row,job.approvedColumnValues);assert.equal(excel.state.writes.length,1);assert.equal(f.json("select jsonb_build_object('applied',applied_revision) from private.performance_review_master_queue;").applied,5);assert.deepEqual(h.logs,[]);
});

test('native operation replay, stale CAS and rejected authorization produce no extra Master generation',()=>{
 const f=newCase();const id=f.create();assert.equal(f.create(),id);
 const snapshot=()=>f.json("select jsonb_build_object('queue',(select jsonb_agg(to_jsonb(q)) from private.performance_review_master_queue q),'events',(select count(*) from private.performance_review_events));");const before=snapshot();
 for(const [actorId,revision,command,input,state] of [[1,'self:9','save_self',{answers:Array(12).fill('Synthetic')},'PT409'],[3,'manager:0:0','complete_manager',{},'42501']]){
  const result=c.run(f.database,actor(actorId,`select public.mutate_performance_review('c7300000-0000-4000-8000-000000000001',${q(id)},${q(revision)},${q(command)},${q(JSON.stringify(input))}::jsonb);`));assert.equal(result.status,3);assert.ok(result.stderr.includes(state));assert.deepEqual(snapshot(),before);
 }
});

test('SQL closed binding rejects arbitrary target fields and unapproved connection identity',()=>{
 const f=newCase(false);
 for(const bad of [{...binding,url:'https://example.invalid'},{...binding,connectionId:'90000000-0000-4000-8000-000000000003'},{...binding,capacity:0},{...binding,headerRow:0},{...binding,columnIds:['1']},{...binding,documentId:null},{...binding,namespace:null},{...binding,connectionId:null},{...binding,tableName:null},{...binding,worksheetName:null}]){
  const result=c.run(f.database,`update private.performance_review_master_targets set binding=${q(JSON.stringify(bad))}::jsonb;`);
  assert.equal(result.status,3,'invalid binding must be denied natively');assert.match(result.stderr,/23514/);
 }
});

test('generation created after claim is retained and late receipts cannot downgrade a later applied generation',()=>{
 const f=newCase();const id=f.create();const first=f.claim()[0];
 c.sql(f.database,`update private.performance_reviews set employee_identity=jsonb_set(employee_identity,'{team}','"Future team 2"') where id=${q(id)};`);
 assert.equal(f.begin(first),false);const second=f.claim()[0];assert.equal(second.revision,2);assert.equal(f.begin(second),true);
 c.sql(f.database,`update private.performance_reviews set employee_identity=jsonb_set(employee_identity,'{team}','"Future team 3"') where id=${q(id)};`);
 assert.equal(f.finish(second),true);const third=f.claim()[0];assert.equal(third.revision,3);assert.equal(f.begin(third),true);
 assert.equal(f.finish(third,'verified',{...f.receipt(third),range:'A1:BA1'}),false);
 assert.equal(f.finish(third),true);assert.equal(f.finish(second),true);assert.equal(f.begin(second),false);
 const state=f.json(`select jsonb_build_object('applied',applied_revision,'desired',desired_revision) from private.performance_review_master_queue where review_id=${q(id)};`);
 assert.deepEqual(state,{applied:3,desired:3});assert.deepEqual(f.claim(),[]);
});

test('unknown entered writes are sticky across apparent age and matching readback, blocking the whole target',()=>{
 const f=newCase();f.create();const job=f.claim()[0];assert.equal(f.begin(job),true);assert.equal(f.begin(job),false);assert.equal(f.finish(job,'unknown'),true);
 c.sql(f.database,"update private.performance_review_master_attempts set claimed_at='2001-01-01',entered_at='2001-01-01';");
 f.create('2027',6,'c7100000-0000-4000-8000-000000000002');
 assert.deepEqual(f.claim(),[]);assert.equal(f.finish(job),false);assert.equal(f.finish(job,'prewrite_failed'),false);
 assert.deepEqual(f.rpc('reconcile_performance_review_master_sync',`${q(job.jobId)},${q(job.claimToken)}`),{decision:'hold'});
 assert.equal(f.json("select jsonb_build_object('held',held,'active',active_job) from private.performance_review_master_targets;").held,true);
});

test('known settled write may reconcile read-only while a lost claim acknowledgement is never reclaimed',()=>{
 const f=newCase();f.create();const job=f.claim()[0];assert.deepEqual(f.claim(),[]);assert.equal(f.begin(job),true);assert.equal(f.finish(job,'readback_pending'),true);
 assert.deepEqual(f.rpc('reconcile_performance_review_master_sync',`${q(job.jobId)},${q(job.claimToken)}`),{decision:'read_only'});
 assert.deepEqual(f.claim(),[]);assert.equal(f.finish(job),true);assert.equal(f.finish(job),true);
});

test('forward cutover does not scan history but a future committed visible change updates an old review',()=>{
 const f=newCase(false);const id=f.create();assert.equal(f.json("select jsonb_build_object('count',count(*)) from private.performance_review_master_queue;").count,0);
 c.sql(f.database,`update private.performance_review_master_targets set enabled=true,writer_admitted=true,capture_after=clock_timestamp(),binding=${q(JSON.stringify(binding))}::jsonb;`);
 assert.deepEqual(f.claim(),[]);
 c.sql(f.database,actor(1,`select public.mutate_performance_review('c7200000-0000-4000-8000-000000000001',${q(id)},'self:0','save_self',jsonb_build_object('answers',to_jsonb(array_fill('Draft'::text,array[12]))));`));
 assert.deepEqual(f.claim(),[]);
 c.sql(f.database,actor(1,`select public.mutate_performance_review('c7200000-0000-4000-8000-000000000002',${q(id)},'self:1','submit_self',jsonb_build_object('answers',to_jsonb(array_fill('Submitted'::text,array[12]))));`));
 assert.equal(f.claim()[0].reviewId,id);
});

test('two real native-shaped source transactions commit in reverse event sequence order without losing either projection',async()=>{
 const f=newCase();const firstId=f.create(),secondId=f.create('2026',6,'c8100000-0000-4000-8000-000000000002');
 const a=psqlSession(c,f.database,'master_reverse_a'),b=psqlSession(c,f.database,'master_reverse_b');
 const sourceChange=(id,personIndex)=>`begin;update private.performance_reviews set self_answers=to_jsonb(array_fill('Synthetic committed answer'::text,array[12])),self_submitted_at=clock_timestamp(),self_version=self_version+1 where id=${q(id)};insert into private.performance_review_events(review_id,subject_person_id,actor_user_id,kind) values(${q(id)},${q(person(personIndex))},${q('a1000000-0000-4000-8000-'+String(personIndex).padStart(12,'0'))},'submit_self');`;
 try{
  a.write(sourceChange(firstId,1)+"select 'MASTER_A_READY';");await a.ready('MASTER_A_READY');
  b.write(sourceChange(secondId,6)+"select 'MASTER_B_READY';");await b.ready('MASTER_B_READY');
  b.end('commit;');assert.equal((await b.done).code,0);
  assert.equal(f.json("select jsonb_build_object('count',count(*)) from private.performance_review_master_queue where desired_revision=2;").count,1);
  const second=f.json("select jsonb_build_object('event',max(id)) from private.performance_review_events where kind='submit_self';").event;
  a.end('commit;');assert.equal((await a.done).code,0);
  const all=f.json("select jsonb_build_object('events',count(*),'first',min(id),'last',max(id)) from private.performance_review_events where kind='submit_self';");
  assert.equal(all.events,2);assert.equal(second,all.last);assert.ok(all.first<second);assert.equal(f.json("select jsonb_build_object('count',count(*)) from private.performance_review_master_queue where desired_revision=2;").count,2);
 }finally{await a.cleanup();await b.cleanup();}
});

test('two real service claimers waiting on the same target admit exactly one durable writer',async()=>{
 const f=newCase();f.create();const holder=psqlSession(c,f.database,'master_claim_holder'),a=psqlSession(c,f.database,'master_claim_a'),b=psqlSession(c,f.database,'master_claim_b');
 try{
  holder.write("begin;select target_key from private.performance_review_master_targets for update;select 'MASTER_LOCKED';");await holder.ready('MASTER_LOCKED');
  for(const session of [a,b]){session.write("set role service_role;select public.claim_performance_review_master_sync('master-reviews-v1',1);");session.end();}
  assert.equal(await waitForOwnedLocks(c,f.database,['master_claim_a','master_claim_b']),2);
  holder.end('rollback;');assert.equal((await holder.done).code,0);
  const results=await Promise.all([a.done,b.done]);assert.ok(results.every(r=>r.code===0));assert.deepEqual(results.map(r=>rows(r.stdout)[0].length).sort(),[0,1]);
  assert.equal(f.json("select jsonb_build_object('attempts',count(*)) from private.performance_review_master_attempts;").attempts,1);
 }finally{await holder.cleanup();await a.cleanup();await b.cleanup();}
});

test('exhausted approved capacity surfaces HOLD without append, resize or a new writer',()=>{
 const f=newCase();c.sql(f.database,"update private.performance_review_master_targets set binding=jsonb_set(binding,'{capacity}','1');");f.create();const job=f.claim()[0];assert.equal(f.begin(job),true);assert.equal(f.finish(job),true);
 f.create('2027',6,'c7400000-0000-4000-8000-000000000001');
 const result=c.run(f.database,"set role service_role;select public.claim_performance_review_master_sync('master-reviews-v1',1);");
 assert.equal(result.status,3,'capacity exhaustion must not masquerade as an idle queue');assert.match(result.stderr,/55000/);
 assert.equal(f.json("select jsonb_build_object('attempts',count(*)) from private.performance_review_master_attempts;").attempts,1);
});

test('manager edit after recorded meeting clears completion and hides the unfinished assessment',()=>{
 const f=newCase();const id=f.create();const input={answers:Array(12).fill('Synthetic manager'),ratings:Array(12).fill('2 Meets expectations'),summary:'Synthetic summary',overallRating:'2 Meets expectations',managerNote:'Synthetic private'};
 c.sql(f.database,actor(1,`select public.mutate_performance_review('c7500000-0000-4000-8000-000000000001',${q(id)},'self:0','submit_self',jsonb_build_object('answers',to_jsonb(array_fill('Synthetic employee'::text,array[12]))));`));
 c.sql(f.database,actor(2,`select public.mutate_performance_review('c7500000-0000-4000-8000-000000000002',${q(id)},'manager:1:0','complete_manager',${q(JSON.stringify(input))}::jsonb);`));
 c.sql(f.database,actor(2,`select public.mutate_performance_review('c7500000-0000-4000-8000-000000000003',${q(id)},'manager:1:1','save_meeting','{"date":"2026-01-02","time":"10:00","duration":5,"mode":"phone","location":"Synthetic","notes":"Draft"}');`));
 c.sql(f.database,actor(2,`select public.mutate_performance_review('c7500000-0000-4000-8000-000000000004',${q(id)},'manager:1:2','save_manager',${q(JSON.stringify(input))}::jsonb);`));
 const state=f.json("select jsonb_build_object('values',desired_values,'revision',desired_revision) from private.performance_review_master_queue;");assert.equal(state.values[3],'Awaiting Manager');assert.equal(state.values[9],'No');assert.equal(state.values[12],'Yes');assert.equal(state.values[20],'');assert.ok(state.values.slice(34).every(v=>v===''));
});

test('native ACL/RLS deny all direct tables and restrict four public service RPCs',()=>{
 const f=newCase();
 for(const role of ['anon','authenticated','service_role'])for(const table of ['targets','queue','attempts']){
  const result=c.run(f.database,`set role ${role};select * from private.performance_review_master_${table};`);assert.equal(result.status,3);assert.match(result.stderr,/42501/);
 }
 for(const role of ['anon','authenticated']){
  const result=c.run(f.database,`set role ${role};select public.claim_performance_review_master_sync('master-reviews-v1',1);`);assert.equal(result.status,3);assert.match(result.stderr,/42501/);
 }
 assert.equal(f.json("select jsonb_build_object('rls',bool_and(relrowsecurity and relforcerowsecurity),'count',count(*)) from pg_class where oid in ('private.performance_review_master_targets'::regclass,'private.performance_review_master_queue'::regclass,'private.performance_review_master_attempts'::regclass);").rls,true);
 assert.match(c.sql(f.database,"select private.confirmed_test_purge_schema_hash()=(select schema_hash from private.confirmed_test_purge_schema where singleton);"),/^t$/m);
});
