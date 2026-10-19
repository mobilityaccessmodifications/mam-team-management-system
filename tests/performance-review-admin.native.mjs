import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {ownedCluster,definition,rows,q,user,person,env} from './performance-review-production-harness.mjs';

const migration='supabase/migrations/20261019225516_performance_review_admin_reviewer.sql';
const source=readFileSync(migration,'utf8');
const db='mam_test_pr_admin';
const changed=[
 'private.performance_review_audience(private.performance_reviews)',
 'private.performance_review_project(private.performance_reviews)',
 'public.performance_review_workspace()',
 'public.start_performance_review(uuid,uuid,text,text)',
 'public.mutate_performance_review(uuid,uuid,text,text,jsonb)',
 'private.performance_review_preview_audience(private.performance_reviews,uuid,text)',
 'public.performance_review_workspace_for_preview(uuid)',
 'private.performance_review_notification_payload(private.performance_reviews,text)',
 'public.claim_performance_review_notifications(uuid,integer)',
 'public.reserve_performance_review_notification_mail(text,text,text,uuid,text)',
];
const helper='private.performance_review_admin_candidate(uuid,uuid)';
const signed=(i,sql,extra={})=>`set local role authenticated;select set_config('request.jwt.claims',${q(JSON.stringify({sub:user(i),iat:1900000000,...extra}))},true);${sql}`;
const start=(employee,cycle='2036',op=randomUUID(),due='2036-12-31')=>`public.start_performance_review(${q(op)},${q(person(employee))},${q(cycle)},${q(due)})`;
const mutate=(id,revision,command,input,op=randomUUID())=>`public.mutate_performance_review(${q(op)},${q(id)},${q(revision)},${q(command)},${q(JSON.stringify(input))}::jsonb)`;
const assessment={answers:Array(12).fill('Synthetic manager answer'),ratings:Array(12).fill('2 Meets expectations'),summary:'Synthetic summary',overallRating:'2 Meets expectations',managerNote:'SYNTHETIC-PRIVATE-NOTE'};
const selfInput={answers:Array(12).fill('Synthetic self answer')};
const meeting={date:'2026-01-02',time:'10:00',duration:30,mode:'in_person',location:'Synthetic room',notes:'Synthetic meeting',held:true};
const transaction=sql=>`begin;${sql}rollback;`;
let c,nativeReview,adminReview,linkedAdminReview,adminSelfReview,foreignReview,adminOperation,linkedAdminOperation,beforeFunctions;
const json=sql=>rows(c.sql(db,transaction(sql))).filter(row=>!Object.hasOwn(row,'sub'));
const run=sql=>rows(c.sql(db,`begin;${sql}commit;`)).filter(row=>!Object.hasOwn(row,'sub'));
const reject=(sql,code='42501')=>{const result=c.run(db,transaction(sql));assert.notEqual(result.status,0);assert.match(result.stderr,new RegExp(`${code}.*`,'s'));return result;};
const preserved=()=>c.sql(db,`select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('private','public') and p.prokind='f' and not exists(select 1 from unnest(array[${[...changed,helper].map(q).join(',')}]) signature where to_regprocedure(signature)=p.oid) order by n.nspname,p.proname,p.oid;`);
const state=()=>c.sql(db,`select md5(jsonb_build_object(
 'people',(select jsonb_agg(to_jsonb(x) order by id) from public.internal_org_people x),
 'profiles',(select jsonb_agg(to_jsonb(x) order by id) from public.profiles x),
 'reviews',(select jsonb_agg(to_jsonb(x) order by id) from private.performance_reviews x),
 'events',(select jsonb_agg(to_jsonb(x) order by id) from private.performance_review_events x),
 'operations',(select jsonb_agg(to_jsonb(x) order by actor_user_id,operation_id) from private.performance_review_operations x),
 'careers',(select jsonb_agg(to_jsonb(x) order by delivery_id) from private.performance_review_mail_outbox x),
 'notifications',(select jsonb_agg(to_jsonb(x) order by delivery_id) from private.performance_review_notifications x))::text);`);
function predecessor(database){
 c.setup(database);
 c.sql(database,readFileSync('supabase/migrations/20261017103000_performance_review_completion_guards.sql','utf8'));
 c.sql(database,definition('20261006104000_unified_portal_roles.sql','create or replace function private.is_system_portal_account_admin()'));
 c.sql(database,'revoke all on function private.is_system_portal_account_admin() from public,anon,authenticated,service_role;');
 c.sql(database,"alter table private.employee_directory_details add column work_email text;insert into private.employee_directory_details(person_id,work_email) select id,'person'||right(id::text,1)||'@mobilityaccess.com.au' from public.internal_org_people;");
 c.sql(database,readFileSync('supabase/migrations/20260923010000_durable_notification_delivery_receipts.sql','utf8'));
 c.sql(database,definition('20261014110000_subscription_review_managers_mail.sql','create or replace function private.notification_event_key_valid('));
 for(const file of ['20261019105639_performance_review_readonly_preview.sql','20261019110000_performance_review_notifications.sql','20261019211233_performance_review_p0_manager_delegation.sql'])c.sql(database,readFileSync('supabase/migrations/'+file,'utf8'));
}
before(()=>{
 c=ownedCluster(17);predecessor(db);
 nativeReview=run(signed(2,`select ${start(1,'2031')};`)).at(-1).review.id;
 foreignReview=run(signed(8,`select ${start(7,'2031')};`)).at(-1).review.id;
 run(signed(1,`select ${mutate(nativeReview,'self:0','submit_self',selfInput)};`));
 beforeFunctions=preserved();c.sql(db,source);
 adminOperation=randomUUID();adminReview=run(signed(5,`select ${start(2,'2032',adminOperation)};`)).at(-1).review.id;
 linkedAdminOperation=randomUUID();linkedAdminReview=run(signed(4,`select ${start(1,'2033',linkedAdminOperation)};`)).at(-1).review.id;
 adminSelfReview=run(signed(5,`select ${start(4,'2034')};`)).at(-1).review.id;
 run(signed(2,`select ${mutate(adminReview,'self:0','submit_self',selfInput)};`));
});
after(()=>c?.stop());

test('migration preserves unrelated routines and existing manager rows',()=>{
 assert.equal(preserved(),beforeFunctions);
 const current=rows(c.sql(db,`select jsonb_build_object('manager',assigned_manager_person_id,'admin',assigned_admin_user_id) from private.performance_reviews where id=${q(nativeReview)};`))[0];
 assert.deepEqual(current,{manager:person(2),admin:null});
});

test('P0 and Admin list active employees, managers and Admin across both companies without self initiation',()=>{
 const p0=json(signed(5,'select public.performance_review_workspace();')).at(-1);
 assert.equal(p0.viewerContext.personId,null);assert.equal(p0.startablePeople.length,8);
 for(const id of [1,2,3,4,6,7,8,9])assert.ok(p0.startablePeople.some(row=>row.id===person(id)));
 const admin=json(signed(4,'select public.performance_review_workspace();')).at(-1);
 assert.equal(admin.startablePeople.length,7);assert.ok(!admin.startablePeople.some(row=>row.id===person(4)));
 reject(signed(4,`select ${start(4)};`));
 for(const id of [1,6])assert.deepEqual(json(signed(id,'select public.performance_review_workspace();')).at(-1).startablePeople,[]);
 const manager=json(signed(2,'select public.performance_review_workspace();')).at(-1);
 assert.deepEqual(manager.startablePeople.map(row=>row.id),[person(1),person(6)]);
});

test('new Admin reviews store explicit reviewer-user identity and actual operator without fake people',()=>{
 const meta=rows(c.sql(db,`select jsonb_build_object('manager',r.assigned_manager_person_id,'admin',r.assigned_admin_user_id,'identity',r.manager_identity,'actor',e.actor_user_id,'subject',e.subject_person_id) from private.performance_reviews r join private.performance_review_events e on e.review_id=r.id and e.kind='start' where r.id=${q(adminReview)};`))[0];
 assert.deepEqual(meta,{manager:null,admin:user(5),identity:{id:user(5),name:'Super Admin'},actor:user(5),subject:person(2)});
 assert.equal(c.sql(db,`select count(*) from public.internal_org_people where auth_user_id=${q(user(5))};`).trim(),'0');
 const linked=rows(c.sql(db,`select manager_identity from private.performance_reviews where id=${q(linkedAdminReview)};`))[0];
 assert.deepEqual(linked,{id:user(4),name:'Synthetic person 4'});
});

test('manager subject receives only employee self fields and can submit own assessment',()=>{
 const row=json(signed(2,'select public.performance_review_workspace();')).at(-1).reviews.find(row=>row.id===adminReview);
 assert.equal(row.audience,'employee');assert.ok(!Object.hasOwn(row,'managerNote'));assert.ok(!Object.hasOwn(row,'readRevision'));
 const own=json(signed(4,'select public.performance_review_workspace();')).at(-1).reviews.find(row=>row.id===adminSelfReview);
 assert.equal(own.audience,'employee');assert.equal(own.capabilities.submitSelf,true);
 assert.equal(json(signed(4,`select ${mutate(adminSelfReview,'self:0','submit_self',selfInput)};`)).at(-1).review.audience,'employee');
 reject(signed(4,`select ${mutate(adminSelfReview,'read:0:0','save_manager',assessment)};`));
 reject(signed(5,`select ${mutate(adminReview,'self:1','save_self',selfInput)};`));
 reject(signed(4,`select ${mutate(adminReview,'self:1','submit_self',selfInput)};`));
});

test('native Admin uses read revisions and manager capabilities globally while previews stay readonly',()=>{
 for(const actor of [4,5]){
  const workspace=json(signed(actor,'select public.performance_review_workspace();')).at(-1);
  for(const id of [nativeReview,adminReview]){const row=workspace.reviews.find(row=>row.id===id);assert.equal(row.audience,'admin');assert.equal(row.readRevision,'read:1:0');assert.equal(row.capabilities.saveManager,true);assert.equal(row.capabilities.saveSelf,false);}
 }
 for(const target of [1,2,4])for(const row of json(signed(5,`select public.performance_review_workspace_for_preview(${q(person(target))});`)).at(-1).reviews){
  assert.ok(Object.entries(row.capabilities).every(([key,value])=>value===(key==='downloadDocument')));
 }
 const adminPreview=json(signed(5,`select public.performance_review_workspace_for_preview(${q(person(4))});`)).at(-1);
 assert.deepEqual(adminPreview.startablePeople.map(row=>row.id),json(signed(4,'select public.performance_review_workspace();')).at(-1).startablePeople.map(row=>row.id));
 const ownPreview=adminPreview.reviews.find(row=>row.id===adminSelfReview);
 assert.equal(ownPreview.audience,'employee');
});

test('Admin may review foreign-company employees but ordinary manager scope and delegation are unchanged',()=>{
 assert.equal(json(signed(4,`select ${start(7)};`)).at(-1).review.employee.id,person(7));
 reject(signed(2,`select ${start(7)};`));reject(signed(8,`select ${start(1)};`));
 const view=json(signed(5,`select public.performance_review_workspace_for_delegate(${q(person(2))});`)).at(-1);
 assert.deepEqual(view.startablePeople.map(row=>row.id),[person(1),person(6)]);
 assert.ok(!view.reviews.some(row=>row.id===foreignReview));
 assert.equal(view.reviews.find(row=>row.id===adminReview).audience,'employee');
});

test('Admin start replay and reconciliation preserve operation identity and no duplicate notifications',()=>{
 const before=state();const retry=run(signed(5,`select ${start(2,'2032',adminOperation)};`)).at(-1);
 assert.equal(retry.review.id,adminReview);assert.equal(retry.existing,false);assert.equal(state(),before);
 assert.equal(json(signed(4,`select ${start(2,'2032')};`)).at(-1).existing,true);
 reject(signed(5,`select ${start(2,'2032',adminOperation,'2036-12-30')};`),'PT409');
 const receipt=json(signed(5,`select public.get_performance_review_operation(${q(adminOperation)},${q(adminReview)});`)).at(-1);
 assert.equal(receipt.status,'committed');assert.equal(receipt.review.readRevision,'read:1:0');
 assert.deepEqual(json(signed(4,`select public.get_performance_review_operation(${q(adminOperation)},null);`)).at(-1),{status:'not_found',review:null});
});

test('all Admin manager commands retain state machine, actual audit and single final Careers outbox',()=>{
 const op=randomUUID();const result=json(signed(4,`select ${mutate(adminReview,'read:1:0','save_manager',assessment,op)};select ${mutate(adminReview,'read:1:0','save_manager',assessment,op)};select ${mutate(adminReview,'read:1:1','complete_manager',assessment)};select ${mutate(adminReview,'read:1:2','save_meeting',Object.fromEntries(Object.entries(meeting).filter(([key])=>key!=='held')))};select ${mutate(adminReview,'read:1:3','submit_review',meeting)};`)+`reset role;select jsonb_build_object('events',(select jsonb_agg(jsonb_build_object('actor',actor_user_id,'kind',kind)) from private.performance_review_events where review_id=${q(adminReview)} and kind in('save_manager','complete_manager','save_meeting','submit_review')),'outbox',(select count(*) from private.performance_review_mail_outbox where review_id=${q(adminReview)}),'document',(select final_document from private.performance_reviews where id=${q(adminReview)}));`);
 assert.deepEqual(result[0],result[1]);assert.ok(result.at(-2).review.finalisedAt);assert.equal(result.at(-1).outbox,1);
 assert.ok(result.at(-1).events.every(event=>event.actor===user(4)));assert.ok(!Object.hasOwn(result.at(-1).document,'managerNote'));
 assert.deepEqual(result.at(-1).document.manager,{id:user(5),name:'Super Admin'});
});

test('Admin cannot use manager tokens or bypass required self, completeness, meeting-ended and attachment guards',()=>{
 reject(signed(4,`select ${mutate(adminReview,'manager:1:0','save_manager',assessment)};`),'PT409');
 reject(signed(4,`select ${mutate(adminSelfReview,'read:0:0','save_manager',assessment)};`));
 reject(signed(5,`select ${mutate(linkedAdminReview,'read:0:0','save_manager',assessment)};`),'PT409');
 reject(signed(4,`select ${mutate(adminReview,'read:1:0','complete_manager',{...assessment,summary:''})};`),'22023');
 reject(signed(4,`select ${mutate(adminReview,'read:1:0','save_manager',{...assessment,summary:'bad\u0001xml'})};`),'22023');
 const complete=signed(5,`select ${mutate(adminReview,'read:1:0','complete_manager',assessment)};`);
 reject(complete+`select ${mutate(adminReview,'read:1:1','submit_review',{...meeting,date:'2099-01-02'})};`,'22023');
 reject(complete+`select ${mutate(adminReview,'read:1:1','submit_review',{...meeting,held:false})};`,'22023');
 reject(signed(5,`select ${mutate(adminReview,'read:1:0','submit_review',meeting)};`),'22023');
 const giant={...assessment,answers:Array(12).fill('\n'.repeat(7999)+'x')};
 assert.match(reject(signed(5,`select ${mutate(adminReview,'read:1:0','complete_manager',giant)};select ${mutate(adminReview,'read:1:1','submit_review',meeting)};`),'22023').stderr,/Review attachment exceeds the supported size/);
});

for(const actor of [1,2,3,6,7,8,9])test(`ordinary role ${actor} does not inherit Admin start or mutation through claimed metadata`,()=>{
 reject(signed(actor,`select ${start(4)};`,{role:'system_admin',app_metadata:{app_role:'system_admin'}}));
 for(const revision of ['read:1:0','manager:1:0'])reject(signed(actor,`select ${mutate(adminReview,revision,'save_manager',assessment)};`,{role:'admin'}));
});

for(const [label,change,extra] of [
 ['disabled Admin',`update public.profiles set account_status='disabled' where id=${q(user(4))};`,{}],
 ['demoted Admin',`update public.profiles set app_role='employee' where id=${q(user(4))};`,{}],
 ['stale Admin session','',{iat:1}],['anonymous Admin','',{is_anonymous:true}],
 ['disabled P0',`update public.profiles set account_status='disabled' where id=${q(user(5))};`,{}],
])test(`${label} loses Admin authority before writes or receipt return`,()=>{
 const actor=label==='disabled P0'?5:4;
 for(const call of [start(2),mutate(adminReview,'read:1:0','save_manager',assessment),`public.get_performance_review_operation(${q(actor===5?adminOperation:linkedAdminOperation)},null)`])reject(change+signed(actor,`select ${call};`,extra));
});

test('inactive, unlinked and disabled employee candidates disappear and reject fresh Admin mutations',()=>{
 for(const change of [
  `update public.internal_org_people set is_active=false where id=${q(person(2))};`,
  `update public.internal_org_people set auth_user_id=null where id=${q(person(2))};`,
  `update public.profiles set account_status='disabled' where id=${q(user(2))};`,
 ]){
  assert.ok(!json(change+signed(5,'select public.performance_review_workspace();')).at(-1).startablePeople.some(row=>row.id===person(2)));
  reject(change+signed(5,`select ${start(2)};`));reject(change+signed(5,`select ${mutate(adminReview,'read:1:0','save_manager',assessment)};`));
 }
});

test('table requires exactly one valid reviewer identity and no public table or helper grants',()=>{
 const columns=c.sql(db,"select attname||':'||attnotnull from pg_attribute where attrelid='private.performance_reviews'::regclass and attname in('assigned_manager_person_id','assigned_admin_user_id') order by attname;");
 assert.match(columns,/assigned_admin_user_id:false/);assert.match(columns,/assigned_manager_person_id:false/);
 for(const change of [`assigned_manager_person_id=null,assigned_admin_user_id=null`,`assigned_manager_person_id=${q(person(3))},assigned_admin_user_id=${q(user(5))}`])reject(`update private.performance_reviews set ${change} where id=${q(adminReview)};`,'23514');
 reject(`update private.performance_reviews set assigned_admin_user_id='a1000000-0000-4000-8000-999999999999' where id=${q(adminReview)};`,'23503');
 for(const role of ['anon','authenticated','service_role']){
  assert.equal(c.sql(db,`select has_function_privilege(${q(role)},${q(helper)},'EXECUTE');`).trim(),'f');
  for(const permission of ['SELECT','INSERT','UPDATE','DELETE'])assert.equal(c.sql(db,`select has_table_privilege(${q(role)},'private.performance_reviews',${q(permission)});`).trim(),'f');
 }
});

test('started notification still routes only to employee; linked Admin self-submission goes to current HR work email',()=>{
 const startPayload=rows(c.sql(db,`select private.performance_review_notification_payload(r,'started') from private.performance_reviews r where id=${q(linkedAdminReview)};`))[0];
 assert.equal(startPayload.recipient,'person1@mobilityaccess.com.au');assert.ok(!Object.hasOwn(startPayload,'selfAnswers'));
 const result=json(signed(1,`select ${mutate(linkedAdminReview,'self:0','submit_self',selfInput)};`)+`reset role;select private.performance_review_notification_payload(r,'self-submitted') from private.performance_reviews r where id=${q(linkedAdminReview)};`).at(-1);
 assert.equal(result.recipient,'person4@mobilityaccess.com.au');
 const updated=json(`update private.employee_directory_details set work_email='new.admin@equipsy.com.au' where person_id=${q(person(4))};`+signed(1,`select ${mutate(linkedAdminReview,'self:0','submit_self',selfInput)};`)+`reset role;select private.performance_review_notification_payload(r,'self-submitted') from private.performance_reviews r where id=${q(linkedAdminReview)};`).at(-1);
 assert.equal(updated.recipient,'new.admin@equipsy.com.au');
});

test('Admin notification routing rejects noncorporate, ambiguous and disabled reviewer contact',()=>{
 const submitted=signed(1,`select ${mutate(linkedAdminReview,'self:0','submit_self',selfInput)};`)+`reset role;`;
 for(const change of [
  `update private.employee_directory_details set work_email='not-corporate@example.test' where person_id=${q(person(4))};`,
  `update private.employee_directory_details set work_email='person4@mobilityaccess.com.au' where person_id=${q(person(3))};`,
  `update public.profiles set account_status='disabled' where id=${q(user(4))};`,
  `update public.profiles set app_role='employee' where id=${q(user(4))};`,
 ])assert.equal(c.sql(db,transaction(submitted+change+`select private.performance_review_notification_payload(r,'self-submitted') is null from private.performance_reviews r where id=${q(linkedAdminReview)};`)).trim().split('\n').at(-2),'t');
});

test('standalone P0 self-submission routes only to approved Careers regardless of login or user metadata',()=>{
 const payload=()=>`select private.performance_review_notification_payload(r,'self-submitted') from private.performance_reviews r where id=${q(adminReview)};`;
 assert.equal(rows(c.sql(db,payload()))[0].recipient,'careers@mobilityaccess.com.au');
 for(const login of ['opaque@portal.invalid','unrelated@example.test','people.admin@mobilityaccess.com.au']){
  const result=json(`update public.profiles set login_name=${q(login)} where id=${q(user(5))};${payload()}`).at(-1);
  assert.equal(result.recipient,'careers@mobilityaccess.com.au');
 }
});

test('standard manager notifications remain unchanged after Admin schema extension',()=>{
 const payload=rows(c.sql(db,`select private.performance_review_notification_payload(r,'self-submitted') from private.performance_reviews r where id=${q(nativeReview)};`))[0];
 assert.equal(payload.recipient,'person2@mobilityaccess.com.au');assert.equal(payload.managerName,'Synthetic person 2');
});

test('healthy catalog advances only by named delta while preexisting drift remains held',()=>{
 for(const drift of [false,true]){
  const database='mam_test_pr_admin_catalog_'+(drift?'hold':'healthy');predecessor(database);
  c.sql(database,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;');
  if(drift)c.sql(database,'grant select on public.profiles to authenticated;');
  const stored=c.sql(database,'select schema_hash from private.confirmed_test_purge_schema where singleton;');
  c.sql(database,source);
  assert.equal(c.sql(database,'select schema_hash=private.confirmed_test_purge_schema_hash() from private.confirmed_test_purge_schema where singleton;').trim(),drift?'f':'t');
  assert.equal(c.sql(database,'select schema_hash from private.confirmed_test_purge_schema where singleton;')===stored,drift);
 }
});

test('unrelated catalog/data drift inside migration rolls back the complete delta',()=>{
 for(const [label,injection] of [['grant','grant select on public.profiles to authenticated;'],['data',`update private.performance_reviews set cycle='2040';`]]){
  const database='mam_test_pr_admin_inject_'+label;predecessor(database);
  c.sql(database,`begin;${signed(2,`select ${start(1,'2031')};`)}commit;`);
  const result=c.run(database,source.replace('do $admin_catalog_after$',injection+'\ndo $admin_catalog_after$'));
  assert.notEqual(result.status,0);assert.match(result.stderr,/55000.*Performance Admin unrelated catalog or data delta/s);
  assert.equal(c.sql(database,"select exists(select 1 from pg_attribute where attrelid='private.performance_reviews'::regclass and attname='assigned_admin_user_id' and not attisdropped);").trim(),'f');
 }
});

test('source predecessor drift rejects before replacement',()=>{
 const database='mam_test_pr_admin_source_drift';predecessor(database);
 c.sql(database,"create or replace function private.performance_review_audience(p_review private.performance_reviews) returns text language sql volatile security definer set search_path='' as $$select 'admin'::text$$;");
 const result=c.run(database,source);assert.notEqual(result.status,0);assert.match(result.stderr,/55000.*Performance Admin function predecessor differs/s);
});

test('concurrent Admin saves serialize and one stale revision conflicts',async()=>{
 const runChild=sql=>{
  const child=spawn('psql',['-X','-h',c.socket,'-p',String(c.port),'-U','postgres','-d',db,'-At','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],{env,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.stdin.end(sql);
  return new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));});
 };
 const results=await Promise.all([4,5].map(actor=>runChild(`begin;${signed(actor,`select ${mutate(adminReview,'read:1:0','save_manager',assessment)};`)}commit;`)));
 assert.equal(results.filter(result=>result.code===0).length,1);assert.equal(results.filter(result=>result.code!==0&&result.stderr.includes('PT409')).length,1);
 assert.equal(c.sql(db,`select manager_version from private.performance_reviews where id=${q(adminReview)};`).trim(),'1');
});
