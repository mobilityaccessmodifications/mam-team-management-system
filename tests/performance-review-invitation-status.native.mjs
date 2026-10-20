import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {ownedCluster,definition,rows,q,user,person,env} from './performance-review-production-harness.mjs';
const migration='supabase/migrations/20261020232835_performance_review_meeting_invitation_status.sql';
const source=readFileSync(migration,'utf8'),db='mam_test_pr_invite_status',sig='public.performance_review_meeting_invitation_status(uuid,uuid)';
const id='c4000000-0000-4000-8000-000000000001';
const draft={answers:Array(12).fill(''),ratings:Array(12).fill(''),summary:'',overallRating:'',managerNote:''};
const signed=(i,s,extra={})=>`set local role authenticated;select set_config('request.jwt.claims',${q(JSON.stringify({sub:user(i),iat:1900000000,...extra}))},true);${s}reset role;`;
const status=(delegate=null,reviewId=id)=>`public.performance_review_meeting_invitation_status(${q(reviewId)}${delegate===null?'':','+q(person(delegate))})`;
const insert=(employee=1,reviewer='manager',manager=2)=>`insert into private.performance_reviews(id,employee_person_id,assigned_manager_person_id,assigned_admin_user_id,cycle,due_date,employee_identity,manager_identity,self_submitted_at,self_version) values(${q(id)},${q(person(employee))},${reviewer==='manager'?q(person(manager)):'null'},${reviewer==='manager'?'null':q(user(reviewer==='p0'?5:4))},'2039','2039-12-31',private.performance_review_identity(${q(person(employee))}),${reviewer==='manager'?'private.performance_review_identity('+q(person(manager))+')':`jsonb_build_object('id',${q(user(reviewer==='p0'?5:4))},'name','Synthetic reviewer')`},clock_timestamp(),1);`;
const invite=(who=2,delegate=false)=>signed(who,`select ${delegate?'public.mutate_performance_review_for_delegate('+q(person(2))+',':'public.mutate_performance_review('}${q(randomUUID())},${q(id)},'${who===4||who===5&&!delegate?'read':'manager'}:1:0','complete_manager',${q(JSON.stringify(draft))}::jsonb);`);
const accepted=(finish=true)=>`create temporary table invite_claim as select * from public.claim_performance_review_notifications(${q(id)},10);create temporary table invite_reserve as select public.reserve_performance_review_notification_mail(payload->>'eventKey',payload->>'recipient',payload->>'cc',claim_token,null) value from invite_claim where payload->>'event'='manager-invited';select public.confirm_notification_delivery((select payload->>'eventKey' from invite_claim where payload->>'event'='manager-invited'),(select (value->>'deliveryToken')::uuid from invite_reserve),(select payload->>'recipient' from invite_claim where payload->>'event'='manager-invited'),(select payload->>'cc' from invite_claim where payload->>'event'='manager-invited'),'${JSON.stringify({accepted:true,messageId:'synthetic',requestId:null,statusCode:202})}'::jsonb);${finish?"select public.finish_performance_review_notification(delivery_id,claim_token,true) from invite_claim where payload->>'event'='manager-invited';":''}`;
let c;
function predecessor(database){
 c.setup(database);c.sql(database,readFileSync('supabase/migrations/20261017103000_performance_review_completion_guards.sql','utf8'));
 c.sql(database,definition('20261006104000_unified_portal_roles.sql','create or replace function private.is_system_portal_account_admin()'));
 c.sql(database,'revoke all on function private.is_system_portal_account_admin() from public,anon,authenticated,service_role;');
 c.sql(database,"alter table private.employee_directory_details add column work_email text;insert into private.employee_directory_details(person_id,work_email) select id,'person'||right(id::text,1)||'@mobilityaccess.com.au' from public.internal_org_people;");
 c.sql(database,readFileSync('supabase/migrations/20260923010000_durable_notification_delivery_receipts.sql','utf8'));
 c.sql(database,definition('20261014110000_subscription_review_managers_mail.sql','create or replace function private.notification_event_key_valid('));
 for(const f of ['20261019105639_performance_review_readonly_preview.sql','20261019110000_performance_review_notifications.sql','20261019211233_performance_review_p0_manager_delegation.sql','20261019225516_performance_review_admin_reviewer.sql','20261020003343_performance_review_careers_cc.sql','20261020212355_performance_review_meeting_invitation.sql'])c.sql(database,readFileSync('supabase/migrations/'+f,'utf8'));
 c.sql(database,"update private.notification_delivery_control set legacy_import_sha256=repeat('a',64),legacy_import_count=0,legacy_imported_at=clock_timestamp();select private.set_notification_delivery_ready(true);");
}
const json=s=>rows(c.sql(db,`begin;${s}rollback;`)).filter(x=>!Object.hasOwn(x,'sub'));
const denied=s=>{const r=c.run(db,`begin;${s}rollback;`);assert.notEqual(r.status,0);assert.match(r.stderr,/42501/);};
before(()=>{c=ownedCluster(17);predecessor(db);c.sql(db,source);});
after(()=>c?.stop());
test('status function is authenticated-only and private tables stay inaccessible',()=>{
 assert.equal(c.sql(db,`select has_function_privilege('authenticated',${q(sig)},'EXECUTE');`).trim(),'t');
 for(const role of ['anon','service_role'])assert.equal(c.sql(db,`select has_function_privilege(${q(role)},${q(sig)},'EXECUTE');`).trim(),'f');
 for(const role of ['anon','authenticated','service_role'])for(const table of ['private.performance_review_notifications','private.notification_delivery_receipts','private.performance_review_meeting_requests'])assert.equal(c.sql(db,`select has_table_privilege(${q(role)},${q(table)},'SELECT');`).trim(),'f');
 const metadata=rows(c.sql(db,`select jsonb_build_object('stable',provolatile='s','definer',prosecdef,'config',proconfig,'owner',pg_get_userbyid(proowner)) from pg_proc where oid=${q(sig)}::regprocedure;`))[0];assert.deepEqual(metadata,{stable:true,definer:true,config:['search_path=""'],owner:'postgres'});
});
test('only dual durable manager invitation evidence reports sent and output is narrow',()=>{
 const out=json(`${insert()}${signed(2,`select ${status()};`)}${invite()}${signed(2,`select ${status()};`)}${accepted(false)}${signed(2,`select ${status()};`)}select public.finish_performance_review_notification(delivery_id,claim_token,true) from invite_claim where payload->>'event'='manager-invited';${signed(2,`select ${status()};`)}`);
 const states=out.filter(x=>Object.hasOwn(x,'reviewId'));assert.deepEqual(states,[false,false,false,true].map(sent=>({reviewId:id,sent})));
});
for(const [name,change] of [['receipt state',"update private.notification_delivery_receipts set state='processing',provider_receipt=null,sent_at=null where event_key like '%:manager-invited';"],['recipient',"update private.performance_review_notifications set recipient='other@example.test' where event='manager-invited';"],['CC',"update private.performance_review_notifications set cc='' where event='manager-invited';"],['notification state',"update private.performance_review_notifications set state='needs_review' where event='manager-invited';"],['wrong event',"update private.notification_delivery_receipts set event_key=replace(event_key,':manager-invited',':self-submitted') where event_key like '%:manager-invited';"]])test(`mismatched ${name} never reports sent`,()=>{
 const out=json(`${insert()}${invite()}${accepted()}${change}${signed(2,`select ${status()};`)}`);assert.deepEqual(out.at(-1),{reviewId:id,sent:false});
});
test('status excludes employee, unrelated manager, account, anonymous and stale access',()=>{
 for(const who of [1,3,6,8])denied(`${insert()}${signed(who,`select ${status()};`)}`);
 denied(`${insert()}set local role anon;select ${status()};`);
 denied(`${insert()}set local role service_role;select ${status()};`);
 denied(`${insert()}${signed(2,`select ${status()};`,{is_anonymous:true})}`);
 denied(`${insert()}update public.profiles set account_status='disabled' where id=${q(user(2))};${signed(2,`select ${status()};`)}`);
 denied(`${insert()}${signed(2,`select ${status(null,randomUUID())};`)}`);
 denied(`${insert()}${signed(2,`select ${status(null,null)};`)}`);
});
test('native Admin and P0 receive manager-side status but never their own self review',()=>{
 for(const who of [4,5])assert.deepEqual(json(`${insert()}${signed(who,`select ${status()};`)}`).at(-1),{reviewId:id,sent:false});
 denied(`${insert(4)}${signed(4,`select ${status()};`)}`);
});
test('P0 manager delegation follows assigned manager, while non-manager and non-P0 previews are denied',()=>{
 assert.deepEqual(json(`${insert()}${invite(5,true)}${accepted()}${signed(5,`select ${status(2)};`)}`).at(-1),{reviewId:id,sent:true});
 for(const target of [1,3,4,6,8])denied(`${insert()}${signed(5,`select ${status(target)};`)}`);
 for(const who of [2,4])denied(`${insert()}${signed(who,`select ${status(2)};`)}`);
 denied(`${insert(2,'manager',9)}${signed(5,`select ${status(2)};`)}`);
 denied(`${insert()}update public.internal_org_people set is_active=false where id=${q(person(2))};${signed(5,`select ${status(2)};`)}`);
});
test('sent status survives finalisation, imported meeting and later canonical address changes',()=>{
 const out=json(`${insert()}${invite()}${accepted()}update private.performance_reviews set meeting='${JSON.stringify({date:'2020-01-02',time:'10:00',duration:30,mode:'in_person',location:'Synthetic room',notes:''})}'::jsonb,meeting_held_at=clock_timestamp(),finalised_at=clock_timestamp() where id=${q(id)};update private.performance_review_meeting_requests set imported_at=clock_timestamp(),event_id='synthetic-event',event_uid='synthetic-uid',event_created_at=clock_timestamp(),event_modified_at=clock_timestamp() where review_id=${q(id)};update private.employee_directory_details set work_email='changed@example.test' where person_id=${q(person(2))};${signed(2,`select ${status()};`)}`);assert.deepEqual(out.at(-1),{reviewId:id,sent:true});
});
test('status reads are inert and repeated manager draft saves cannot requeue the invitation',()=>{
 const out=json(`${insert()}${invite()}${accepted()}create temporary table status_before as select md5(jsonb_build_object('reviews',(select jsonb_agg(to_jsonb(x)) from private.performance_reviews x),'events',(select jsonb_agg(to_jsonb(x)) from private.performance_review_events x),'notifications',(select jsonb_agg(to_jsonb(x)) from private.performance_review_notifications x),'receipts',(select jsonb_agg(to_jsonb(x)) from private.notification_delivery_receipts x),'operations',(select jsonb_agg(to_jsonb(x)) from private.performance_review_operations x))::text) hash;${signed(2,`select ${status()};select ${status()};`)}select jsonb_build_object('inert',hash=md5(jsonb_build_object('reviews',(select jsonb_agg(to_jsonb(x)) from private.performance_reviews x),'events',(select jsonb_agg(to_jsonb(x)) from private.performance_review_events x),'notifications',(select jsonb_agg(to_jsonb(x)) from private.performance_review_notifications x),'receipts',(select jsonb_agg(to_jsonb(x)) from private.notification_delivery_receipts x),'operations',(select jsonb_agg(to_jsonb(x)) from private.performance_review_operations x))::text)) from status_before;${signed(2,`select public.mutate_performance_review(${q(randomUUID())},${q(id)},'manager:1:1','save_manager',${q(JSON.stringify(draft))}::jsonb);`)}select jsonb_build_object('notifications',(select count(*) from private.performance_review_notifications where event='manager-invited'),'requests',(select count(*) from private.performance_review_meeting_requests));`);
 assert.deepEqual(out.at(-3),{inert:true});assert.deepEqual(out.at(-1),{notifications:1,requests:1});
});
for(const hold of [false,true])test(`status migration preserves ${hold?'existing purge HOLD':'healthy purge baseline'}`,()=>{
 const database='mam_test_pr_invite_purge_'+(hold?'hold':'healthy');predecessor(database);c.sql(database,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash();');if(hold)c.sql(database,'grant select on public.profiles to authenticated;');const before=c.sql(database,'select schema_hash from private.confirmed_test_purge_schema;');c.sql(database,source);
 assert.equal(c.sql(database,'select schema_hash=private.confirmed_test_purge_schema_hash() from private.confirmed_test_purge_schema;').trim(),hold?'f':'t');assert.equal(before===c.sql(database,'select schema_hash from private.confirmed_test_purge_schema;'),hold);
});
test('status migration refuses auth helper drift and unrelated grants atomically',()=>{
 for(const [name,setup,injection] of [['auth',"grant execute on function private.performance_review_preview_actor(uuid) to authenticated;",''],['grant','','grant select on public.profiles to authenticated;']]){
  const database='mam_test_pr_invite_reject_'+name;predecessor(database);if(setup)c.sql(database,setup);const result=c.run(database,injection?source.replace('do $invitation_status_catalog_after$',injection+'\ndo $invitation_status_catalog_after$'):source);assert.notEqual(result.status,0);assert.match(result.stderr,/55000.*Performance invitation status (predecessor differs|unrelated catalog delta)/s);assert.equal(c.sql(database,`select to_regprocedure(${q(sig)}) is null;`).trim(),'t');
 }
});
function releasePython(code,value){const r=spawnSync('python3',['-B','-c',"import runpy,json,sys;m=runpy.run_path('scripts/deploy-performance-review-invitation-status.py');v=json.load(sys.stdin);"+code],{env,encoding:'utf8',input:JSON.stringify(value)});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
function ledger(database){const prev=readFileSync('supabase/migrations/20261020212355_performance_review_meeting_invitation.sql','utf8');c.sql(database,`create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);insert into supabase_migrations.schema_migrations values('20261020212355','performance_review_meeting_invitation',ARRAY[${q(prev)}]::text[]);`);return prev;}
function state(database,prev){const expression=releasePython("print(json.dumps(m['state_expression'](v['source'],v['predecessor'])))",{source,predecessor:prev});return rows(c.sql(database,`begin read only;set local search_path='';select ${expression};rollback;`))[0];}
for(const hold of [false,true])test(`release transaction preserves exact ledger and ${hold?'HOLD':'healthy catalog'}`,()=>{
 const database='mam_test_pr_invite_release_'+(hold?'hold':'healthy');predecessor(database);const prev=ledger(database);c.sql(database,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash();');if(hold)c.sql(database,'grant select on public.profiles to authenticated;');const before=state(database,prev),sql=releasePython("print(json.dumps(m['transaction'](v['source'],v['before'],v['predecessor'])))",{source,predecessor:prev,before});c.sql(database,sql);const after=state(database,prev);assert.equal(after.targetExact,true);assert.equal(after.ready,true);assert.deepEqual(after.ledger.slice(0,-1),before.ledger);assert.equal(releasePython("m['validate_preserved'](v['after'],v['before'],v['source'],v['after']['catalogHash']);print('true')",{after,before,source}),true);
});
test('release transaction rejects a changed ledger before schema mutation',()=>{
 const database='mam_test_pr_invite_release_stale';predecessor(database);const prev=ledger(database),before=state(database,prev),sql=releasePython("print(json.dumps(m['transaction'](v['source'],v['before'],v['predecessor'])))",{source,predecessor:prev,before});c.sql(database,"update supabase_migrations.schema_migrations set name='changed';");const result=c.run(database,sql);assert.notEqual(result.status,0);assert.match(result.stderr,/55000.*locked predecessor changed/s);assert.equal(c.sql(database,`select to_regprocedure(${q(sig)}) is null;`).trim(),'t');
});

test('status RPC executes in a read-only transaction with no writes',()=>{
 const database='mam_test_pr_invite_read_only';predecessor(database);c.sql(database,source);c.sql(database,'begin;'+insert()+invite()+accepted()+'commit;');
 const out=rows(c.sql(database,`begin read only;${signed(2,`select ${status()};`)}rollback;`)).filter(x=>!Object.hasOwn(x,'sub'));assert.deepEqual(out.at(-1),{reviewId:id,sent:true});
});
test('readback rejects changed target volatility metadata',()=>{
 const database='mam_test_pr_invite_readback';predecessor(database);const prev=ledger(database),before=state(database,prev),sql=releasePython("print(json.dumps(m['transaction'](v['source'],v['before'],v['predecessor'])))",{source,predecessor:prev,before});c.sql(database,sql);c.sql(database,`alter function ${sig} volatile;`);
 const r=spawnSync('python3',['-B','-c',"import runpy,json,sys;m=runpy.run_path('scripts/deploy-performance-review-invitation-status.py');v=json.load(sys.stdin);m['validate_preserved'](v['after'],v['before'],v['source'])"],{env,encoding:'utf8',input:JSON.stringify({after:state(database,prev),before,source})});assert.notEqual(r.status,0);assert.match(r.stderr,/Exact invitation status catalog definitions differ/);
});

test('native 90-day retention preserves confirmed status and cannot grant a resend',()=>{
 const out=json(`${insert()}${invite()}${accepted()}update private.notification_delivery_receipts set sent_at=clock_timestamp()-interval '91 days' where event_key like '%:manager-invited';select jsonb_build_object('minimized',private.minimize_notification_delivery_receipts('{}'::text[],1000));${signed(2,`select ${status()};`)}select jsonb_build_object('state',state,'recipient',recipient,'cc',cc) from private.notification_delivery_receipts where event_key like '%:manager-invited';select public.reserve_notification_delivery('performance-review:${id}:manager-invited','person1@mobilityaccess.com.au,person2@mobilityaccess.com.au','careers@mobilityaccess.com.au',null);`);
 assert.deepEqual(out.at(-4),{minimized:1});assert.deepEqual(out.at(-3),{reviewId:id,sent:true});assert.deepEqual(out.at(-2),{state:'sent_tombstone',recipient:null,cc:null});assert.notEqual(out.at(-1).outcome,'send');
});
for(const notificationState of ['queued','needs_review'])test(`tombstone cannot prove an unconfirmed ${notificationState} invitation`,()=>{
 const change=notificationState==='queued'?"state='queued',claim_token=null,recipient=null,cc=null,claimed_at=null,finished_at=null":"state='needs_review'";
 const out=json(`${insert()}${invite()}${accepted()}update private.notification_delivery_receipts set sent_at=clock_timestamp()-interval '91 days' where event_key like '%:manager-invited';select private.minimize_notification_delivery_receipts('{}'::text[],1000);update private.performance_review_notifications set ${change} where event='manager-invited';${signed(2,`select ${status()};`)}`);assert.deepEqual(out.at(-1),{reviewId:id,sent:false});
});
test('tombstone with a different event key cannot prove the invitation',()=>{
 const out=json(`${insert()}${invite()}${accepted()}update private.notification_delivery_receipts set sent_at=clock_timestamp()-interval '91 days' where event_key like '%:manager-invited';select private.minimize_notification_delivery_receipts('{}'::text[],1000);update private.notification_delivery_receipts set event_key=replace(event_key,':manager-invited',':self-submitted') where event_key like '%:manager-invited';${signed(2,`select ${status()};`)}`);assert.deepEqual(out.at(-1),{reviewId:id,sent:false});
});
