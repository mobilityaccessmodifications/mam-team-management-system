import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {spawnSync,spawn} from 'node:child_process';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ownedCluster,env,evidence,q,rows} from './performance-review-production-harness.mjs';
const out=mkdtempSync(path.join(evidence,'native-envelope-'));
let c,expression,ordinal=0;
function bridge(...args){
 const result=spawnSync('python3',['-B','tests/performance-review-production-native-builder.py',...args],{encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stderr);return result.stdout;
}
function observe(db){return rows(c.sql(db,expression))[0];}
const sha=value=>createHash('sha256').update(value).digest('hex');
function schema(db,file){
 const result=spawnSync('pg_dump',['-h',c.socket,'-p',String(c.port),'-U','postgres','-d',db,'--schema-only'],{env,encoding:'utf8',timeout:30000,maxBuffer:32*1024*1024});
 writeFileSync(file,result.stdout??'');writeFileSync(file+'.stderr',result.stderr??'');assert.equal(result.status,0,result.stderr);
 return result.stdout.split('\n').filter(line=>!/^\\(?:un)?restrict [A-Za-z0-9]+$/.test(line)).join('\n');
}
function prepare(label,extra=''){
 const db='mam_test_pr_envelope_'+String(++ordinal);c.setup(db,false);
 const predecessor=readFileSync('supabase/migrations/20261014233948_subscription_request_start_date.sql','utf8');
 c.sql(db,`create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);create schema synthetic_external;create table synthetic_external.protected(id integer);revoke all on schema synthetic_external from public,anon,authenticated,service_role;
 insert into supabase_migrations.schema_migrations values('20260101000000','synthetic_null',null),('20260101000001','synthetic_empty','{}'),('20260101000002','synthetic_elements','[0:2]={"synthetic-a",NULL,"synthetic-b"}'),('20261014233948','subscription_request_start_date',ARRAY[${q(predecessor)}]);\n${extra}`);
 const before=observe(db),file=path.join(out,label+'.before.json');writeFileSync(file,JSON.stringify(before));
 const sql=bridge('build',file);writeFileSync(path.join(out,label+'.generated.sql'),sql);
 assert.equal((sql.match(/lock table supabase_migrations.schema_migrations in access exclusive mode nowait;/g)||[]).length,1);
 const beforeSchema=schema(db,path.join(out,label+'.before.schema.sql'));
 return {db,before,file,sql,beforeSchema};
}
function unchanged(s){
 const after=observe(s.db);assert.deepEqual(after,s.before);assert.equal(after.targetExact,false);
 writeFileSync(path.join(out,path.basename(s.file).replace('.before.','.rollback.')),JSON.stringify(after));
 const afterSchema=schema(s.db,s.file.replace('.before.json','.rollback.schema.sql'));assert.equal(afterSchema,s.beforeSchema);
 writeFileSync(s.file.replace('.before.json','.rollback-proof.json'),JSON.stringify({database:s.db,fullSchemaSha256:sha(afterSchema),rawLedgerExact:true,protectedDataExact:true,purgeReceiptsExact:true,fingerprintExact:true,completeStateExact:true}));
}
before(()=>{c=ownedCluster();expression=bridge('expression');});
after(()=>c?.stop());
test('generated release transaction commits exact source and independently preserves native NULL empty and lower-bound history',()=>{
 const s=prepare('positive');const result=c.run(s.db,s.sql);assert.equal(result.status,0,result.stderr);
 const after=observe(s.db),file=path.join(out,'positive.after.json');writeFileSync(file,JSON.stringify(after));
 assert.equal(after.targetExact,true);assert.equal(after.ledger.length,s.before.ledger.length+1);assert.deepEqual(after.ledger.slice(0,-1),s.before.ledger);
 assert.equal(after.ledger[2].dimensions,'[0:2]');assert.equal(after.ledger[2].elements[1].isNull,true);
 assert.equal(after.securityHash,s.before.securityHash);assert.equal(after.dataHash,s.before.dataHash);
 assert.equal(JSON.parse(bridge('validate',s.file,file)).readbackVerified,true);
});
function beforeLedger(sql,fault){
 const marker='\ninsert into supabase_migrations.schema_migrations(version,name,statements) values(';assert.equal(sql.split(marker).length,2);
 return sql.replace(marker,()=>`\n${fault}\ninsert into supabase_migrations.schema_migrations(version,name,statements) values(`);
}
for(const [label,fault] of [
 ['external_schema','grant usage on schema synthetic_external to anon;'],
 ['role_attribute','alter role anon createdb;'],
 ['history_bound',"update supabase_migrations.schema_migrations set statements='[1:3]={\"synthetic-a\",NULL,\"synthetic-b\"}'::text[] where version='20260101000002';"],
 ['history_source',"update supabase_migrations.schema_migrations set statements=ARRAY['different'] where version='20260101000002';"]
])test(`generated release transaction rolls back late ${label} drift`,()=>{
 const s=prepare(label);const result=c.run(s.db,beforeLedger(s.sql,fault));assert.equal(result.status,3,result.stderr);assert.match(result.stderr,/55000/);unchanged(s);
});
test('generated release transaction drains a genuinely deferred final-ledger security fault',()=>{
 const s=prepare('deferred',`create function synthetic_external.late_grant() returns trigger language plpgsql as $$ begin grant usage on schema synthetic_external to anon;return new;end $$;create constraint trigger synthetic_performance_late after insert on supabase_migrations.schema_migrations deferrable initially deferred for each row execute function synthetic_external.late_grant();`);
 const result=c.run(s.db,beforeLedger(s.sql,'set constraints supabase_migrations.synthetic_performance_late deferred;'));assert.equal(result.status,3,result.stderr);assert.match(result.stderr,/55000/);unchanged(s);
});
test('generated release transaction rejects a stale protected-data before frame before feature DDL',()=>{
 const s=prepare('stale');c.sql(s.db,"update public.internal_org_people set full_name='Synthetic changed' where id='b1000000-0000-4000-8000-000000000001';");
 const actual=observe(s.db);assert.notEqual(actual.dataHash,s.before.dataHash);
 const result=c.run(s.db,s.sql);assert.equal(result.status,3,result.stderr);assert.match(result.stderr,/locked predecessor changed/);assert.deepEqual(observe(s.db),actual);
});
for(const [label,held] of [
 ['role_control',"select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));"],
 ['ledger_lock','lock table supabase_migrations.schema_migrations in access exclusive mode;'],
 ['ordinary_writer','lock table public.profiles in row exclusive mode;']
])test(`generated release transaction refuses concurrent ${label} without waiting`,async()=>{
 const s=prepare(label),prefix=path.join(out,label+'.holder');
 const holder=spawn('psql',['-X','-h',c.socket,'-p',String(c.port),'-U','postgres','-d',s.db,'-At','-v','ON_ERROR_STOP=1','-f','-'],{env,stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';holder.stdout.on('data',chunk=>{stdout+=chunk;});holder.stderr.on('data',chunk=>{stderr+=chunk;});
 const closed=new Promise(resolve=>holder.on('close',(exit,signal)=>resolve({exit,signal})));
 try{
  holder.stdin.write(`begin;${held}select 'holder-ready';\n`);
  await new Promise((resolve,reject)=>{const until=Date.now()+5000;const timer=setInterval(()=>{if(stdout.includes('holder-ready')){clearInterval(timer);resolve();}else if(Date.now()>until){clearInterval(timer);reject(new Error('owned holder readiness timed out'));}},10);});
  const started=Date.now(),result=c.run(s.db,s.sql);assert.equal(result.status,3,result.stderr);assert.match(result.stderr,/55P03/);assert.ok(Date.now()-started<4000);
 }finally{
  holder.stdin.end('rollback;\n');const receipt=await closed;writeFileSync(prefix+'.stdout.log',stdout);writeFileSync(prefix+'.stderr.log',stderr);writeFileSync(prefix+'.receipt.json',JSON.stringify(receipt));assert.equal(receipt.exit,0,stderr);
 }
 unchanged(s);
});
function injectLive(sql,phase,fault){
 const source=readFileSync('supabase/migrations/20261016150000_performance_reviews_and_mail.sql','utf8');
 const body=source.slice('begin;\n'.length,-'commit;\n'.length);
 const boundary=sql.indexOf('end $performance_release_before$;\n')+'end $performance_release_before$;\n'.length;
 assert.ok(boundary>0);assert.equal(sql.slice(boundary,boundary+body.length),body);
 const assertions=[...body.matchAll(/select pg_temp\.performance_release_assert\(\);/g)];assert.equal(assertions.length,2);
 const position=phase==='pre_refresh'?boundary+assertions[0].index:phase==='post_refresh'?boundary+assertions[1].index:sql.lastIndexOf('\ndo $performance_release_final$ declare actual jsonb:=')+1;
 assert.ok(position>=boundary&&position<sql.length);
 if(phase==='final')assert.ok(position>boundary+body.length);
 const insertion=fault+'\n';const modified=sql.slice(0,position)+insertion+sql.slice(position);
 const restored=modified.slice(0,position)+modified.slice(position+insertion.length);assert.equal(restored,sql);
 writeFileSync(path.join(out,'injection-'+String(ordinal)+'.json'),JSON.stringify({phase,liveCoreStart:boundary,liveCoreEnd:boundary+body.length,position,insertionSha256:sha(insertion),originalQuerySha256:sha(sql),faultQuerySha256:sha(modified),restoredQuerySha256:sha(restored),restoredByteExact:true}));
 return modified;
}
for(const phase of ['pre_refresh','post_refresh','final'])test(`native FK trigger ${phase} rejects an unknown internal trigger name without pinning an installation OID`,()=>{
 const s=prepare('fk_name_'+phase);
 const fault=`do $fault$ declare name text;begin select t.tgname into strict name from pg_trigger t join pg_constraint k on k.oid=t.tgconstraint where k.conname='performance_reviews_employee_person_id_fkey' and t.tgrelid='private.performance_reviews'::regclass and t.tgfoid='pg_catalog."RI_FKey_check_ins"()'::regprocedure;execute format('alter trigger %I on private.performance_reviews rename to unreviewed_fk_name',name);end $fault$;`;
 const result=c.run(s.db,injectLive(s.sql,phase,fault));assert.equal(result.status,3,result.stderr);assert.match(result.stderr,/55000/);unchanged(s);
});
const protectedTables=['performance_reviews','performance_review_events','performance_review_operations','performance_review_mail_outbox'];
function triggerFault(table,kind){
 const relation='private.'+table;
 if(kind==='rename')return `alter trigger reject_retired_test_identity_reference on ${relation} rename to unreviewed_retirement_trigger;`;
 if(kind==='addition')return `create trigger unreviewed_retirement_trigger before insert or update on ${relation} for each row execute function private.reject_retired_test_identity_reference();`;
 return `create or replace trigger reject_retired_test_identity_reference before insert or update${kind==='update_of'?' of '+(table==='performance_reviews'?'employee_person_id':'review_id'):''} on ${relation} for each row ${kind==='when'?'when(false) ':''}execute function private.reject_retired_test_identity_reference();`;
}
for(const phase of ['pre_refresh','post_refresh','final','readback'])for(const table of protectedTables)for(const kind of ['when','update_of','rename','addition'])test(`new trigger ${phase} ${table} ${kind} rejects exact-contract drift`,()=>{
 const label=[phase,table,kind].join('_');const s=prepare(label);const fault=triggerFault(table,kind);
 if(phase==='readback'){
  const result=c.run(s.db,s.sql);assert.equal(result.status,0,result.stderr);
  const good=observe(s.db),goodFile=path.join(out,label+'.good.json');writeFileSync(goodFile,JSON.stringify(good));
  assert.equal(JSON.parse(bridge('validate',s.file,goodFile)).readbackVerified,true);
  c.sql(s.db,fault);
  const after=observe(s.db),file=path.join(out,label+'.drift.json');writeFileSync(file,JSON.stringify(after));
  assert.deepEqual(after.ledger,good.ledger);assert.equal(after.dataHash,good.dataHash);assert.notDeepEqual(after.feature,good.feature);
  const denied=spawnSync('python3',['-B','tests/performance-review-production-native-builder.py','validate',s.file,file],{encoding:'utf8',timeout:30000});
  writeFileSync(path.join(out,label+'.validation.json'),JSON.stringify({exit:denied.status,stdout:denied.stdout,stderr:denied.stderr}));
  assert.notEqual(denied.status,0);assert.match(denied.stderr,/Exact performance definitions|Exact predecessor source or captured purge catalog differs/);
 }else{
  const modified=injectLive(s.sql,phase,fault);writeFileSync(path.join(out,label+'.fault.sql'),modified);
  const result=c.run(s.db,modified);assert.equal(result.status,3,result.stderr);assert.match(result.stderr,/55000/);unchanged(s);
 }
});
test('new trigger control commits and independently blocks retired references on all four new tables',()=>{
 const s=prepare('trigger_control');const result=c.run(s.db,s.sql);assert.equal(result.status,0,result.stderr);
 const after=observe(s.db),file=path.join(out,'trigger_control.after.json');writeFileSync(file,JSON.stringify(after));
 assert.equal(JSON.parse(bridge('validate',s.file,file)).readbackVerified,true);
 const retired='b1000000-0000-4000-8000-000000000009',person='b1000000-0000-4000-8000-000000000001',manager='b1000000-0000-4000-8000-000000000002',actor='a1000000-0000-4000-8000-000000000001';
 c.sql(s.db,`insert into private.performance_reviews(id,employee_person_id,assigned_manager_person_id,cycle,due_date,employee_identity,manager_identity) values('${retired}','${person}','${manager}','2049','2049-01-01','{}','{}');insert into private.confirmed_test_identity_purges values('${actor}','complete',ARRAY['${retired}']::uuid[]);`);
 for(const statement of [
  `insert into private.performance_reviews(employee_person_id,assigned_manager_person_id,cycle,due_date,employee_identity,manager_identity) values('${retired}','${manager}','2050','2050-01-01','{}','{}');`,
  `insert into private.performance_review_events(review_id,subject_person_id,actor_user_id,kind) values('${retired}','${person}','${actor}','start');`,
  `insert into private.performance_review_operations(actor_user_id,operation_id,review_id,body,receipt) values('${actor}',gen_random_uuid(),'${retired}','{}','{}');`,
  `insert into private.performance_review_mail_outbox(review_id) values('${retired}');`
 ]){const denied=c.run(s.db,statement);assert.equal(denied.status,3,denied.stderr);assert.match(denied.stderr,/23514/);}
});
