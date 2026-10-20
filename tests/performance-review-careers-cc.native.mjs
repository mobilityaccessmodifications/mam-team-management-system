import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {readFileSync} from 'node:fs';
import {ownedCluster,definition,rows,q,user,person} from './performance-review-production-harness.mjs';

const source=readFileSync('supabase/migrations/20261020003343_performance_review_careers_cc.sql','utf8');
const db='mam_test_pr_careers_cc',major=Number(process.env.MAM_PERFORMANCE_CC_TEST_PG_MAJOR??'17');
const careers='careers@mobilityaccess.com.au';
const oldReview='c2000000-0000-4000-8000-000000000001',newReview='c2000000-0000-4000-8000-000000000002',queuedReview='c2000000-0000-4000-8000-000000000003',unreservedReview='c2000000-0000-4000-8000-000000000004';
const event=id=>`performance-review:${id}:started`;
const proof={accepted:true,messageId:'synthetic-cc-proof',requestId:null,statusCode:202};
const changed=['public.claim_performance_review_notifications(uuid,integer)','public.reserve_performance_review_notification_mail(text,text,text,uuid,text)','public.finish_performance_review_notification(uuid,uuid,boolean)'];
let c,beforeFunctions;
const insert=(id=newReview,cycle=id===oldReview?'2030':'2031')=>`insert into private.performance_reviews(id,employee_person_id,assigned_manager_person_id,cycle,due_date,employee_identity,manager_identity) values(${q(id)},${q(person(1))},${q(person(2))},${q(cycle)},'2031-12-31',private.performance_review_identity(${q(person(1))}),private.performance_review_identity(${q(person(2))}));`;
const transaction=sql=>c.sql(db,`begin;${sql}rollback;`);
const json=sql=>rows(transaction(sql));
const service=sql=>`set local role service_role;${sql}reset role;`;
const claim=id=>`create temporary table cc_claim as select * from public.claim_performance_review_notifications(${q(id)},1);grant select on cc_claim to service_role;`;
const reserve=(id,cc)=>`select public.reserve_performance_review_notification_mail(${q(event(id))},'person1@mobilityaccess.com.au',${q(cc)},(select claim_token from cc_claim),null)`;
const finish=()=>`select jsonb_build_object('finished',public.finish_performance_review_notification((select delivery_id from cc_claim),(select claim_token from cc_claim),true))`;
const preserved=database=>c.sql(database,`select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('private','public') and p.prokind='f' and p.oid<>all(array[${changed.map(x=>q(x)+'::regprocedure::oid').join(',')}]) order by n.nspname,p.proname,p.oid;`);
function predecessor(database){
  c.setup(database);
  c.sql(database,readFileSync('supabase/migrations/20261017103000_performance_review_completion_guards.sql','utf8'));
  c.sql(database,definition('20261006104000_unified_portal_roles.sql','create or replace function private.is_system_portal_account_admin()'));
  c.sql(database,'revoke all on function private.is_system_portal_account_admin() from public,anon,authenticated,service_role;');
  c.sql(database,"alter table private.employee_directory_details add column work_email text;insert into private.employee_directory_details(person_id,work_email) select id,'person'||right(id::text,1)||'@mobilityaccess.com.au' from public.internal_org_people;");
  c.sql(database,readFileSync('supabase/migrations/20260923010000_durable_notification_delivery_receipts.sql','utf8'));
  c.sql(database,definition('20261014110000_subscription_review_managers_mail.sql','create or replace function private.notification_event_key_valid('));
  for(const file of ['20261019105639_performance_review_readonly_preview.sql','20261019110000_performance_review_notifications.sql','20261019211233_performance_review_p0_manager_delegation.sql','20261019225516_performance_review_admin_reviewer.sql'])c.sql(database,readFileSync('supabase/migrations/'+file,'utf8'));
  c.sql(database,"update private.notification_delivery_control set legacy_import_sha256=repeat('a',64),legacy_import_count=0,legacy_imported_at=clock_timestamp();select private.set_notification_delivery_ready(true);");
}
before(()=>{
  c=ownedCluster(major);predecessor(db);
  c.sql(db,`${insert(oldReview)}select * from public.claim_performance_review_notifications(${q(oldReview)},1);select public.reserve_performance_review_notification_mail(${q(event(oldReview))},'person1@mobilityaccess.com.au','',(select claim_token from private.performance_review_notifications where review_id=${q(oldReview)}),null);`);
  c.sql(db,`${insert(queuedReview,'2032')}${insert(unreservedReview,'2033')}select * from public.claim_performance_review_notifications(${q(unreservedReview)},1);`);
  beforeFunctions=preserved(db);c.sql(db,source);
});
after(()=>c?.stop());

test('CC migration preserves all unrelated routines, ACLs and the old claimed recipient intent',()=>{
  assert.equal(preserved(db),beforeFunctions);
  assert.deepEqual(rows(c.sql(db,`select jsonb_build_object('cc',cc,'state',state) from private.performance_review_notifications where review_id=${q(oldReview)};`))[0],{cc:'',state:'claimed'});
  const acl=rows(c.sql(db,`select jsonb_build_object('rls',relrowsecurity,'forced',relforcerowsecurity,'tableAccess',has_table_privilege('service_role','private.performance_review_notifications','SELECT')) from pg_class where oid='private.performance_review_notifications'::regclass;`))[0];
  assert.deepEqual(acl,{rls:true,forced:true,tableAccess:false});
  for(const signature of changed)for(const role of ['anon','authenticated'])assert.equal(c.sql(db,`select has_function_privilege(${q(role)},${q(signature)},'EXECUTE');`).trim(),'f');
});

test('a pre-migration in-flight reservation confirms once with its original empty CC and never resends',()=>{
  const result=json(`create temporary table cc_claim as select n.delivery_id,n.claim_token,r.delivery_token from private.performance_review_notifications n join private.notification_delivery_receipts r on r.event_key=${q(event(oldReview))} where n.review_id=${q(oldReview)};grant select on cc_claim to service_role;
  ${service(`select public.confirm_notification_delivery(${q(event(oldReview))},(select delivery_token from cc_claim),'person1@mobilityaccess.com.au','',${q(JSON.stringify(proof))}::jsonb);${finish()};${reserve(oldReview,'')};`)}`);
  assert.equal(result[0].sent,true);assert.deepEqual(result[1],{finished:true});assert.equal(result[2].outcome,'duplicate');assert.equal(result[2].actualCcRecipients,'');
});

for(const cc of ['',careers])test(`legacy reservation retains its ${cc?'rejected changed':'original empty'} CC`,()=>{
  const result=json(`create temporary table cc_claim as select delivery_id,claim_token from private.performance_review_notifications where review_id=${q(oldReview)};grant select on cc_claim to service_role;${service(`${reserve(oldReview,cc)};`)}`);
  assert.equal(result[0].rejectionCode,cc?'performance-notification-unavailable':'delivery-in-flight');
});

test('a pre-migration queued notification picks up Careers only when newly claimed',()=>{
  const result=json(`${claim(queuedReview)}select payload from cc_claim;`);
  assert.equal(result[0].cc,careers);
});

test('a legacy claim with no reservation yet may reserve only its original empty CC',()=>{
  const result=json(`create temporary table cc_claim as select delivery_id,claim_token from private.performance_review_notifications where review_id=${q(unreservedReview)};grant select on cc_claim to service_role;
  ${service(`${reserve(unreservedReview,careers)};${reserve(unreservedReview,'')};${reserve(unreservedReview,'')};`)}`);
  assert.equal(result[0].rejectionCode,'performance-notification-unavailable');assert.equal(result[1].outcome,'send');assert.equal(result[2].rejectionCode,'delivery-in-flight');
});

test('new claims snapshot Careers CC, exact send evidence finishes and duplicate cannot resend',()=>{
  const result=json(`${insert()}${claim(newReview)}select payload from cc_claim;
  create temporary table cc_reservation as ${reserve(newReview,careers)};grant select on cc_reservation to service_role;
  ${service(`select public.confirm_notification_delivery(${q(event(newReview))},(select (reserve_performance_review_notification_mail->>'deliveryToken')::uuid from cc_reservation),'person1@mobilityaccess.com.au',${q(careers)},${q(JSON.stringify(proof))}::jsonb);select jsonb_build_object('finished',public.finish_performance_review_notification((select delivery_id from cc_claim),(select claim_token from cc_claim),true));${reserve(newReview,careers)};`)}`);
  assert.equal(result[0].cc,careers);assert.equal(result[1].actualCcRecipients,careers);assert.deepEqual(result[2],{finished:true});assert.equal(result[3].outcome,'duplicate');assert.equal(result[3].actualCcRecipients,careers);
});

test('new claims cannot reserve an empty, alternate or multiple CC recipient set',()=>{
  for(const cc of ['', 'other@example.test', careers+',other@example.test', null]){
    const result=c.run(db,`begin;${insert()}${claim(newReview)}${service(`${reserve(newReview,cc)};`)}rollback;`);
    if(cc===''){
      assert.equal(result.status,0);assert.equal(rows(result.stdout)[0].rejectionCode,'performance-notification-unavailable');
    }else{assert.notEqual(result.status,0);assert.match(result.stderr,/22023.*Invalid performance notification reservation/s);}
  }
});

test('new finish refuses a generic sent receipt without the snapshotted Careers CC',()=>{
  const result=json(`${insert()}${claim(newReview)}
  create temporary table cc_wrong as select public.reserve_notification_delivery(${q(event(newReview))},'person1@mobilityaccess.com.au','',null) value;grant select on cc_wrong to service_role;
  ${service(`select public.confirm_notification_delivery(${q(event(newReview))},(select (value->>'deliveryToken')::uuid from cc_wrong),'person1@mobilityaccess.com.au','',${q(JSON.stringify(proof))}::jsonb);select jsonb_build_object('finished',public.finish_performance_review_notification((select delivery_id from cc_claim),(select claim_token from cc_claim),true));`)}`);
  assert.equal(result[0].sent,true);assert.deepEqual(result[1],{finished:false});
});

test('Careers primary recipient gets no duplicate CC',()=>{
  const result=json(`${insert()}update private.employee_directory_details set work_email=${q(careers)} where person_id=${q(person(1))};${claim(newReview)}select payload from cc_claim;select jsonb_build_object('cc',cc) from private.performance_review_notifications where review_id=${q(newReview)};`);
  assert.equal(result[0].recipient,careers);assert.equal(result[0].cc,'');assert.deepEqual(result[1],{cc:''});
});

test('the actual P0 reviewer self-submission recipient remains Careers without duplicate CC',()=>{
  const result=json(`set local role authenticated;select set_config('request.jwt.claims',${q(JSON.stringify({sub:user(5),iat:1900000000}))},true);select public.start_performance_review('d2000000-0000-4000-8000-000000000001',${q(person(2))},'2039','2039-12-31');reset role;
  update private.performance_reviews set self_submitted_at=clock_timestamp() where cycle='2039';
  update private.performance_review_notifications set state='needs_review',finished_at=clock_timestamp() where event='started' and review_id in(select id from private.performance_reviews where cycle='2039');
  select payload from public.claim_performance_review_notifications((select id from private.performance_reviews where cycle='2039'),1);`);
  const payload=result.at(-1);assert.equal(payload.recipient,careers);assert.equal(payload.cc,'');
});

for(const drift of [false,true])test(`CC migration ${drift?'preserves preexisting purge HOLD':'advances a healthy purge baseline'}`,()=>{
  const database='mam_test_pr_cc_purge_'+(drift?'hold':'healthy');predecessor(database);
  c.sql(database,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;');
  if(drift)c.sql(database,'grant select on public.profiles to authenticated;');
  const stored=c.sql(database,'select schema_hash from private.confirmed_test_purge_schema where singleton;');
  c.sql(database,source);
  assert.equal(c.sql(database,'select schema_hash=private.confirmed_test_purge_schema_hash() from private.confirmed_test_purge_schema where singleton;').trim(),drift?'f':'t');
  assert.equal(c.sql(database,'select schema_hash from private.confirmed_test_purge_schema where singleton;')===stored,drift);
});

test('CC migration rejects predecessor drift and unrelated catalog or data writes atomically',()=>{
  for(const [label,setup,injection] of [
    ['predecessor',"create or replace function public.finish_performance_review_notification(p_delivery_id uuid,p_claim_token uuid,p_delivered boolean) returns boolean language plpgsql volatile security definer set search_path='' as $$begin return true;end$$;",''],
    ['grant','','grant select on public.profiles to authenticated;'],
    ['row','',"update private.performance_review_notifications set state='needs_review',finished_at=clock_timestamp();"],
  ]){
    const database='mam_test_pr_cc_reject_'+label;predecessor(database);c.sql(database,insert());
    if(setup)c.sql(database,setup);
    const candidate=injection?source.replace('do $cc_catalog_after$',injection+'\ndo $cc_catalog_after$'):source;
    const result=c.run(database,candidate);assert.notEqual(result.status,0);assert.match(result.stderr,/55000.*Performance CC (predecessor differs|unrelated catalog or data delta)/s);
    assert.equal(c.sql(database,"select exists(select 1 from pg_attribute where attrelid='private.performance_review_notifications'::regclass and attname='cc' and not attisdropped);").trim(),'f');
  }
});
