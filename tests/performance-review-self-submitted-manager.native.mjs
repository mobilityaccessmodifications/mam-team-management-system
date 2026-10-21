import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {ownedCluster,definition,rows,q,user,person,env} from './performance-review-production-harness.mjs';
const migration='supabase/migrations/20261021010742_performance_review_self_submitted_manager.sql';
const source=readFileSync(migration,'utf8'),db='mam_test_pr_self_manager',sig='public.reserve_performance_review_notification_mail(text,text,text,uuid,text)',major=Number(process.env.MAM_PERFORMANCE_SELF_MANAGER_TEST_PG_MAJOR??'17');
const id='c5000000-0000-4000-8000-000000000001';
const insert=(employee=1,reviewer='manager',manager=2)=>`insert into private.performance_reviews(id,employee_person_id,assigned_manager_person_id,assigned_admin_user_id,cycle,due_date,employee_identity,manager_identity,self_submitted_at,self_version) values(${q(id)},${q(person(employee))},${reviewer==='manager'?q(person(manager)):'null'},${reviewer==='manager'?'null':q(user(reviewer==='p0'?5:4))},'2039','2039-12-31',private.performance_review_identity(${q(person(employee))}),${reviewer==='manager'?'private.performance_review_identity('+q(person(manager))+')':`jsonb_build_object('id',${q(user(reviewer==='p0'?5:4))},'name','Synthetic reviewer')`},clock_timestamp(),1);`;
let c;
function predecessor(database){
 c.setup(database);c.sql(database,readFileSync('supabase/migrations/20261017103000_performance_review_completion_guards.sql','utf8'));
 c.sql(database,definition('20261006104000_unified_portal_roles.sql','create or replace function private.is_system_portal_account_admin()'));
 c.sql(database,'revoke all on function private.is_system_portal_account_admin() from public,anon,authenticated,service_role;');
 c.sql(database,"alter table private.employee_directory_details add column work_email text;insert into private.employee_directory_details(person_id,work_email) select id,'person'||right(id::text,1)||'@mobilityaccess.com.au' from public.internal_org_people;");
 c.sql(database,readFileSync('supabase/migrations/20260923010000_durable_notification_delivery_receipts.sql','utf8'));
 c.sql(database,definition('20261014110000_subscription_review_managers_mail.sql','create or replace function private.notification_event_key_valid('));
 for(const f of ['20261019105639_performance_review_readonly_preview.sql','20261019110000_performance_review_notifications.sql','20261019211233_performance_review_p0_manager_delegation.sql','20261019225516_performance_review_admin_reviewer.sql','20261020003343_performance_review_careers_cc.sql','20261020212355_performance_review_meeting_invitation.sql','20261020232835_performance_review_meeting_invitation_status.sql','20261020235553_performance_review_invitation_manager_routing.sql'])c.sql(database,readFileSync('supabase/migrations/'+f,'utf8'));
 c.sql(database,"update private.notification_delivery_control set legacy_import_sha256=repeat('a',64),legacy_import_count=0,legacy_imported_at=clock_timestamp();select private.set_notification_delivery_ready(true);");
}
const rowsHash=()=>`select md5(jsonb_build_object('reviews',(select jsonb_agg(to_jsonb(r) order by id) from private.performance_reviews r),'events',(select jsonb_agg(to_jsonb(r) order by id) from private.performance_review_events r),'operations',(select jsonb_agg(to_jsonb(r) order by operation_id) from private.performance_review_operations r),'notifications',(select jsonb_agg(to_jsonb(r) order by delivery_id) from private.performance_review_notifications r),'requests',(select jsonb_agg(to_jsonb(r) order by review_id) from private.performance_review_meeting_requests r),'receipts',(select jsonb_agg(to_jsonb(r) order by event_key) from private.notification_delivery_receipts r),'outbox',(select jsonb_agg(to_jsonb(r) order by delivery_id) from private.performance_review_mail_outbox r))::text);`;

const json=s=>rows(c.sql(db,`begin;${s}rollback;`));
const payload=(event='self-submitted')=>`select private.performance_review_notification_payload(r,${q(event)}) from private.performance_reviews r where id=${q(id)};`;
const enqueue=(event='self-submitted')=>`insert into private.performance_review_notifications(review_id,event) values(${q(id)},${q(event)}) on conflict(review_id,event) do nothing;`;
const claim=()=>`select payload from public.claim_performance_review_notifications(${q(id)},10,2);`;
const claimTable=()=>`create temporary table self_claim as select * from public.claim_performance_review_notifications(${q(id)},10,2);`;
const reserve=()=>`select public.reserve_performance_review_notification_mail(payload->>'eventKey',payload->>'recipient',payload->>'cc',claim_token,null) from self_claim;`;
before(()=>{c=ownedCluster(major);predecessor(db);c.sql(db,source);});
after(()=>c?.stop());
for(const reviewer of ['manager','admin','p0'])test(`${reviewer} self submission targets actual Manager with Careers CC and preserves reviewer ownership`,()=>{
 const out=json(`${insert(1,reviewer)}${enqueue()}${claim()}select jsonb_build_object('manager',assigned_manager_person_id,'admin',assigned_admin_user_id) from private.performance_reviews where id=${q(id)};`);
 assert.equal(out[0].recipient,'person2@mobilityaccess.com.au');assert.equal(out[0].cc,'careers@mobilityaccess.com.au');
 assert.deepEqual(out[1],{manager:reviewer==='manager'?person(2):null,admin:reviewer==='manager'?null:user(reviewer==='p0'?5:4)});
 assert.deepEqual(Object.keys(out[0]).sort(),['event','eventKey','reviewId','reviewCode','cycle','dueDate','recipient','employeeName','managerName','cc'].sort());
});
test('the predecessor reproduces P0 Careers routing and the migration changes only future canonical payload',()=>{
 const database='mam_test_pr_self_predecessor';predecessor(database);c.sql(database,insert(1,'p0'));
 assert.equal(rows(c.sql(database,payload()))[0].recipient,'careers@mobilityaccess.com.au');const before=c.sql(database,rowsHash());c.sql(database,source);assert.equal(c.sql(database,rowsHash()),before);assert.equal(rows(c.sql(database,payload()))[0].recipient,'person2@mobilityaccess.com.au');
});
test('existing assigned Manager stays the reviewer after a reporting line change',()=>{
 const out=json(`${insert()}update public.internal_org_people set parent_id=${q(person(3))} where id=${q(person(1))};${enqueue()}${claim()}`);assert.equal(out[0].recipient,'person2@mobilityaccess.com.au');
});
test('linked Admin fallback only applies without an eligible org Manager; standalone P0 fails closed',()=>{
 const out=json(`update public.internal_org_people set parent_id=null where id=${q(person(1))};${insert(1,'admin')}${enqueue()}${claim()}`);assert.equal(out[0].recipient,'person4@mobilityaccess.com.au');assert.equal(out[0].cc,'careers@mobilityaccess.com.au');
 const closed=json(`update public.internal_org_people set parent_id=null where id=${q(person(1))};${insert(1,'p0')}${enqueue()}${claim()}select jsonb_build_object('state',state) from private.performance_review_notifications where event='self-submitted';`);assert.deepEqual(closed,[{state:'needs_review'}]);
});
test('self submission does not require the employee work email',()=>{
 for(const reviewer of ['manager','admin','p0']){const out=json(`${insert(1,reviewer)}update private.employee_directory_details set work_email=null where person_id=${q(person(1))};${enqueue()}${claim()}`);assert.equal(out[0].recipient,'person2@mobilityaccess.com.au');assert.equal(out[0].cc,'careers@mobilityaccess.com.au');}
});
for(const reviewer of ['manager','admin','p0'])test(`${reviewer} refuses invalid or ambiguous manager email without fallback`,()=>{
 for(const change of [`update private.employee_directory_details set work_email=null where person_id=${q(person(2))};`,`update private.employee_directory_details set work_email='careers@mobilityaccess.com.au' where person_id=${q(person(2))};`,`update private.employee_directory_details set work_email='person2@mobilityaccess.com.au' where person_id=${q(person(3))};`,`update private.employee_directory_details set work_email='manager@example.net' where person_id=${q(person(2))};`]){const out=json(`${insert(1,reviewer)}${change}${enqueue()}${claim()}select jsonb_build_object('state',state,'receipts',(select count(*) from private.notification_delivery_receipts)) from private.performance_review_notifications where event='self-submitted';`);assert.deepEqual(out,[{state:'needs_review',receipts:0}]);}
});
test('invalid subject identity cannot generate self-submitted notification',()=>{
 const out=json(`${insert(1,'p0')}update private.performance_reviews set employee_identity=jsonb_set(employee_identity,'{id}',to_jsonb(${q(person(3))}::text));${enqueue()}${claim()}select jsonb_build_object('state',state) from private.performance_review_notifications where event='self-submitted';`);assert.deepEqual(out,[{state:'needs_review'}]);
});
for(const reviewer of ['manager','admin','p0'])test(`${reviewer} started notice remains employee To and Careers CC`,()=>{
 const out=json(`${insert(1,reviewer)}update private.performance_reviews set self_submitted_at=null;${enqueue('started')}${claim()}`);assert.equal(out[0].recipient,'person1@mobilityaccess.com.au');assert.equal(out[0].cc,'careers@mobilityaccess.com.au');
});
test('meeting invitation remains actual Manager plus employee with empty CC',()=>{
 const out=json(`${insert(1,'p0')}update private.performance_reviews set manager_completed_at=clock_timestamp(),manager_version=1;insert into private.performance_review_meeting_requests(review_id,requested_at,requested_by,initial_manager_version) values(${q(id)},clock_timestamp(),${q(user(5))},1);${enqueue('manager-invited')}${claim()}`);assert.equal(out[0].recipient,'person1@mobilityaccess.com.au,person2@mobilityaccess.com.au');assert.equal(out[0].cc,'');
});
test('new self reservation is sent once and subsequent reservation is processing without a second grant',()=>{
 const out=json(`${insert(1,'p0')}${enqueue()}${claimTable()}${reserve()}${reserve()}select jsonb_build_object('receipts',(select count(*) from private.notification_delivery_receipts));`);assert.equal(out[0].outcome,'send');assert.equal(out[1].outcome,'rejected');assert.equal(out[1].rejectionCode,'delivery-in-flight');assert.deepEqual(out[2],{receipts:1});
});
test('fresh self reservation requires Careers CC even when legacy stored envelope has empty CC',()=>{
 const out=json(`${insert(1,'p0')}${enqueue()}${claimTable()}update private.performance_review_notifications set cc='' where event='self-submitted';update self_claim set payload=jsonb_set(payload,'{cc}','""');${reserve()}select jsonb_build_object('receipts',(select count(*) from private.notification_delivery_receipts));`);assert.equal(out[0].outcome,'rejected');assert.deepEqual(out[1],{receipts:0});
});
for(const legacy of ['queued','claimed','processing','sent'])test(`migration preserves historical ${legacy} self notification and does not resend`,()=>{
 const database='mam_test_pr_self_legacy_'+legacy;predecessor(database);let seed=insert(1,'p0')+enqueue();
 if(legacy!=='queued')seed+=claimTable();
 if(legacy==='processing'||legacy==='sent')seed+=`create temporary table reserved as ${reserve().replace(/^select /,'select ').replace(/;$/,'')};`;
 if(legacy==='sent')seed+=`select public.confirm_notification_delivery((select payload->>'eventKey' from self_claim),(select (reserve_performance_review_notification_mail->>'deliveryToken')::uuid from reserved),(select payload->>'recipient' from self_claim),(select payload->>'cc' from self_claim),'${JSON.stringify({accepted:true,messageId:'synthetic-self',requestId:null,statusCode:202})}'::jsonb);`;
 c.sql(database,seed);const before=c.sql(database,rowsHash());c.sql(database,source);assert.equal(c.sql(database,rowsHash()),before);
 if(legacy==='queued'){const out=rows(c.sql(database,`begin;${claim()}rollback;`));assert.equal(out[0].recipient,'person2@mobilityaccess.com.au');assert.equal(out[0].cc,'careers@mobilityaccess.com.au');}
 else {const out=rows(c.sql(database,`begin;create temporary table self_claim as select n.claim_token,jsonb_build_object('eventKey','performance-review:'||n.review_id::text||':'||n.event,'recipient',n.recipient,'cc',n.cc) payload from private.performance_review_notifications n where n.review_id=${q(id)} and n.event='self-submitted';${reserve()}${claim()}rollback;`));assert.equal(out[0].outcome,legacy==='sent'?'duplicate':'rejected');if(legacy==='processing')assert.equal(out[0].rejectionCode,'delivery-in-flight');assert.equal(out.length,1);assert.equal(c.sql(database,rowsHash()),before);}
});
for(const hold of [false,true])test(`migration preserves ${hold?'existing purge HOLD':'healthy purge baseline'}`,()=>{
 const database='mam_test_pr_self_purge_'+(hold?'hold':'healthy');predecessor(database);c.sql(database,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash();');if(hold)c.sql(database,'grant select on public.profiles to authenticated;');const before=c.sql(database,'select schema_hash from private.confirmed_test_purge_schema;');c.sql(database,source);assert.equal(c.sql(database,'select schema_hash=private.confirmed_test_purge_schema_hash() from private.confirmed_test_purge_schema;').trim(),hold?'f':'t');assert.equal(before===c.sql(database,'select schema_hash from private.confirmed_test_purge_schema;'),hold);
});
test('migration rejects predecessor drift, privilege injection, row edits and semantic default changes atomically',()=>{
 for(const [name,setup,changed] of [['body',"create or replace function private.performance_review_notification_payload(p_review private.performance_reviews,p_event text) returns jsonb language sql stable security definer set search_path='' as $$select null::jsonb$$;",source],['grant','',source.replace('do $self_submitted_manager_catalog_after$','grant select on public.profiles to authenticated;\ndo $self_submitted_manager_catalog_after$')],['data','',source.replace('do $self_submitted_manager_catalog_after$','update private.performance_reviews set due_date=due_date+1;\ndo $self_submitted_manager_catalog_after$')],['default','',source.replace('p_legacy_event_key text default null',"p_legacy_event_key text default 'unapproved'")]]){const database='mam_test_pr_self_reject_'+name;predecessor(database);c.sql(database,insert());if(setup)c.sql(database,setup);const before=c.sql(database,rowsHash()),result=c.run(database,changed);assert.notEqual(result.status,0);assert.match(result.stderr,/55000.*Performance self-submitted manager (predecessor differs|unrelated catalog delta)/s);assert.equal(c.sql(database,rowsHash()),before);}
});
test('default source location differences preserve exact semantic default and other metadata',()=>{
 const database='mam_test_pr_self_default_location';predecessor(database);const query=`select jsonb_build_object('tree',proargdefaults::text,'expression',pg_get_expr(proargdefaults,0)) from pg_proc where oid=${q(sig)}::regprocedure;`,before=rows(c.sql(database,query))[0];c.sql(database,source.replace('p_legacy_event_key text default null','p_legacy_event_key text default    null'));const after=rows(c.sql(database,query))[0];assert.equal(after.expression,before.expression);assert.equal(after.tree.replaceAll(/ :location -?[0-9]+/g,' :location -1'),before.tree.replaceAll(/ :location -?[0-9]+/g,' :location -1'));if(major===16)assert.notEqual(after.tree,before.tree);
});
function releasePython(code,value){const r=spawnSync('python3',['-B','-c',"import runpy,json,sys;m=runpy.run_path('scripts/deploy-performance-review-self-submitted-manager.py');v=json.load(sys.stdin);"+code],{env,encoding:'utf8',input:JSON.stringify(value)});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
function ledger(database){const prev=readFileSync('supabase/migrations/20261020235553_performance_review_invitation_manager_routing.sql','utf8');c.sql(database,`create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);insert into supabase_migrations.schema_migrations values('20261020235553','performance_review_invitation_manager_routing',ARRAY[${q(prev)}]::text[]);`);return prev;}
function state(database,prev){const expression=releasePython("print(json.dumps(m['state_expression'](v['source'],v['predecessor'])))",{source,predecessor:prev});return rows(c.sql(database,`begin read only;set local search_path='';select ${expression};rollback;`))[0];}
for(const hold of [false,true])test(`release transaction preserves exact ledger and ${hold?'HOLD':'healthy catalog'}`,()=>{
 const database='mam_test_pr_self_release_'+(hold?'hold':'healthy');predecessor(database);const prev=ledger(database);c.sql(database,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash();');if(hold)c.sql(database,'grant select on public.profiles to authenticated;');const before=state(database,prev),sql=releasePython("print(json.dumps(m['transaction'](v['source'],v['before'],v['predecessor'])))",{source,predecessor:prev,before});c.sql(database,sql);const after=state(database,prev);assert.equal(after.targetExact,true);assert.equal(after.ready,true);assert.deepEqual(after.ledger.slice(0,-1),before.ledger);assert.equal(releasePython("m['validate_preserved'](v['after'],v['before'],v['source'],v['after']['catalogHash']);print('true')",{after,before,source}),true);
});
test('release transaction rejects changed ledger before schema mutation',()=>{
 const database='mam_test_pr_self_release_stale';predecessor(database);const prev=ledger(database),before=state(database,prev),sql=releasePython("print(json.dumps(m['transaction'](v['source'],v['before'],v['predecessor'])))",{source,predecessor:prev,before});c.sql(database,"update supabase_migrations.schema_migrations set name='changed';");const result=c.run(database,sql);assert.notEqual(result.status,0);assert.match(result.stderr,/55000.*locked predecessor changed/s);assert.equal(rows(c.sql(database,`select jsonb_build_object('body',encode(extensions.digest(prosrc,'sha256'),'hex')) from pg_proc where oid=${q(sig)}::regprocedure;`))[0].body,before.bodies[sig]);
});
test('release readback rejects changed function metadata',()=>{
 const database='mam_test_pr_self_readback';predecessor(database);const prev=ledger(database),before=state(database,prev),sql=releasePython("print(json.dumps(m['transaction'](v['source'],v['before'],v['predecessor'])))",{source,predecessor:prev,before});c.sql(database,sql);c.sql(database,`alter function ${sig} security invoker;`);const result=spawnSync('python3',['-B','-c',"import runpy,json,sys;m=runpy.run_path('scripts/deploy-performance-review-self-submitted-manager.py');v=json.load(sys.stdin);m['validate_preserved'](v['after'],v['before'],v['source'])"],{env,encoding:'utf8',input:JSON.stringify({after:state(database,prev),before,source})});assert.notEqual(result.status,0);assert.match(result.stderr,/Exact self-submitted manager catalog definitions differ/);
});
