import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {ownedCluster,definition,rows,q,user,person,env} from './performance-review-production-harness.mjs';
const migration='supabase/migrations/20261020212355_performance_review_meeting_invitation.sql';
const source=readFileSync(migration,'utf8'),db='mam_test_pr_meeting';
const major=Number(process.env.MAM_PERFORMANCE_MEETING_TEST_PG_MAJOR??'17');
const id='c3000000-0000-4000-8000-000000000001',careers='careers@mobilityaccess.com.au',ai='ai@mobilityaccess.com.au';
const draft={answers:Array(12).fill(''),ratings:Array(12).fill(''),summary:'',overallRating:'',managerNote:''};
const full={answers:Array(12).fill('Synthetic answer'),ratings:Array(12).fill('2 Meets expectations'),summary:'Synthetic summary',overallRating:'2 Meets expectations',managerNote:'Synthetic private note'};
const manual={date:'2026-10-21',time:'15:00',duration:30,mode:'in_person',location:'Synthetic room',notes:'Manual notes'};
const signed=(i,s)=>`set local role authenticated;select set_config('request.jwt.claims',${q(JSON.stringify({sub:user(i),iat:1900000000}))},true);${s}reset role;`;
const mutate=(command,input=draft,revision='manager:1:0',delegate=false)=>`${delegate?'public.mutate_performance_review_for_delegate('+q(person(2))+',':'public.mutate_performance_review('}${q(randomUUID())},${q(id)},${q(revision)},${q(command)},${q(JSON.stringify(input))}::jsonb)`;
const insert=(reviewer='manager')=>`insert into private.performance_reviews(id,employee_person_id,assigned_manager_person_id,assigned_admin_user_id,cycle,due_date,employee_identity,manager_identity,self_submitted_at,self_version)
 values(${q(id)},${q(person(1))},${reviewer==='manager'?q(person(2)):'null'},${reviewer==='manager'?'null':q(user(reviewer==='p0'?5:4))},'2039','2039-12-31',private.performance_review_identity(${q(person(1))}),${reviewer==='manager'?'private.performance_review_identity('+q(person(2))+')':`jsonb_build_object('id',${q(user(reviewer==='p0'?5:4))},'name','Synthetic reviewer')`},clock_timestamp(),1);`;
const event=(patch={})=>({id:'synthetic-graph-event',uid:'synthetic-ical-uid',subject:'RE: Performance review meeting PR-2039-1',organizer:'person2@mobilityaccess.com.au',attendees:['person1@mobilityaccess.com.au',ai],start:'2039-10-21T02:00:00Z',end:'2039-10-21T02:30:00Z',createdAt:'2039-10-20T00:00:00Z',modifiedAt:'2039-10-20T00:00:00Z',mode:'in_person',location:'Synthetic room',isCancelled:false,isAllDay:false,type:'singleInstance',...patch});
const importEvent=(e=event(),revision='manager:1:1')=>`select public.import_performance_review_meeting((select request_token from private.performance_review_meeting_requests where review_id=${q(id)}),${q(revision)},${q(JSON.stringify(e))}::jsonb${e.subject==='RE: Performance review meeting PR-2039-1'?`||jsonb_build_object('subject',(select 'RE: Performance review meeting PR-'||cycle||'-'||review_no from private.performance_reviews where id=${q(id)}))`:''});`;
const invite=(who=2,delegate=false)=>signed(who,`select ${mutate('complete_manager',draft,who===4||who===5&&!delegate?'read:1:0':'manager:1:0',delegate)};`);
const accepted=()=>`create temporary table meeting_claim as select * from public.claim_performance_review_notifications(${q(id)},10);create temporary table meeting_reserve as select public.reserve_performance_review_notification_mail(payload->>'eventKey',payload->>'recipient',payload->>'cc',claim_token,null) value from meeting_claim where payload->>'event'='manager-invited';
 select public.confirm_notification_delivery((select payload->>'eventKey' from meeting_claim where payload->>'event'='manager-invited'),(select (value->>'deliveryToken')::uuid from meeting_reserve),(select payload->>'recipient' from meeting_claim where payload->>'event'='manager-invited'),(select payload->>'cc' from meeting_claim where payload->>'event'='manager-invited'),'${JSON.stringify({accepted:true,messageId:'synthetic',requestId:null,statusCode:202})}'::jsonb);
 select public.finish_performance_review_notification(delivery_id,claim_token,true) from meeting_claim where payload->>'event'='manager-invited';`;
let c;
const json=s=>rows(c.sql(db,`begin;${s}rollback;`)).filter(r=>!Object.hasOwn(r,'sub'));
const failure=(s,code='22023')=>{const r=c.run(db,`begin;${s}rollback;`);assert.notEqual(r.status,0);assert.match(r.stderr,new RegExp(code));return r;};
function predecessor(database){
 c.setup(database);c.sql(database,readFileSync('supabase/migrations/20261017103000_performance_review_completion_guards.sql','utf8'));
 c.sql(database,definition('20261006104000_unified_portal_roles.sql','create or replace function private.is_system_portal_account_admin()'));
 c.sql(database,'revoke all on function private.is_system_portal_account_admin() from public,anon,authenticated,service_role;');
 c.sql(database,"alter table private.employee_directory_details add column work_email text;insert into private.employee_directory_details(person_id,work_email) select id,'person'||right(id::text,1)||'@mobilityaccess.com.au' from public.internal_org_people;");
 c.sql(database,readFileSync('supabase/migrations/20260923010000_durable_notification_delivery_receipts.sql','utf8'));
 c.sql(database,definition('20261014110000_subscription_review_managers_mail.sql','create or replace function private.notification_event_key_valid('));
 for(const f of ['20261019105639_performance_review_readonly_preview.sql','20261019110000_performance_review_notifications.sql','20261019211233_performance_review_p0_manager_delegation.sql','20261019225516_performance_review_admin_reviewer.sql','20261020003343_performance_review_careers_cc.sql'])c.sql(database,readFileSync('supabase/migrations/'+f,'utf8'));
 c.sql(database,"update private.notification_delivery_control set legacy_import_sha256=repeat('a',64),legacy_import_count=0,legacy_imported_at=clock_timestamp();select private.set_notification_delivery_ready(true);");
}
before(()=>{c=ownedCluster(major);predecessor(db);c.sql(db,source);});
after(()=>c?.stop());
test('meeting migration is inert for historical data and exposes only service RPCs',()=>{
 assert.equal(c.sql(db,'select count(*) from private.performance_review_meeting_requests;').trim(),'0');
 for(const role of ['anon','authenticated','service_role'])assert.equal(c.sql(db,`select has_table_privilege(${q(role)},'private.performance_review_meeting_requests','SELECT');`).trim(),'f');
 for(const role of ['anon','authenticated'])for(const sig of ['public.list_performance_review_meeting_imports(integer)','public.import_performance_review_meeting(uuid,text,jsonb)'])assert.equal(c.sql(db,`select has_function_privilege(${q(role)},${q(sig)},'EXECUTE');`).trim(),'f');
 assert.deepEqual(rows(c.sql(db,"select jsonb_build_object('rls',relrowsecurity,'forced',relforcerowsecurity) from pg_class where oid='private.performance_review_meeting_requests'::regclass;"))[0],{rls:true,forced:true});
});
test('partial draft invitation creates one request with real actor and one notification',()=>{
 const out=json(`${insert()}${invite()}select jsonb_build_object('actor',requested_by,'version',initial_manager_version,'token',request_token) from private.performance_review_meeting_requests;${signed(2,`select ${mutate('complete_manager',draft,'manager:1:1')};`)}select jsonb_build_object('requests',(select count(*) from private.performance_review_meeting_requests),'notifications',(select count(*) from private.performance_review_notifications where event='manager-invited'));`);
 assert.ok(out[0].review.managerCompletedAt);assert.equal(out[1].actor,user(2));assert.equal(out[1].version,1);assert.match(out[1].token,/^[0-9a-f-]{36}$/);assert.deepEqual(out.at(-1),{requests:1,notifications:1});
});
test('manual meeting accepts invited draft, preserves workflow marker on assessment save, final requires full assessment',()=>{
 const out=json(`${insert()}${invite()}${signed(2,`select ${mutate('save_manager',draft,'manager:1:1')};select ${mutate('save_meeting',manual,'manager:1:2')};`)}`);assert.ok(out[1].review.managerCompletedAt);assert.deepEqual(out.at(-1).review.meeting,manual);
 failure(`${insert()}${invite()}${signed(2,`select ${mutate('submit_review',{...manual,held:true},'manager:1:1')};`)}`);
});
test('P0 manager delegation records actual P0 and uses assigned manager recipients',()=>{
 const out=json(`${insert()}${invite(5,true)}select jsonb_build_object('actor',requested_by) from private.performance_review_meeting_requests;select private.performance_review_notification_payload(r,'manager-invited') from private.performance_reviews r where id=${q(id)};`);
 assert.equal(out[1].actor,user(5));assert.equal(out[2].recipient,'person1@mobilityaccess.com.au,person2@mobilityaccess.com.au');
});
for(const role of ['p0','admin'])test(`${role} review invites reviewer plus employee with canonical recipient set`,()=>{
 const out=json(`${insert(role)}${invite(role==='p0'?5:4)}${accepted()}select payload from meeting_claim where payload->>'event'='manager-invited';select public.list_performance_review_meeting_imports(1001);`);
 const payload=out.at(-2),target=out.at(-1)[0];assert.equal(payload.recipient,role==='p0'?'careers@mobilityaccess.com.au,person1@mobilityaccess.com.au':'person1@mobilityaccess.com.au,person4@mobilityaccess.com.au');assert.equal(payload.cc,role==='p0'?'':careers);assert.equal(target.managerEmail,role==='p0'?careers:'person4@mobilityaccess.com.au');
});
test('only accepted invite enables import, once imported later event never overwrites manual edits',()=>{
 const out=json(`${insert()}${invite()}select public.list_performance_review_meeting_imports(1001);${importEvent()}${accepted()}select public.list_performance_review_meeting_imports(1001);${importEvent()}${signed(2,`select ${mutate('save_meeting',manual,'manager:1:2')};`)}${importEvent(event({id:'changed'}),'manager:1:3')}select meeting from private.performance_reviews where id=${q(id)};select public.list_performance_review_meeting_imports(1001);`);
 assert.deepEqual(out[1],[]);assert.deepEqual(out[2],{status:'skipped'});assert.equal(out.at(-5).status,'imported');assert.deepEqual(out.at(-3),{status:'already_imported'});assert.deepEqual(out.at(-2),manual);assert.deepEqual(out.at(-1),[]);
});
test('stale revision skips; current revision retries import after assessment edit',()=>{
 const out=json(`${insert()}${invite()}${accepted()}${signed(2,`select ${mutate('save_manager',draft,'manager:1:1')};`)}${importEvent()}${importEvent(event(),'manager:1:2')}select meeting from private.performance_reviews where id=${q(id)};`);assert.deepEqual(out.at(-3),{status:'skipped'});assert.deepEqual(out.at(-2),{status:'imported'});assert.equal(out.at(-1).time,'13:00');
});
test('manual meeting before import wins and is never overwritten',()=>{
 const out=json(`${insert()}${invite()}${accepted()}${signed(2,`select ${mutate('save_meeting',manual,'manager:1:1')};`)}${importEvent(event(),'manager:1:2')}select meeting from private.performance_reviews where id=${q(id)};`);assert.deepEqual(out.at(-2),{status:'skipped'});assert.deepEqual(out.at(-1),manual);
});
for(const [name,patch] of Object.entries({cancelled:{isCancelled:true},allDay:{isAllDay:true},recurrence:{type:'seriesMaster'},organizer:{organizer:'person3@mobilityaccess.com.au'},attendees:{attendees:[ai,'person3@mobilityaccess.com.au']},malformed:{attendees:[ai,'person1@mobilityaccess.com.au','not-an-address']},duplicate:{attendees:[ai,'person1@mobilityaccess.com.au',ai]},subject:{subject:'PR-2039-1 PR-2039-2'},old:{createdAt:'2000-01-01T00:00:00Z'},precision:{start:'2039-10-21T02:00:30Z'},duration:{end:'2039-10-21T02:02:00Z'},badDate:{start:'2039-02-31T02:00:00Z'},badTeams:{mode:'teams',location:'https://outside.example.test/'}}))test(`meeting import rejects ${name} without writing`,()=>{failure(`${insert()}${invite()}${accepted()}${importEvent(event(patch))}`);});
test('final review still requires ended meeting and full assessment, final outbox stays single',()=>{
 failure(`${insert()}${signed(2,`select ${mutate('complete_manager',full)};select ${mutate('submit_review',{...manual,date:'2039-10-21',held:true},'manager:1:1')};`)}`);
 const out=json(`${insert()}${signed(2,`select ${mutate('complete_manager',full)};select ${mutate('submit_review',{...manual,date:'2020-01-02',held:true},'manager:1:1')};`)}select jsonb_build_object('finals',(select count(*) from private.performance_review_mail_outbox),'document',(select final_document is not null from private.performance_reviews where id=${q(id)}));`);assert.deepEqual(out.at(-1),{finals:1,document:true});
});
for(const hold of [false,true])test(`meeting migration preserves ${hold?'an existing purge HOLD':'a healthy purge baseline'}`,()=>{
 const database='mam_test_pr_meeting_'+(hold?'hold':'healthy');predecessor(database);c.sql(database,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash();');
 if(hold)c.sql(database,'grant select on public.profiles to authenticated;');
 const before=c.sql(database,'select schema_hash from private.confirmed_test_purge_schema;');c.sql(database,source);
 assert.equal(c.sql(database,'select schema_hash=private.confirmed_test_purge_schema_hash() from private.confirmed_test_purge_schema;').trim(),hold?'f':'t');
 assert.equal(before===c.sql(database,'select schema_hash from private.confirmed_test_purge_schema;'),hold);
});
test('meeting migration refuses function drift and unrelated catalog/data writes atomically',()=>{
 for(const [name,setup,injection] of [['function',"create or replace function public.list_performance_review_meeting_imports(p_limit integer default1001) returns jsonb language sql as $$select '[]'::jsonb$$;",''],['grant','','grant select on public.profiles to authenticated;'],['row','',"update private.performance_reviews set summary='UNRELATED';"]]){
  const database='mam_test_pr_meeting_reject_'+name;predecessor(database);c.sql(database,insert());
  if(setup)c.sql(database,setup.replace('default1001','default 1001'));
  const candidate=injection?source.replace('do $meeting_after$',injection+'\ndo $meeting_after$'):source;
  const result=c.run(database,candidate);assert.notEqual(result.status,0);assert.match(result.stderr,/55000.*Performance meeting (predecessor differs|unrelated catalog or data delta)/s);
  assert.equal(c.sql(database,"select to_regclass('private.performance_review_meeting_requests') is null;").trim(),'t');
 }
});

function connection(database,sql,ready){
 const child=spawn('psql',['-X','-h',c.socket,'-p',String(c.port),'-U','postgres','-d',database,'-At','-v','ON_ERROR_STOP=1'],{env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
 child.stdout.on('data',chunk=>{stdout+=chunk;if(ready&&stdout.includes('LOCKED')){ready();ready=null;}});child.stderr.on('data',chunk=>{stderr+=chunk;});child.stdin.end(sql);
 return new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>{try{assert.equal(code,0,stderr);resolve(rows(stdout));}catch(error){reject(error);}});});
}
test('two simultaneous automatic imports commit exactly once',async()=>{
 const database='mam_test_pr_meeting_once';predecessor(database);c.sql(database,source);c.sql(database,`begin;${insert()}${invite()}${accepted()}commit;`);
 const results=await Promise.all([connection(database,`begin;${importEvent()}commit;`),connection(database,`begin;${importEvent(event({id:'second-graph-event'}))}commit;`)]);
 assert.deepEqual(results.map(x=>x[0].status).sort(),['already_imported','imported']);
 assert.equal(c.sql(database,`select manager_version from private.performance_reviews where id=${q(id)};`).trim(),'2');
 assert.equal(c.sql(database,'select count(*) from private.performance_review_meeting_requests where imported_at is not null;').trim(),'1');
});
test('manual update holding the review lock wins against a simultaneous import',async()=>{
 const database='mam_test_pr_meeting_race';predecessor(database);c.sql(database,source);c.sql(database,`begin;${insert()}${invite()}${accepted()}commit;`);
 let locked;const barrier=new Promise(resolve=>{locked=resolve;});
 const editing=connection(database,`begin;${signed(2,`select ${mutate('save_meeting',manual,'manager:1:1')};`)}select 'LOCKED';select pg_sleep(0.3);commit;`,locked);
 await barrier;const importing=connection(database,`begin;${importEvent()}commit;`);await editing;
 assert.deepEqual((await importing)[0],{status:'skipped'});
 assert.deepEqual(rows(c.sql(database,`select meeting from private.performance_reviews where id=${q(id)};`))[0],manual);
 assert.equal(c.sql(database,'select count(*) from private.performance_review_meeting_requests where imported_at is not null;').trim(),'0');
});

test('employee AI mailbox overlap permits one canonical AI attendee',()=>{
 const out=json(`update private.employee_directory_details set work_email='${ai}' where person_id=${q(person(1))};${insert()}${invite()}${accepted()}${importEvent(event({attendees:[ai]}))}`);assert.deepEqual(out.at(-1),{status:'imported'});
});
test('manager AI mailbox and additional meeting guests remain valid',()=>{
 const out=json(`update private.employee_directory_details set work_email='${ai}' where person_id=${q(person(2))};${insert()}${invite()}${accepted()}${importEvent(event({organizer:ai,attendees:[ai,'person1@mobilityaccess.com.au','guest@example.test']}))}`);assert.deepEqual(out.at(-1),{status:'imported'});
});

function releasePython(code,value){const r=spawnSync('python3',['-B','-c',"import runpy,json,sys; m=runpy.run_path('scripts/deploy-performance-review-meeting.py');v=json.load(sys.stdin);"+code],{env,encoding:'utf8',input:JSON.stringify(value)});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
function nativeLedger(database){const prev=readFileSync('supabase/migrations/20261020003343_performance_review_careers_cc.sql','utf8');c.sql(database,`create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);insert into supabase_migrations.schema_migrations values('20261020003343','performance_review_careers_cc',ARRAY[${q(prev)}]::text[]);`);return prev;}
function releaseState(database,prev){const expression=releasePython("print(json.dumps(m['state_expression'](v['source'],v['predecessor'])))",{source,predecessor:prev});return rows(c.sql(database,`begin read only;set local search_path='';select ${expression};rollback;`))[0];}
for(const hold of [false,true])test(`static release transaction preserves exact ledger and ${hold?'existing HOLD':'healthy purge baseline'}`,{skip:major!==17},()=>{
 const database='mam_test_pr_meeting_release_'+(hold?'hold':'healthy');predecessor(database);const prev=nativeLedger(database);c.sql(database,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash();');if(hold)c.sql(database,'grant select on public.profiles to authenticated;');
 const before=releaseState(database,prev);const sql=releasePython("print(json.dumps(m['transaction'](v['source'],v['before'],v['predecessor'])))",{source,predecessor:prev,before});c.sql(database,sql);const after=releaseState(database,prev);
 assert.equal(after.targetExact,true);assert.equal(after.ready,true);assert.equal(after.ledger.length,2);assert.deepEqual(after.ledger.slice(0,1),before.ledger);
 assert.equal(releasePython("m['validate_preserved'](v['after'],v['before'],v['source'],v['after']['catalogHash']);print('true')",{after,before,source}),true);
});
test('static release transaction refuses changed native ledger without side effects',{skip:major!==17},()=>{
 const database='mam_test_pr_meeting_release_stale';predecessor(database);const prev=nativeLedger(database),before=releaseState(database,prev),sql=releasePython("print(json.dumps(m['transaction'](v['source'],v['before'],v['predecessor'])))",{source,predecessor:prev,before});
 c.sql(database,"update supabase_migrations.schema_migrations set statements=ARRAY['unapproved predecessor'];");const r=c.run(database,sql);assert.notEqual(r.status,0);assert.match(r.stderr,/55000.*Meeting locked predecessor changed/s);
 assert.equal(c.sql(database,"select to_regclass('private.performance_review_meeting_requests') is null;").trim(),'t');
});

test('import audit constraint rejects every partial imported marker',()=>{
 for(const missing of ['event_id','event_uid','event_created_at','event_modified_at']){const fields={event_id:q('synthetic-event'),event_uid:q('synthetic-uid'),event_created_at:'clock_timestamp()',event_modified_at:'clock_timestamp()'};fields[missing]='null';failure(`${insert()}${invite()}update private.performance_review_meeting_requests set imported_at=clock_timestamp(),${Object.entries(fields).map(([key,value])=>key+'='+value).join(',')};`,'23514');}
});
test('scoped release accepts routine statistics maintenance and unrelated business writes',{skip:major!==17},async()=>{
 const database='mam_test_pr_meeting_release_scope';predecessor(database);c.sql(database,'create table public.synthetic_other_business(id integer primary key,value text);insert into public.synthetic_other_business values(1,\'Synthetic\');');const prev=nativeLedger(database),before=releaseState(database,prev),sql=releasePython("print(json.dumps(m['transaction'](v['source'],v['before'],v['predecessor'])))",{source,predecessor:prev,before});
 c.sql(database,'analyze public.profiles;analyze public.synthetic_other_business;');
 let locked;const barrier=new Promise(resolve=>{locked=resolve;});const writing=connection(database,"begin;update public.synthetic_other_business set value='Synthetic updated' where id=1;select 'LOCKED';select pg_sleep(1);commit;",locked);
 await barrier;try{c.sql(database,sql);}finally{await writing;}const after=releaseState(database,prev);assert.equal(after.targetExact,true);assert.equal(after.preservedHash,before.preservedHash);assert.equal(c.sql(database,'select value from public.synthetic_other_business;').trim(),'Synthetic updated');
});
