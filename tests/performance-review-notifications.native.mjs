import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {readFileSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {ownedCluster,definition,rows,q,user,person,env} from './performance-review-production-harness.mjs';

const db='mam_test_pr_notifications';
const migration='supabase/migrations/20261019110000_performance_review_notifications.sql';
const review='c1000000-0000-4000-8000-000000000001';
const event=kind=>`performance-review:${review}:${kind}`;
const email=i=>`person${i}@example.test`;
const proof={accepted:true,messageId:'synthetic-performance-notification',requestId:null,statusCode:202};
let c,careersBefore;
const careersSource=()=>c.sql(db,"select pg_get_functiondef(oid) from pg_proc where oid in('public.claim_performance_review_mail(uuid,integer)'::regprocedure,'public.begin_performance_review_mail(uuid,uuid,text)'::regprocedure,'public.finish_performance_review_mail(uuid,uuid,text,text)'::regprocedure) order by proname;");
const insert=(id=review,cycle='2031')=>`insert into private.performance_reviews(id,employee_person_id,assigned_manager_person_id,cycle,due_date,employee_identity,manager_identity)
 values(${q(id)},${q(person(1))},${q(person(2))},${q(cycle)},'2031-12-31',private.performance_review_identity(${q(person(1))}),private.performance_review_identity(${q(person(2))}));`;
const asService=sql=>`set local role service_role;${sql}reset role;`;
const claim=()=>`select row_to_json(item) from public.claim_performance_review_notifications(${q(review)},1) item`;
const reserve=(kind='started',recipient=email(1),token=':token')=>`select public.reserve_performance_review_notification_mail(${q(event(kind))},${q(recipient)},'',${token===':token'?'(select claim_token from notification_claim)':q(token)}::uuid,null);`;
const withClaim=(setup='')=>`${insert()}${setup}
 create temporary table notification_claim as select * from public.claim_performance_review_notifications(${q(review)},1);
 grant select on notification_claim to service_role;`;
const finish=delivered=>`select public.finish_performance_review_notification((select delivery_id from notification_claim),(select claim_token from notification_claim),${delivered});`;
const transaction=sql=>c.sql(db,`begin;${sql}rollback;`);
const json=sql=>rows(transaction(sql));

before(()=>{
 const version=spawnSync('postgres',['--version'],{encoding:'utf8'});
 const major=Number(/PostgreSQL\) (\d+)\./.exec(version.stdout)?.[1]);
 assert.ok([16,17].includes(major),'Use the local PostgreSQL 16 or 17 binaries');
 c=ownedCluster(major);c.setup(db);
 c.sql(db,readFileSync('supabase/migrations/20261017103000_performance_review_completion_guards.sql','utf8'));
 c.sql(db,"alter table private.employee_directory_details add column work_email text; insert into private.employee_directory_details(person_id,work_email) select id,'person'||right(id::text,1)||'@example.test' from public.internal_org_people;");
 c.sql(db,readFileSync('supabase/migrations/20260923010000_durable_notification_delivery_receipts.sql','utf8'));
 c.sql(db,definition('20261014110000_subscription_review_managers_mail.sql','create or replace function private.notification_event_key_valid('));
 c.sql(db,`${insert('c1000000-0000-4000-8000-000000000099','2030')} update private.performance_reviews set self_submitted_at=clock_timestamp();`);
 careersBefore=careersSource();
 c.sql(db,readFileSync(migration,'utf8'));
 c.sql(db,"update private.notification_delivery_control set legacy_import_sha256=repeat('a',64),legacy_import_count=0,legacy_imported_at=clock_timestamp(); select private.set_notification_delivery_ready(true);");
});
after(()=>c?.stop());

test('notification migration does not backfill reviews and preserves final Careers functions',()=>{
 assert.equal(c.sql(db,'select count(*) from private.performance_review_notifications;').trim(),'0');
 assert.equal(careersSource(),careersBefore);
 const result=transaction(`${insert()} select count(*) from private.performance_review_notifications;`);
 assert.match(result,/\n1\n/);
 assert.equal(c.sql(db,'select count(*) from private.performance_review_notifications;').trim(),'0','queue insert rolls back with review');
});

test('event validator predecessor drift rejects the migration atomically',()=>{
 const before=c.sql(db,"select prosrc from pg_proc where oid='private.notification_event_key_valid(text)'::regprocedure;");
 const denied=c.run(db,`begin;create or replace function private.notification_event_key_valid(p_key text) returns boolean language sql immutable set search_path='' as $$select true$$;${readFileSync(migration,'utf8')}`);
 assert.notEqual(denied.status,0);assert.match(denied.stderr,/55000.*Performance notification event validator predecessor differs/s);
 assert.equal(c.sql(db,"select prosrc from pg_proc where oid='private.notification_event_key_valid(text)'::regprocedure;"),before);
});

test('actual start RPC and NULL-to-submitted updates queue each event once',()=>{
 const result=json(`set local role authenticated;select set_config('request.jwt.claims',${q(JSON.stringify({sub:user(2),iat:1900000000}))},true);
 select public.start_performance_review('d1000000-0000-4000-8000-000000000001',${q(person(1))},'2031','2031-12-31');
 select public.start_performance_review('d1000000-0000-4000-8000-000000000001',${q(person(1))},'2031','2031-12-31');
 reset role;
 update private.performance_reviews set self_submitted_at=clock_timestamp() where cycle='2031';
 update private.performance_reviews set self_submitted_at=clock_timestamp() where cycle='2031';
 update private.performance_reviews set self_submitted_at=null where cycle='2031';
 update private.performance_reviews set self_submitted_at=clock_timestamp() where cycle='2031';
 select jsonb_object_agg(event,n) from(select event,count(*) n from private.performance_review_notifications group by event) x;`);
 assert.deepEqual(result.at(-1),{'started':1,'self-submitted':1});
});

test('claims return the closed employee payload and never reclaim a claimed row',()=>{
 const result=json(`${insert()}${asService(`${claim()};${claim()};`)}`);
 assert.equal(result.length,1);
 const row=result[0];assert.equal(row.review_id,review);assert.match(row.claim_token,/^[0-9a-f-]{36}$/);
 assert.deepEqual(Object.keys(row).sort(),['claim_token','delivery_id','payload','review_id']);
 assert.deepEqual(Object.keys(row.payload).sort(),['cycle','dueDate','employeeName','event','eventKey','managerName','recipient','reviewCode','reviewId']);
 assert.equal(row.payload.event,'started');assert.equal(row.payload.eventKey,event('started'));
 assert.equal(row.payload.recipient,email(1));assert.equal(row.payload.reviewId,review);
 assert.equal(row.payload.employeeName,'Synthetic person 1');assert.equal(row.payload.managerName,'Synthetic person 2');
 assert.equal(row.payload.cycle,'2031');assert.equal(row.payload.dueDate,'2031-12-31');
 assert.match(row.payload.reviewCode,/^PR-2031-\d+$/);
});

test('canonical 8000 UTF16-unit employee and manager names remain deliverable',()=>{
 const name='🦽'.repeat(4000);
 const result=json(`update public.internal_org_people set full_name=${q(name)} where id in(${q(person(1))},${q(person(2))});
 set local role authenticated;select set_config('request.jwt.claims',${q(JSON.stringify({sub:user(2),iat:1900000000}))},true);
 select public.start_performance_review('d1000000-0000-4000-8000-000000000002',${q(person(1))},'2031','2031-12-31');
 reset role;select set_config('request.jwt.claims','{}',true);
 ${asService('select row_to_json(item) from public.claim_performance_review_notifications(null,1) item;')}`);
 assert.equal(result.at(-1).payload.employeeName,name);assert.equal(result.at(-1).payload.managerName,name);
});

test('self submission quarantines a stale started event and addresses the stored manager',()=>{
 const result=json(`${insert()} update private.performance_reviews set self_submitted_at=clock_timestamp() where id=${q(review)};
 update public.internal_org_people set parent_id=${q(person(3))} where id=${q(person(1))};
 ${asService(`select row_to_json(item) from public.claim_performance_review_notifications(${q(review)},10) item;`)}
 select jsonb_object_agg(event,state) from private.performance_review_notifications;`);
 assert.equal(result.length,2);assert.equal(result[0].payload.event,'self-submitted');assert.equal(result[0].payload.recipient,email(2));
 assert.deepEqual(result[1],{'started':'needs_review','self-submitted':'claimed'});
});

for(const [name,change] of [
 ['inactive employee',`update public.internal_org_people set is_active=false where id=${q(person(1))};`],
 ['inactive manager',`update public.internal_org_people set is_active=false where id=${q(person(2))};`],
 ['inactive employee profile',`update public.profiles set account_status='inactive' where id=${q(user(1))};`],
 ['inactive manager profile',`update public.profiles set account_status='inactive' where id=${q(user(2))};`],
 ['manager lost role',`update public.profiles set app_role='employee' where id=${q(user(2))};`],
 ['duplicate normalized address',`update private.employee_directory_details set work_email=' PERSON1@EXAMPLE.TEST ' where person_id=${q(person(3))};`],
 ['missing address',`update private.employee_directory_details set work_email=null where person_id=${q(person(1))};`],
 ['invalid address',`update private.employee_directory_details set work_email='person1@example.test,other@example.test' where person_id=${q(person(1))};`],
 ['employee identity mismatch',`update private.performance_reviews set employee_identity=jsonb_build_object('id',${q(person(3))},'name','Synthetic person 3') where id=${q(review)};`],
 ['manager identity mismatch',`update private.performance_reviews set manager_identity=jsonb_build_object('id',${q(person(3))},'name','Synthetic person 3') where id=${q(review)};`],
 ['invalid canonical name',`update private.performance_reviews set employee_identity=jsonb_set(employee_identity,'{name}',to_jsonb(E'LEFT\\013RIGHT'::text)) where id=${q(review)};`],
 ['cross company',`update public.internal_org_people set company_key='equipsy' where id=${q(person(2))};`],
]) test(`queued ${name} is quarantined without a send grant`,()=>{
 const result=json(`${insert()}${change}${asService(`${claim()};`)} select jsonb_build_object('state',state,'token',claim_token) from private.performance_review_notifications;`);
 assert.deepEqual(result,[{state:'needs_review',token:null}]);
});

test('service-only ACL denies browser table access, RPC calls and private helpers',()=>{
 const result=json(`select jsonb_build_object('rls',relrowsecurity,'force',relforcerowsecurity) from pg_class where oid='private.performance_review_notifications'::regclass;
 select jsonb_build_object('role',role,'table',has_table_privilege(role,'private.performance_review_notifications','SELECT,INSERT,UPDATE,DELETE'),
 'claim',has_function_privilege(role,'public.claim_performance_review_notifications(uuid,integer)','EXECUTE'),
 'reserve',has_function_privilege(role,'public.reserve_performance_review_notification_mail(text,text,text,uuid,text)','EXECUTE'),
 'finish',has_function_privilege(role,'public.finish_performance_review_notification(uuid,uuid,boolean)','EXECUTE'),
 'helper',has_function_privilege(role,'private.performance_review_notification_payload(private.performance_reviews,text)','EXECUTE'))
 from unnest(array['anon','authenticated','service_role']) role;`);
 assert.deepEqual(result[0],{rls:true,force:true});
 for(const row of result.slice(1)) {
  assert.equal(row.table,false);assert.equal(row.helper,false);
  for(const rpc of ['claim','reserve','finish']) assert.equal(row[rpc],row.role==='service_role');
 }
 for(const role of ['anon','authenticated']) {
  const denied=c.run(db,`begin;set local role ${role};select * from public.claim_performance_review_notifications();rollback;`);
  assert.notEqual(denied.status,0);assert.match(denied.stderr,/42501.*permission denied for function claim_performance_review_notifications/s);
 }
});

test('reservation requires exact claim token, current recipient, empty CC and no legacy alias',()=>{
 const result=json(`${withClaim()}${asService(`${reserve('started',email(1),'00000000-0000-0000-0000-000000000000')}${reserve('started',email(3))}`)}
 select jsonb_build_object('receipts',count(*)) from private.notification_delivery_receipts;`);
 assert.equal(result[0].rejectionCode,'performance-notification-unavailable');assert.equal(result[1].rejectionCode,'performance-notification-unavailable');
 assert.deepEqual(result[2],{receipts:0});
 for(const [cc,legacy] of [[null,null],['other@example.test',null],['','leave:bad']]) {
  const denied=c.run(db,`begin;${withClaim()}${asService(`select public.reserve_performance_review_notification_mail(${q(event('started'))},${q(email(1))},${q(cc)},(select claim_token from notification_claim),${q(legacy)});`)}rollback;`);
  assert.notEqual(denied.status,0);assert.match(denied.stderr,/22023.*Invalid performance notification reservation/s);
 }
});

test('finish true requires matching sent generic receipt and duplicate remains safe',()=>{
 const result=json(`${withClaim()}
 create temporary table notification_reservation(result jsonb);grant select,insert on notification_reservation to service_role;
 ${asService(`select jsonb_build_object('early',public.finish_performance_review_notification((select delivery_id from notification_claim),(select claim_token from notification_claim),true));
 insert into notification_reservation select public.reserve_performance_review_notification_mail(${q(event('started'))},${q(email(1))},'',(select claim_token from notification_claim),null);
 select result from notification_reservation;
 select jsonb_build_object('processing',public.finish_performance_review_notification((select delivery_id from notification_claim),(select claim_token from notification_claim),true));
 select public.confirm_notification_delivery(${q(event('started'))},(select (result->>'deliveryToken')::uuid from notification_reservation),${q(email(1))},'',${q(JSON.stringify(proof))}::jsonb);
 select jsonb_build_object('finished',public.finish_performance_review_notification((select delivery_id from notification_claim),(select claim_token from notification_claim),true));`)}
 update public.internal_org_people set is_active=false where id=${q(person(1))};
 ${asService(`${reserve()} select jsonb_build_object('repeat',public.finish_performance_review_notification((select delivery_id from notification_claim),(select claim_token from notification_claim),true),
 'downgrade',public.finish_performance_review_notification((select delivery_id from notification_claim),(select claim_token from notification_claim),false));`)}
 select jsonb_build_object('state',state) from private.performance_review_notifications;`);
 assert.deepEqual(result[0],{early:false});assert.equal(result[1].outcome,'send');assert.deepEqual(result[2],{processing:false});
 assert.equal(result[3].sent,true);assert.deepEqual(result[4],{finished:true});assert.equal(result[5].outcome,'duplicate');
 assert.deepEqual(result[6],{repeat:true,downgrade:false});assert.deepEqual(result[7],{state:'provider_accepted'});
});

for(const [recipient,cc] of [[email(3),''],[email(1),'other@example.test']]) test(`finish refuses a sent receipt with mismatched ${cc?'CC':'To'}`,()=>{
 const result=json(`${withClaim()}
 create temporary table notification_reservation as select public.reserve_notification_delivery(${q(event('started'))},${q(recipient)},${q(cc)},null) result;
 select public.confirm_notification_delivery(${q(event('started'))},(select (result->>'deliveryToken')::uuid from notification_reservation),${q(recipient)},${q(cc)},${q(JSON.stringify(proof))}::jsonb);
 ${asService(`select jsonb_build_object('finished',public.finish_performance_review_notification((select delivery_id from notification_claim),(select claim_token from notification_claim),true));`)}
 select jsonb_build_object('state',state) from private.performance_review_notifications;`);
 assert.equal(result[0].sent,true);assert.deepEqual(result[1],{finished:false});assert.deepEqual(result[2],{state:'claimed'});
});

test('claimed unknown delivery is terminal and retains generic processing/unknown no-resend semantics',()=>{
 const result=json(`${withClaim()}${asService(`${reserve()}
 select jsonb_build_object('wrongToken',public.finish_performance_review_notification((select delivery_id from notification_claim),'00000000-0000-0000-0000-000000000000',false),
 'unknown',public.finish_performance_review_notification((select delivery_id from notification_claim),(select claim_token from notification_claim),false));
 ${reserve()}`)}
 update private.notification_delivery_receipts set created_at=clock_timestamp()-interval '21 minutes';
 ${asService(`${reserve()}${claim()};select jsonb_build_object('repeat',public.finish_performance_review_notification((select delivery_id from notification_claim),(select claim_token from notification_claim),false),
 'upgrade',public.finish_performance_review_notification((select delivery_id from notification_claim),(select claim_token from notification_claim),true));`)}
 select jsonb_build_object('state',state,'receipts',(select count(*) from private.notification_delivery_receipts)) from private.performance_review_notifications;`);
 assert.equal(result[0].outcome,'send');assert.deepEqual(result[1],{wrongToken:false,unknown:true});
 assert.equal(result[2].rejectionCode,'delivery-in-flight');assert.equal(result[3].rejectionCode,'receipt-delivery-unknown');
 assert.deepEqual(result[4],{repeat:true,upgrade:false});assert.deepEqual(result[5],{state:'needs_review',receipts:1});
});

test('unknown without a generic receipt cannot obtain a later send grant',()=>{
 const result=json(`${withClaim()}${asService(`${finish('false')}${reserve()}${claim()};`)}
 select jsonb_build_object('state',state,'receipts',(select count(*) from private.notification_delivery_receipts)) from private.performance_review_notifications;`);
 assert.equal(result[0].rejectionCode,'performance-notification-unavailable');assert.deepEqual(result[1],{state:'needs_review',receipts:0});
});

for(const [name,change,kind,recipient] of [
 ['employee address changed',`update private.employee_directory_details set work_email='changed@example.test' where person_id=${q(person(1))};`,'started',email(1)],
 ['employee disabled',`update public.profiles set account_status='inactive' where id=${q(user(1))};`,'started',email(1)],
 ['manager reassigned',`update private.performance_reviews set assigned_manager_person_id=${q(person(3))},manager_identity=private.performance_review_identity(${q(person(3))}) where id=${q(review)};`,'self-submitted',email(2)],
]) test(`reservation rechecks ${name} after claim and quarantines without a receipt`,()=>{
 const submitted=kind==='self-submitted'?`update private.performance_reviews set self_submitted_at=clock_timestamp() where id=${q(review)};update private.performance_review_notifications set state='needs_review',finished_at=clock_timestamp() where event='started';`:'';
 const result=json(`${withClaim(submitted)}${change}${asService(reserve(kind,recipient))}
 select jsonb_build_object('state',state,'receipts',(select count(*) from private.notification_delivery_receipts)) from private.performance_review_notifications where event=${q(kind)};`);
 assert.equal(result[0].rejectionCode,'performance-notification-unavailable');assert.deepEqual(result[1],{state:'needs_review',receipts:0});
});

test('all prior event namespaces survive while Performance event suffixes stay closed',()=>{
 const id=review;
 const valid=[`leave:${id}:leave-submitted:${'a'.repeat(24)}`,`payroll-balance:${id}:2031-12`,`payroll-comparison:${id}`,
 `new-starter:${id}:day-one:live`,`checkin:${id}:6-month-casual:initial:test`,`checkin-review:${id}:hr:1:live`,
 `onboarding-credential:${id}`,`subscription-request:${id}:1`,`subscription-review:${id}:2031-12-31:due`,event('started'),event('self-submitted')];
 const invalid=[event('finalised'),event('submit_self'),event('started')+':extra',event('started').toUpperCase(),'performance-review:bad:started'];
 const result=json(`select jsonb_build_object('key',key,'valid',private.notification_event_key_valid(key)) from unnest(array[${[...valid,...invalid].map(q).join(',')}]) key;`);
 for(const row of result) assert.equal(row.valid,valid.includes(row.key),row.key);
});

test('two real PostgreSQL sessions cannot claim the same queued event',async()=>{
 c.sql(db,insert(review));
 const child=spawn('psql',['-X','-h',c.socket,'-p',String(c.port),'-U','postgres','-d',db,'-Atq','-v','ON_ERROR_STOP=1'],{env,stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',status=>status===0?resolve():reject(new Error(stderr)));});done.catch(()=>{});
 try {
  child.stdin.write(`begin;set local role service_role;${claim()};select 'CLAIM_HELD';\n`);
  const deadline=Date.now()+8000;
  while(!stdout.includes('CLAIM_HELD')) {assert.ok(Date.now()<deadline,stderr||'claim barrier timeout');await delay(20);}
  assert.equal(rows(c.sql(db,`begin;${asService(`${claim()};`)}commit;`)).length,0);
  child.stdin.end('commit;\n');await done;
  assert.equal(rows(stdout).length,1);
  assert.equal(c.sql(db,`select count(*) from private.performance_review_notifications where review_id=${q(review)} and state='claimed';`).trim(),'1');
 } finally {
  if(child.exitCode===null){child.stdin.end('rollback;\n');child.kill('SIGTERM');await done.catch(()=>{});}
 }
});
