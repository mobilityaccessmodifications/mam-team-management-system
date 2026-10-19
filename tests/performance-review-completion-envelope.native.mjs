import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {ownedCluster,env,evidence,q,rows,actor,person} from './performance-review-production-harness.mjs';
let c,expression,ordinal=0;
const out=mkdtempSync(path.join(evidence,'completion-envelope-'));
function bridge(...args) {const r=spawnSync('python3',['-B','tests/performance-review-completion-native-builder.py',...args],{env,encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout;}
const observe=db=>rows(c.sql(db,expression))[0];
function prepare(extra='',held=false) {
 const db='mam_test_pr_completion_envelope_'+String(++ordinal);c.setup(db);
 const predecessor=readFileSync('supabase/migrations/20261016150000_performance_reviews_and_mail.sql','utf8');
 c.sql(db,`create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);create schema synthetic_external;create table synthetic_external.protected(id integer);alter table synthetic_external.protected enable row level security;create policy blocked on synthetic_external.protected to anon using(false);grant usage on schema synthetic_external to anon;grant select on synthetic_external.protected to anon;insert into synthetic_external.protected values(1);
 insert into supabase_migrations.schema_migrations values('20260101000000','synthetic_null',null),('20260101000001','synthetic_empty','{}'),('20260101000002','synthetic_elements','[0:2]={"synthetic-a",NULL,"synthetic-b"}'),('20261016150000','performance_reviews_and_mail',ARRAY[${q(predecessor)}]);${extra}`);
 const started=rows(c.sql(db,actor(2,`select public.start_performance_review('ee000000-0000-4000-8000-000000000001',${q(person(1))},'2026','2026-12-31');`))).find(r=>r.committed);
 assert.ok(started.review.id);
 if(held) {
  const id=started.review.id,call=(rev,command,input)=>`select public.mutate_performance_review(gen_random_uuid(),${q(id)},${q(rev)},${q(command)},${q(JSON.stringify(input))}::jsonb);`;
  c.sql(db,actor(1,call('self:0','submit_self',{answers:Array(12).fill('Evidence')})));
  c.sql(db,actor(2,call('manager:1:0','complete_manager',{answers:Array(12).fill('Evidence'),ratings:Array(12).fill('2 Meets expectations'),summary:'Summary',overallRating:'2 Meets expectations',managerNote:'PRIVATE-SYNTHETIC-NOTE'})));
  c.sql(db,actor(2,call('manager:1:1','submit_review',{date:'2026-01-02',time:'10:00',duration:30,mode:'in_person',location:'Synthetic room',notes:'Synthetic notes',held:true})));
  const claimed=rows(c.sql(db,`begin;set local role service_role;select to_jsonb(c) from public.claim_performance_review_mail(${q(id)},1)c;commit;`))[0];assert.ok(claimed.claim_token);
  assert.match(c.sql(db,`begin;set local role service_role;select public.finish_performance_review_mail(${q(claimed.delivery_id)},${q(claimed.claim_token)},'unknown',repeat('a',64));commit;`),/^t$/m);
 }
 const before=observe(db),file=path.join(out,ordinal+'.before.json');writeFileSync(file,JSON.stringify(before));
 const sql=bridge('build',file);writeFileSync(path.join(out,ordinal+'.generated.sql'),sql);
 return {db,before,file,sql};
}
function unchanged(s) {assert.deepEqual(observe(s.db),s.before);assert.equal(c.sql(s.db,"select to_regprocedure('private.performance_review_docx_bytes(jsonb)') is null;").trim(),'t');}
function inject(s,fault) {
 const marker='\ninsert into supabase_migrations.schema_migrations(version,name,statements) values(';assert.equal(s.sql.split(marker).length,2);
 return s.sql.replace(marker,()=>`\n${fault}${marker}`);
}
before(()=>{c=ownedCluster(17);expression=bridge('expression');});
after(()=>c?.stop());
test('exact new helper transaction commits only its source and independently reads complete native preservation',()=>{
 const s=prepare(),r=c.run(s.db,s.sql);assert.equal(r.status,0,r.stderr);
 const hashes=[...r.stdout.matchAll(/^([0-9a-f]{64})$/gm)];assert.equal(hashes.length,1);const attested={resultingCatalogSha256:hashes[0][1]};
 const after=observe(s.db),file=path.join(out,'positive.after.json');writeFileSync(file,JSON.stringify(after));
 assert.equal(after.targetExact,true);assert.equal(after.ledger.length,s.before.ledger.length+1);assert.deepEqual(after.ledger.slice(0,-1),s.before.ledger);assert.equal(after.securityHash,s.before.securityHash);assert.equal(after.dataHash,s.before.dataHash);
 assert.equal(JSON.parse(bridge('validate',s.file,file,attested.resultingCatalogSha256)).readbackVerified,true);
});
test('forward helper preserves existing sticky unknown history without a global empty-state veto',()=>{
 const s=prepare('',true),before=c.sql(s.db,'select to_jsonb(o) from private.performance_review_mail_outbox o;');assert.match(before,/needs_review/);
 const r=c.run(s.db,s.sql);assert.equal(r.status,0,r.stderr);const hashes=[...r.stdout.matchAll(/^([0-9a-f]{64})$/gm)];assert.equal(hashes.length,1);
 const after=observe(s.db),file=path.join(out,'held.after.json');writeFileSync(file,JSON.stringify(after));assert.equal(after.dataHash,s.before.dataHash);assert.equal(c.sql(s.db,'select to_jsonb(o) from private.performance_review_mail_outbox o;'),before);
 assert.equal(JSON.parse(bridge('validate',s.file,file,hashes[0][1])).readbackVerified,true);
 assert.equal(c.sql(s.db,"begin;set local role service_role;select count(*) from public.claim_performance_review_mail(null,10);commit;").split('\n').includes('0'),true);
});

for(const [label,fault]of [
 ['external-policy',"alter policy blocked on synthetic_external.protected using(true);"],
 ['external-schema-acl','grant create on schema synthetic_external to anon;'],
 ['role-attribute','alter role anon createdb;'],
 ['column-acl','grant select(manager_note) on private.performance_reviews to authenticated;'],
 ['feature-rls','alter table private.performance_reviews no force row level security;'],
 ['new-helper-acl','grant execute on function private.performance_review_docx_bytes(jsonb) to authenticated;'],
 ['old-mail-acl','grant execute on function public.claim_performance_review_mail(uuid,integer) to authenticated;'],
 ['existing-performance-data',"update private.performance_reviews set summary='Unexpected';"],
 ['existing-auth-data',"update auth.users set updated_at='2000-01-01';"],
 ['raw-ledger-bounds',"update supabase_migrations.schema_migrations set statements='[1:3]={\"synthetic-a\",NULL,\"synthetic-b\"}' where version='20260101000002';"],
]) test('new helper atomically rejects late '+label,()=>{
 const s=prepare(),r=c.run(s.db,inject(s,fault));assert.equal(r.status,3,r.stderr);assert.match(r.stderr,/55000/);unchanged(s);
});
test('new helper drains a genuinely deferred final-ledger policy effect before final assertions',()=>{
 const s=prepare("create function synthetic_external.late_policy() returns trigger language plpgsql as $$ begin alter policy blocked on synthetic_external.protected using(true);return new;end $$;create constraint trigger completion_late after insert on supabase_migrations.schema_migrations deferrable initially deferred for each row execute function synthetic_external.late_policy();");
 const r=c.run(s.db,inject(s,'set constraints supabase_migrations.completion_late deferred;'));assert.equal(r.status,3,r.stderr);assert.match(r.stderr,/55000/);unchanged(s);
});
