import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {ownedCluster,definition,rows,q,user,person,env} from './performance-review-production-harness.mjs';
const migration='supabase/migrations/20261020235553_performance_review_invitation_manager_routing.sql';
const source=readFileSync(migration,'utf8'),db='mam_test_pr_invite_routing',sig='public.claim_performance_review_notifications(uuid,integer,integer)';
const id='c4000000-0000-4000-8000-000000000001';
const draft={answers:Array(12).fill(''),ratings:Array(12).fill(''),summary:'',overallRating:'',managerNote:''};
const signed=(i,s,extra={})=>`set local role authenticated;select set_config('request.jwt.claims',${q(JSON.stringify({sub:user(i),iat:1900000000,...extra}))},true);${s}reset role;`;
const status=(delegate=null,reviewId=id)=>`public.performance_review_meeting_invitation_status(${q(reviewId)}${delegate===null?'':','+q(person(delegate))})`;
const insert=(employee=1,reviewer='manager',manager=2)=>`insert into private.performance_reviews(id,employee_person_id,assigned_manager_person_id,assigned_admin_user_id,cycle,due_date,employee_identity,manager_identity,self_submitted_at,self_version) values(${q(id)},${q(person(employee))},${reviewer==='manager'?q(person(manager)):'null'},${reviewer==='manager'?'null':q(user(reviewer==='p0'?5:4))},'2039','2039-12-31',private.performance_review_identity(${q(person(employee))}),${reviewer==='manager'?'private.performance_review_identity('+q(person(manager))+')':`jsonb_build_object('id',${q(user(reviewer==='p0'?5:4))},'name','Synthetic reviewer')`},clock_timestamp(),1);`;
const invite=(who=2,delegate=false)=>signed(who,`select ${delegate?'public.mutate_performance_review_for_delegate('+q(person(2))+',':'public.mutate_performance_review('}${q(randomUUID())},${q(id)},'${who===4||who===5&&!delegate?'read':'manager'}:1:0','complete_manager',${q(JSON.stringify(draft))}::jsonb);`);
const accepted=(finish=true)=>`create temporary table invite_claim as select * from public.claim_performance_review_notifications(${q(id)},10,2);create temporary table invite_reserve as select public.reserve_performance_review_notification_mail(payload->>'eventKey',payload->>'recipient',payload->>'cc',claim_token,null) value from invite_claim where payload->>'event'='manager-invited';select public.confirm_notification_delivery((select payload->>'eventKey' from invite_claim where payload->>'event'='manager-invited'),(select (value->>'deliveryToken')::uuid from invite_reserve),(select payload->>'recipient' from invite_claim where payload->>'event'='manager-invited'),(select payload->>'cc' from invite_claim where payload->>'event'='manager-invited'),'${JSON.stringify({accepted:true,messageId:'synthetic',requestId:null,statusCode:202})}'::jsonb);${finish?"select public.finish_performance_review_notification(delivery_id,claim_token,true) from invite_claim where payload->>'event'='manager-invited';":''}`;
let c;
function predecessor(database){
 c.setup(database);c.sql(database,readFileSync('supabase/migrations/20261017103000_performance_review_completion_guards.sql','utf8'));
 c.sql(database,definition('20261006104000_unified_portal_roles.sql','create or replace function private.is_system_portal_account_admin()'));
 c.sql(database,'revoke all on function private.is_system_portal_account_admin() from public,anon,authenticated,service_role;');
 c.sql(database,"alter table private.employee_directory_details add column work_email text;insert into private.employee_directory_details(person_id,work_email) select id,'person'||right(id::text,1)||'@mobilityaccess.com.au' from public.internal_org_people;");
 c.sql(database,readFileSync('supabase/migrations/20260923010000_durable_notification_delivery_receipts.sql','utf8'));
 c.sql(database,definition('20261014110000_subscription_review_managers_mail.sql','create or replace function private.notification_event_key_valid('));
 for(const f of ['20261019105639_performance_review_readonly_preview.sql','20261019110000_performance_review_notifications.sql','20261019211233_performance_review_p0_manager_delegation.sql','20261019225516_performance_review_admin_reviewer.sql','20261020003343_performance_review_careers_cc.sql','20261020212355_performance_review_meeting_invitation.sql','20261020232835_performance_review_meeting_invitation_status.sql'])c.sql(database,readFileSync('supabase/migrations/'+f,'utf8'));
 c.sql(database,"update private.notification_delivery_control set legacy_import_sha256=repeat('a',64),legacy_import_count=0,legacy_imported_at=clock_timestamp();select private.set_notification_delivery_ready(true);");
}
const json=s=>rows(c.sql(db,`begin;${s}rollback;`)).filter(x=>!Object.hasOwn(x,'sub'));
const denied=s=>{const r=c.run(db,`begin;${s}rollback;`);assert.notEqual(r.status,0);assert.match(r.stderr,/42501/);};
const addresses=()=>`select private.performance_review_meeting_addresses(r) from private.performance_reviews r where id=${q(id)};`;
const claim=()=>`select payload from public.claim_performance_review_notifications(${q(id)},10,2);`;
const event=(patch={})=>({id:'synthetic-graph-event',uid:'synthetic-ical-uid',subject:'RE: Arrange performance review PR-2039-1',organizer:'person2@mobilityaccess.com.au',attendees:['person1@mobilityaccess.com.au','ai@mobilityaccess.com.au'],start:'2039-10-21T01:00:00Z',end:'2039-10-21T01:30:00Z',createdAt:'2039-10-20T01:00:00Z',modifiedAt:'2039-10-20T01:00:00Z',mode:'in_person',location:'Synthetic room',isCancelled:false,isAllDay:false,type:'singleInstance',...patch});
const importEvent=(patch={})=>`select public.import_performance_review_meeting((select request_token from private.performance_review_meeting_requests where review_id=${q(id)}),'manager:1:1',${q(JSON.stringify(event(patch)))}::jsonb||jsonb_build_object('subject',(select 'RE: Arrange performance review PR-'||cycle||'-'||review_no from private.performance_reviews where id=${q(id)})));`;
const reserve=()=>`select public.reserve_performance_review_notification_mail(payload->>'eventKey',payload->>'recipient',payload->>'cc',claim_token,null) from invite_claim where payload->>'event'='manager-invited';`;
const rowsHash=()=>`select md5(jsonb_build_object('reviews',(select jsonb_agg(to_jsonb(r) order by id) from private.performance_reviews r),'events',(select jsonb_agg(to_jsonb(r) order by id) from private.performance_review_events r),'operations',(select jsonb_agg(to_jsonb(r) order by operation_id) from private.performance_review_operations r),'notifications',(select jsonb_agg(to_jsonb(r) order by delivery_id) from private.performance_review_notifications r),'requests',(select jsonb_agg(to_jsonb(r) order by review_id) from private.performance_review_meeting_requests r),'receipts',(select jsonb_agg(to_jsonb(r) order by event_key) from private.notification_delivery_receipts r),'outbox',(select jsonb_agg(to_jsonb(r) order by delivery_id) from private.performance_review_mail_outbox r))::text);`;
before(()=>{c=ownedCluster(17);predecessor(db);c.sql(db,source);});
after(()=>c?.stop());
for(const reviewer of ['manager','admin','p0'])test(`${reviewer} invitation targets canonical employee manager with empty CC without changing reviewer ownership`,()=>{
 const who=reviewer==='manager'?2:reviewer==='admin'?4:5;
 const out=json(`${insert(1,reviewer)}${invite(who)}${addresses()}${claim()}select jsonb_build_object('manager',assigned_manager_person_id,'admin',assigned_admin_user_id,'actor',(select requested_by from private.performance_review_meeting_requests where review_id=${q(id)})) from private.performance_reviews where id=${q(id)};`);
 assert.deepEqual(out.at(-3),{employeeEmail:'person1@mobilityaccess.com.au',managerEmail:'person2@mobilityaccess.com.au'});
 assert.equal(out.at(-2).recipient,'person1@mobilityaccess.com.au,person2@mobilityaccess.com.au');assert.equal(out.at(-2).cc,'');
 assert.deepEqual(out.at(-1),{manager:reviewer==='manager'?person(2):null,admin:reviewer==='manager'?null:user(who),actor:user(who)});
});
test('P0 delegation retains selected Manager and actual signed-in actor',()=>{
 const out=json(`${insert()}${invite(5,true)}${claim()}select jsonb_build_object('actor',requested_by) from private.performance_review_meeting_requests;`);
 assert.equal(out.at(-2).recipient,'person1@mobilityaccess.com.au,person2@mobilityaccess.com.au');assert.equal(out.at(-2).cc,'');assert.deepEqual(out.at(-1),{actor:user(5)});
});
test('existing assigned Manager remains the invitation and meeting owner after reporting-line change',()=>{
 const out=json(`${insert()}update public.internal_org_people set parent_id=${q(person(3))} where id=${q(person(1))};${invite()}${accepted()}${importEvent()}`);
 assert.equal(out.at(-1).status,'imported');
});
test('linked Admin reviewer without eligible organisation Manager remains a legitimate organizer',()=>{
 const out=json(`update public.internal_org_people set parent_id=null where id=${q(person(1))};${insert(1,'admin')}${invite(4)}${accepted()}select payload from invite_claim;select public.list_performance_review_meeting_imports(1001);${importEvent({organizer:'person4@mobilityaccess.com.au'})}`);
 assert.equal(out.at(-3).recipient,'person1@mobilityaccess.com.au,person4@mobilityaccess.com.au');assert.equal(out.at(-3).cc,'');assert.equal(out.at(-2)[0].managerEmail,'person4@mobilityaccess.com.au');assert.equal(out.at(-1).status,'imported');
});
test('standalone P0 with no eligible manager fails closed without Careers fallback or receipt',()=>{
 const out=json(`update public.internal_org_people set parent_id=null where id=${q(person(1))};${insert(1,'p0')}${invite(5)}${claim()}select jsonb_build_object('state',state,'recipient',recipient,'cc',cc,'receipts',(select count(*) from private.notification_delivery_receipts)) from private.performance_review_notifications;`);
 assert.deepEqual(out.at(-1),{state:'needs_review',recipient:null,cc:null,receipts:0});
});
for(const [name,change] of [['missing manager email',"update private.employee_directory_details set work_email=null where person_id='"+person(2)+"';"],['duplicate email',"update private.employee_directory_details set work_email='person2@mobilityaccess.com.au' where person_id='"+person(3)+"';"],['Careers manager address',"update private.employee_directory_details set work_email='careers@mobilityaccess.com.au' where person_id='"+person(2)+"';"],['Careers employee address',"update private.employee_directory_details set work_email='careers@mobilityaccess.com.au' where person_id='"+person(1)+"';"]])test(`${name} never falls back to Admin or Careers`,()=>{
 const out=json(`${insert(1,'admin')}${change}${invite(4)}${claim()}select jsonb_build_object('state',state,'recipient',recipient) from private.performance_review_notifications;`);assert.deepEqual(out.at(-1),{state:'needs_review',recipient:null});
});
for(const reviewer of ['admin','p0'])test(`${reviewer}-owned review imports Luke-like manager's meeting once but rejects Careers organizer`,()=>{
 const who=reviewer==='admin'?4:5;
 const rejected=c.run(db,`begin;${insert(1,reviewer)}${invite(who)}${accepted()}${importEvent({organizer:'careers@mobilityaccess.com.au'})}rollback;`);assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/22023.*Invalid review meeting authority/s);
 const out=json(`${insert(1,reviewer)}${invite(who)}${accepted()}select public.list_performance_review_meeting_imports(1001);${importEvent()}${importEvent()}`);assert.equal(out.at(-3)[0].managerEmail,'person2@mobilityaccess.com.au');assert.equal(out.at(-2).status,'imported');assert.equal(out.at(-1).status,'already_imported');
});
test('a new manager after invitation acceptance cannot import a meeting they never received',()=>{
 const out=json(`${insert(1,'p0')}${invite(5)}${accepted()}update public.internal_org_people set parent_id=${q(person(3))} where id=${q(person(1))};select public.list_performance_review_meeting_imports(1001);${importEvent({organizer:'person3@mobilityaccess.com.au'})}`);assert.deepEqual(out.at(-2),[]);assert.equal(out.at(-1).status,'skipped');
});
test('receipt To or CC mismatch cannot enable calendar import',()=>{
 for(const changed of ["recipient='person1@mobilityaccess.com.au,person3@mobilityaccess.com.au'","cc='careers@mobilityaccess.com.au'"]){const out=json(`${insert(1,'p0')}${invite(5)}${accepted()}update private.performance_review_notifications set ${changed} where event='manager-invited';select public.list_performance_review_meeting_imports(1001);${importEvent()}`);assert.deepEqual(out.at(-2),[]);assert.equal(out.at(-1).status,'skipped');}
});
test('fresh reservation rejects changed canonical manager instead of sending to stale claim',()=>{
 const out=json(`${insert(1,'p0')}${invite(5)}create temporary table invite_claim as select * from public.claim_performance_review_notifications(${q(id)},10,2);update public.internal_org_people set parent_id=${q(person(3))} where id=${q(person(1))};${reserve()}select jsonb_build_object('state',state,'receipts',(select count(*) from private.notification_delivery_receipts)) from private.performance_review_notifications where event='manager-invited';`);assert.equal(out.at(-2).outcome,'rejected');assert.deepEqual(out.at(-1),{state:'claimed',receipts:0});
});
test('versioned cutover claim is service-only and rejects other versions before mutation',()=>{
 for(const role of ['anon','authenticated'])assert.equal(c.sql(db,`select has_function_privilege(${q(role)},${q(sig)},'EXECUTE');`).trim(),'f');assert.equal(c.sql(db,`select has_function_privilege('service_role',${q(sig)},'EXECUTE');`).trim(),'t');
 for(const version of ['null','0','1','3']){const result=c.run(db,`begin;${insert()}${invite()}set local role service_role;select * from public.claim_performance_review_notifications(${q(id)},10,${version});rollback;`);assert.notEqual(result.status,0);assert.match(result.stderr,/22023.*Unsupported performance notification policy/s);}
 const out=json(`${insert()}${invite()}set local role service_role;${claim()}reset role;`);assert.equal(out.at(-1).cc,'');
});
for(const event of ['started','self-submitted'])test(`${event} sibling notification keeps existing Careers CC policy`,()=>{
 const out=json(`${insert()}${event==='started'?"update private.performance_reviews set self_submitted_at=null;":''}insert into private.performance_review_notifications(review_id,event) values(${q(id)},${q(event)}) on conflict(review_id,event) do nothing;${claim()}`);assert.equal(out.at(-1).cc,'careers@mobilityaccess.com.au');assert.equal(out.at(-1).recipient,event==='started'?'person1@mobilityaccess.com.au':'person2@mobilityaccess.com.au');
});
for(const state of ['claimed','accepted','processing'])test(`migration preserves legacy ${state} invitation and never requeues or re-reserves`,()=>{
 const database='mam_test_pr_routing_legacy_'+state;predecessor(database);
 let seed=insert(1,'p0')+invite(5);
 if(state==='accepted')seed+=accepted().replaceAll(`public.claim_performance_review_notifications(${q(id)},10,2)`,`public.claim_performance_review_notifications(${q(id)},10)`);
 else seed+=`create temporary table invite_claim as select * from public.claim_performance_review_notifications(${q(id)},10);${state==='processing'?reserve():''}`;
 c.sql(database,'begin;'+seed+'commit;');const before=c.sql(database,rowsHash());c.sql(database,source);assert.equal(c.sql(database,rowsHash()),before);
 const out=rows(c.sql(database,`begin;select public.list_performance_review_meeting_imports(1001);create temporary table invite_claim as select n.delivery_id,n.review_id,n.claim_token,jsonb_build_object('event','manager-invited','eventKey','performance-review:'||n.review_id::text||':manager-invited','recipient',n.recipient,'cc',n.cc) payload from private.performance_review_notifications n where n.event='manager-invited';${reserve()}${claim()}rollback;`));assert.deepEqual(out[0],[]);assert.equal(out[1].outcome,'rejected');assert.equal(out.length,2);assert.equal(c.sql(database,rowsHash()),before);
});
for(const hold of [false,true])test(`routing migration preserves ${hold?'existing purge HOLD':'healthy purge baseline'}`,()=>{
 const database='mam_test_pr_routing_purge_'+(hold?'hold':'healthy');predecessor(database);c.sql(database,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash();');if(hold)c.sql(database,'grant select on public.profiles to authenticated;');const before=c.sql(database,'select schema_hash from private.confirmed_test_purge_schema;');c.sql(database,source);assert.equal(c.sql(database,'select schema_hash=private.confirmed_test_purge_schema_hash() from private.confirmed_test_purge_schema;').trim(),hold?'f':'t');assert.equal(before===c.sql(database,'select schema_hash from private.confirmed_test_purge_schema;'),hold);
});
test('routing migration rejects unexpected function drift, unrelated privilege and data writes atomically',()=>{
 for(const [name,setup,injection] of [['body',"create or replace function private.performance_review_meeting_addresses(p_review private.performance_reviews) returns jsonb language sql stable security definer set search_path='' as $$select null::jsonb$$;",''],['grant','','grant select on public.profiles to authenticated;'],['data','','update private.performance_reviews set due_date=due_date+1;']]){const database='mam_test_pr_routing_reject_'+name;predecessor(database);c.sql(database,insert());if(setup)c.sql(database,setup);const result=c.run(database,injection?source.replace('do $invitation_routing_catalog_after$',injection+'\ndo $invitation_routing_catalog_after$'):source);assert.notEqual(result.status,0);assert.match(result.stderr,/55000.*Performance invitation routing (predecessor differs|unrelated catalog delta)/s);assert.equal(c.sql(database,`select to_regprocedure(${q(sig)}) is null;`).trim(),'t');}
});
function releasePython(code,value){const r=spawnSync('python3',['-B','-c',"import runpy,json,sys;m=runpy.run_path('scripts/deploy-performance-review-invitation-routing.py');v=json.load(sys.stdin);"+code],{env,encoding:'utf8',input:JSON.stringify(value)});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
function ledger(database){const prev=readFileSync('supabase/migrations/20261020232835_performance_review_meeting_invitation_status.sql','utf8');c.sql(database,`create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);insert into supabase_migrations.schema_migrations values('20261020232835','performance_review_meeting_invitation_status',ARRAY[${q(prev)}]::text[]);`);return prev;}
function state(database,prev){const expression=releasePython("print(json.dumps(m['state_expression'](v['source'],v['predecessor'])))",{source,predecessor:prev});return rows(c.sql(database,`begin read only;set local search_path='';select ${expression};rollback;`))[0];}
for(const hold of [false,true])test(`release transaction preserves exact ledger and ${hold?'HOLD':'healthy catalog'}`,()=>{
 const database='mam_test_pr_routing_release_'+(hold?'hold':'healthy');predecessor(database);const prev=ledger(database);c.sql(database,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash();');if(hold)c.sql(database,'grant select on public.profiles to authenticated;');const before=state(database,prev),sql=releasePython("print(json.dumps(m['transaction'](v['source'],v['before'],v['predecessor'])))",{source,predecessor:prev,before});c.sql(database,sql);const after=state(database,prev);assert.equal(after.targetExact,true);assert.equal(after.ready,true);assert.deepEqual(after.ledger.slice(0,-1),before.ledger);assert.equal(releasePython("m['validate_preserved'](v['after'],v['before'],v['source'],v['after']['catalogHash']);print('true')",{after,before,source}),true);
});
test('release transaction rejects changed ledger before schema mutation',()=>{
 const database='mam_test_pr_routing_release_stale';predecessor(database);const prev=ledger(database),before=state(database,prev),sql=releasePython("print(json.dumps(m['transaction'](v['source'],v['before'],v['predecessor'])))",{source,predecessor:prev,before});c.sql(database,"update supabase_migrations.schema_migrations set name='changed';");const result=c.run(database,sql);assert.notEqual(result.status,0);assert.match(result.stderr,/55000.*locked predecessor changed/s);assert.equal(c.sql(database,`select to_regprocedure(${q(sig)}) is null;`).trim(),'t');
});
test('release readback rejects changed function metadata',()=>{
 const database='mam_test_pr_routing_readback';predecessor(database);const prev=ledger(database),before=state(database,prev),sql=releasePython("print(json.dumps(m['transaction'](v['source'],v['before'],v['predecessor'])))",{source,predecessor:prev,before});c.sql(database,sql);c.sql(database,`alter function ${sig} security definer;`);const result=spawnSync('python3',['-B','-c',"import runpy,json,sys;m=runpy.run_path('scripts/deploy-performance-review-invitation-routing.py');v=json.load(sys.stdin);m['validate_preserved'](v['after'],v['before'],v['source'])"],{env,encoding:'utf8',input:JSON.stringify({after:state(database,prev),before,source})});assert.notEqual(result.status,0);assert.match(result.stderr,/Exact invitation routing catalog definitions differ/);
});
