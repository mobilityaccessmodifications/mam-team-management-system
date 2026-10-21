import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {readFileSync} from 'node:fs';
import {ownedCluster,definition,rows,q,user,person} from './performance-review-production-harness.mjs';
const migration='supabase/migrations/20261021024049_performance_review_manager_mail_manual_meeting.sql';
const db='mam_test_pr_manager_mail',id='c6000000-0000-4000-8000-000000000001';
let c;
function predecessor(database){
 c.setup(database);c.sql(database,readFileSync('supabase/migrations/20261017103000_performance_review_completion_guards.sql','utf8'));
 c.sql(database,definition('20261006104000_unified_portal_roles.sql','create or replace function private.is_system_portal_account_admin()'));
 c.sql(database,'revoke all on function private.is_system_portal_account_admin() from public,anon,authenticated,service_role;');
 c.sql(database,"alter table private.employee_directory_details add column work_email text;insert into private.employee_directory_details(person_id,work_email) select id,'person'||right(id::text,1)||'@mobilityaccess.com.au' from public.internal_org_people;");
 c.sql(database,readFileSync('supabase/migrations/20260923010000_durable_notification_delivery_receipts.sql','utf8'));
 c.sql(database,definition('20261014110000_subscription_review_managers_mail.sql','create or replace function private.notification_event_key_valid('));
 for(const f of ['20261019105639_performance_review_readonly_preview.sql','20261019110000_performance_review_notifications.sql','20261019211233_performance_review_p0_manager_delegation.sql','20261019225516_performance_review_admin_reviewer.sql','20261020003343_performance_review_careers_cc.sql','20261020212355_performance_review_meeting_invitation.sql','20261020232835_performance_review_meeting_invitation_status.sql','20261020235553_performance_review_invitation_manager_routing.sql','20261021010742_performance_review_self_submitted_manager.sql'])c.sql(database,readFileSync('supabase/migrations/'+f,'utf8'));
 c.sql(database,"update private.notification_delivery_control set legacy_import_sha256=repeat('a',64),legacy_import_count=0,legacy_imported_at=clock_timestamp();select private.set_notification_delivery_ready(true);");
}

before(()=>{c=ownedCluster(17);predecessor(db);c.sql(db,readFileSync(migration,'utf8'));});
after(()=>c?.stop());
const seed=(reviewer='manager')=>`insert into private.performance_reviews(id,employee_person_id,assigned_manager_person_id,assigned_admin_user_id,cycle,due_date,employee_identity,manager_identity,self_submitted_at,finalised_at,final_document,manager_note) values(${q(id)},${q(person(1))},${reviewer==='manager'?q(person(2)):'null'},${reviewer==='manager'?'null':q(user(reviewer==='p0'?5:4))},'2039','2039-12-31',private.performance_review_identity(${q(person(1))}),${reviewer==='manager'?'private.performance_review_identity('+q(person(2))+')':`jsonb_build_object('id',${q(user(reviewer==='p0'?5:4))},'name','Synthetic reviewer')`},clock_timestamp(),clock_timestamp(),'{"code":"PR-2039-1"}','Synthetic private note');insert into private.performance_review_mail_outbox(review_id) values(${q(id)});`;
const probe=sql=>rows(c.sql(db,`begin;${sql}rollback;`));
const claim=`set local role service_role;select payload from public.claim_performance_review_mail(${q(id)},1);reset role;`;
for(const reviewer of ['manager','admin','p0'])test(`${reviewer} final attachment resolves the current authorized manager`,()=>{
 const out=probe(seed(reviewer)+claim+claim);
 assert.equal(out.length,1);assert.equal(out[0].recipient,'person2@mobilityaccess.com.au');
 assert.deepEqual(Object.keys(out[0]).sort(),['reviewId','reviewCode','finalisedAt','managerNote','document','recipient'].sort());
 assert.equal(out[0].managerNote,'Synthetic private note');
});
test('invalid, shared and external manager addresses never fall back to Careers or employee',()=>{
 for(const address of [null,'careers@mobilityaccess.com.au','manager@example.net','person3@mobilityaccess.com.au']){
  const out=probe(seed()+`update private.employee_directory_details set work_email=${q(address)} where person_id=${q(person(2))};`+claim);
  assert.equal(out.length,1);assert.equal(out[0].recipient,null);
 }
});
test('assigned manager stays authoritative after reporting-line changes; admin uses reporting manager',()=>{
 for(const reviewer of ['manager','admin']){
  const out=probe(seed(reviewer)+`update public.internal_org_people set parent_id=${q(person(3))} where id=${q(person(1))};`+claim);
  assert.equal(out[0].recipient,reviewer==='manager'?'person2@mobilityaccess.com.au':'person3@mobilityaccess.com.au');
 }
});
test('unknown final sends stay claimed and historical deliveries are never replayed',()=>{
 const out=probe(seed()+claim+`update private.performance_review_mail_outbox set claimed_at=clock_timestamp()-interval '100 years';`+claim+`select jsonb_build_object('state',state) from private.performance_review_mail_outbox;`);
 assert.equal(out.length,2);assert.equal(out[1].state,'claimed');
});
test('service retains mail claims but all API roles lose automatic meeting imports',()=>{
 for(const role of ['anon','authenticated','service_role']){
  const out=rows(c.sql(db,`select jsonb_build_object('claim',has_function_privilege(${q(role)},'public.claim_performance_review_mail(uuid,integer)','execute'),'list',has_function_privilege(${q(role)},'public.list_performance_review_meeting_imports(integer)','execute'),'import',has_function_privilege(${q(role)},'public.import_performance_review_meeting(uuid,text,jsonb)','execute'));`))[0];
  assert.deepEqual(out,{claim:role==='service_role',list:false,import:false});
 }
});

test('provider begin rechecks the bound recipient and only grants one send',()=>{
 const out=probe(seed()+`create temporary table claim as select * from public.claim_performance_review_mail(${q(id)},1);grant select on claim to service_role;set local role service_role;
 select jsonb_build_object('allowed',public.begin_performance_review_manager_mail(delivery_id,claim_token,repeat('a',64),'person3@mobilityaccess.com.au')) from claim;
 select jsonb_build_object('allowed',public.begin_performance_review_manager_mail(delivery_id,claim_token,repeat('a',64),'person2@mobilityaccess.com.au')) from claim;
 select jsonb_build_object('allowed',public.begin_performance_review_manager_mail(delivery_id,claim_token,repeat('a',64),'person2@mobilityaccess.com.au')) from claim;reset role;`);
 assert.deepEqual(out,[{allowed:false},{allowed:true},{allowed:false}]);
});
test('manager address changes or revocations after claim block provider begin',()=>{
 for(const change of [`update private.employee_directory_details set work_email='updated@mobilityaccess.com.au' where person_id=${q(person(2))};`,`update public.internal_org_people set is_active=false where id=${q(person(2))};`]){
  const out=probe(seed()+`create temporary table claim as select * from public.claim_performance_review_mail(${q(id)},1);${change}select jsonb_build_object('allowed',public.begin_performance_review_manager_mail(delivery_id,claim_token,repeat('a',64),'person2@mobilityaccess.com.au')) from claim;`);
  assert.deepEqual(out,[{allowed:false}]);
 }
});
test('final manager delivery is independent of employee mailbox availability',()=>{
 const out=probe(seed()+`update private.employee_directory_details set work_email=null where person_id=${q(person(1))};`+claim);
 assert.equal(out[0].recipient,'person2@mobilityaccess.com.au');
});

for(const hold of [false,true])test(`migration preserves ${hold?'existing purge HOLD':'healthy purge baseline'} and existing records`,()=>{
 const database='mam_test_pr_final_purge_'+(hold?'hold':'healthy');predecessor(database);c.sql(database,seed());
 c.sql(database,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash();');
 if(hold)c.sql(database,'grant select on public.profiles to authenticated;');
 const stored=c.sql(database,'select schema_hash from private.confirmed_test_purge_schema;');
 const before=c.sql(database,'select to_jsonb(r) from private.performance_reviews r;select to_jsonb(o) from private.performance_review_mail_outbox o;');
 c.sql(database,readFileSync(migration,'utf8'));
 assert.equal(c.sql(database,'select schema_hash=private.confirmed_test_purge_schema_hash() from private.confirmed_test_purge_schema;').trim(),hold?'f':'t');
 assert.equal(stored===c.sql(database,'select schema_hash from private.confirmed_test_purge_schema;'),hold);
 assert.equal(c.sql(database,'select to_jsonb(r) from private.performance_reviews r;select to_jsonb(o) from private.performance_review_mail_outbox o;'),before);
});
for(const [label,mutation] of [['catalog','grant select on public.profiles to authenticated;'],['row',"update private.performance_review_mail_outbox set queued_at=queued_at+interval '1 second';"]])test(`migration rolls back an unrelated ${label} delta`,()=>{
 const database='mam_test_pr_final_delta_'+label;predecessor(database);c.sql(database,seed());
 const before=c.sql(database,'select to_jsonb(r) from private.performance_reviews r;select to_jsonb(o) from private.performance_review_mail_outbox o;');
 const source=readFileSync(migration,'utf8').replace('do $manager_mail_catalog_after$',mutation+'\ndo $manager_mail_catalog_after$');
 const result=c.run(database,source);assert.notEqual(result.status,0);assert.match(result.stderr,/unrelated catalog delta/);
 assert.equal(c.sql(database,'select to_jsonb(r) from private.performance_reviews r;select to_jsonb(o) from private.performance_review_mail_outbox o;'),before);
 assert.equal(c.sql(database,"select to_regprocedure('public.begin_performance_review_manager_mail(uuid,uuid,text,text)') is null;").trim(),'t');
});
