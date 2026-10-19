import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {ownedCluster,definition,rows,q,user,person} from './performance-review-production-harness.mjs';

const migration='supabase/migrations/20261019105639_performance_review_readonly_preview.sql';
const source=readFileSync(migration,'utf8');
const db='mam_test_pr_preview';
const apis=['public.performance_review_workspace_for_preview(uuid)','public.get_performance_review_document_for_preview(uuid,uuid)'];
const helpers=['private.performance_review_preview_actor(uuid)','private.performance_review_preview_audience(private.performance_reviews,uuid,text)','private.performance_review_preview_project(private.performance_reviews,uuid,text,uuid)'];
const claims=(i,extra={})=>q(JSON.stringify({sub:user(i),iat:1900000000,...extra}));
const signed=(i,sql,extra={})=>`set local role authenticated;select set_config('request.jwt.claims',${claims(i,extra)},true);${sql}`;
const workspace=i=>`public.performance_review_workspace_for_preview(${q(person(i))})`;
const normal=()=>`public.performance_review_workspace()`;
const document=(i,id)=>`public.get_performance_review_document_for_preview(${q(person(i))},${q(id)})`;
const transaction=sql=>`begin;${sql}rollback;`;
let c,normalBefore;
const reviews=new Map();
const json=sql=>rows(c.sql(db,transaction(sql)));
const preview=i=>json(signed(5,`select ${workspace(i)};`)).at(-1);
const reject=(sql,code='42501')=>{
 const result=c.run(db,transaction(sql));assert.notEqual(result.status,0);assert.match(result.stderr,new RegExp(`${code}.*`, 's'));
};
const ordinarySource=()=>c.sql(db,"select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='private' and p.proname in ('performance_review_actor','performance_review_candidate','performance_review_audience','performance_review_project','performance_review_document')) or (n.nspname='public' and p.proname in ('performance_review_workspace','start_performance_review','mutate_performance_review','get_performance_review_document','get_performance_review_operation','claim_performance_review_mail','begin_performance_review_mail','finish_performance_review_mail')) order by n.nspname,p.proname;");
const state=()=>c.sql(db,`select md5(jsonb_build_object(
 'people',(select jsonb_agg(to_jsonb(x) order by id) from public.internal_org_people x),
 'profiles',(select jsonb_agg(to_jsonb(x) order by id) from public.profiles x),
 'reviews',(select jsonb_agg(to_jsonb(x) order by id) from private.performance_reviews x),
 'events',(select jsonb_agg(to_jsonb(x) order by id) from private.performance_review_events x),
 'operations',(select jsonb_agg(to_jsonb(x) order by actor_user_id,operation_id) from private.performance_review_operations x),
 'careers',(select jsonb_agg(to_jsonb(x) order by delivery_id) from private.performance_review_mail_outbox x),
 'notifications',(select jsonb_agg(to_jsonb(x) order by delivery_id) from private.performance_review_notifications x),
 'receipts',(select jsonb_agg(to_jsonb(x) order by event_key) from private.notification_delivery_receipts x))::text);`);
function predecessor(database,notifications=true){
 c.setup(database);
 c.sql(database,readFileSync('supabase/migrations/20261017103000_performance_review_completion_guards.sql','utf8'));
 c.sql(database,definition('20261006104000_unified_portal_roles.sql','create or replace function private.is_system_portal_account_admin()'));
 c.sql(database,'revoke all on function private.is_system_portal_account_admin() from public,anon,authenticated,service_role;');
 c.sql(database,"alter table private.employee_directory_details add column work_email text; insert into private.employee_directory_details(person_id,work_email) select id,'person'||right(id::text,1)||'@example.test' from public.internal_org_people;");
 c.sql(database,readFileSync('supabase/migrations/20260923010000_durable_notification_delivery_receipts.sql','utf8'));
 c.sql(database,definition('20261014110000_subscription_review_managers_mail.sql','create or replace function private.notification_event_key_valid('));
 if(notifications)c.sql(database,readFileSync('supabase/migrations/20261019110000_performance_review_notifications.sql','utf8'));
}
before(()=>{
 const version=spawnSync('postgres',['--version'],{encoding:'utf8'});
 const major=Number(/PostgreSQL\) (\d+)\./.exec(version.stdout)?.[1]);assert.ok([16,17].includes(major));
 c=ownedCluster(major);predecessor(db);normalBefore=ordinarySource();c.sql(db,source);
 c.sql(db,`update public.internal_org_people set parent_id=${q(person(9))} where id=${q(person(3))};`);
 for(const [manager,employee] of [[2,1],[2,6],[9,2],[8,7],[9,3]]){
  const row=json(signed(manager,`select public.start_performance_review(${q(randomUUID())},${q(person(employee))},'2031','2031-12-31');`)).at(-1);
  c.sql(db,`begin;${signed(manager,`select public.start_performance_review(${q(randomUUID())},${q(person(employee))},'2031','2031-12-31');`)}commit;`);
  const id=rows(c.sql(db,`select row_to_json(x) from(select id from private.performance_reviews where employee_person_id=${q(person(employee))}) x;`))[0].id;
  reviews.set(employee,id);assert.equal(row.review.employee.id,person(employee));
 }
 const mutate=(i,revision,command,input)=>`begin;${signed(i,`select public.mutate_performance_review(${q(randomUUID())},${q(reviews.get(1))},${q(revision)},${q(command)},${q(JSON.stringify(input))}::jsonb);`)}commit;`;
 c.sql(db,mutate(1,'self:0','submit_self',{answers:Array(12).fill('Synthetic self answer')}));
 c.sql(db,mutate(2,'manager:1:0','complete_manager',{answers:Array(12).fill('Synthetic manager answer'),ratings:Array(12).fill('2 Meets expectations'),summary:'Synthetic summary',overallRating:'2 Meets expectations',managerNote:'PRIVATE-SYNTHETIC-NOTE'}));
 c.sql(db,mutate(2,'manager:1:1','submit_review',{date:'2026-01-02',time:'10:00',duration:30,mode:'in_person',location:'Synthetic room',notes:'Synthetic meeting',held:true}));
 c.sql(db,`insert into private.performance_review_events(review_id,subject_person_id,actor_user_id,kind,at) values
 (${q(reviews.get(1))},${q(person(1))},${q(user(5))},'save_self','2000-01-01'),
 (${q(reviews.get(1))},${q(person(1))},${q(user(3))},'save_self','2001-01-01');`);
});
after(()=>c?.stop());

test('preview migration preserves every existing normal Performance and Careers function',()=>assert.equal(ordinarySource(),normalBefore));

test('employee and Account previews are target-owned, private-field-free and immutable',()=>{
 for(const employee of [1,6]){
  const result=preview(employee);assert.equal(result.viewerContext.actorUserId,user(5));assert.equal(result.viewerContext.personId,person(employee));
  assert.equal(result.viewerContext.role,employee===6?'account':'employee');assert.equal(result.viewerContext.displayName,`Synthetic person ${employee}`);
  assert.deepEqual(result.startablePeople,[]);assert.equal(result.reviews.length,1);
  const row=result.reviews[0];assert.equal(row.employee.id,person(employee));assert.equal(row.audience,'employee');
  assert.deepEqual(row.capabilities,{saveSelf:false,submitSelf:false,downloadDocument:true});
  for(const key of ['managerNote','managerAnswers','managerActivity','managerRevision','readRevision','ratings','summary','overallRating','meeting','managerCompletedAt','finalisedAt'])assert.ok(!Object.hasOwn(row,key),key);
  assert.doesNotMatch(JSON.stringify(row),/PRIVATE-SYNTHETIC|2000-01-01|2001-01-01/);
  const native=json(signed(employee,`select ${normal()};`)).at(-1);
  assert.deepEqual(row,{...native.reviews[0],capabilities:{...native.reviews[0].capabilities,saveSelf:false,submitSelf:false}});
 }
});

test('all Manager previews match native assigned scope, own self scope and current candidates',()=>{
 for(const manager of [2,3,8,9]){
  const result=preview(manager),native=json(signed(manager,`select ${normal()};`)).at(-1);
  assert.deepEqual(result.startablePeople,native.startablePeople);
  assert.deepEqual(result.reviews,native.reviews.map(row=>({...row,capabilities:Object.fromEntries(Object.entries(row.capabilities).map(([key])=>[key,key==='downloadDocument']))})));
  for(const row of result.reviews){assert.equal(row.audience,row.employee.id===person(manager)?'employee':'manager');assert.ok(row.employee.id===person(manager)||row.manager.id===person(manager));}
 }
 const result=preview(2);assert.equal(result.reviews.length,3);assert.equal(result.startablePeople.length,2);
 assert.ok(result.reviews.some(row=>row.employee.id===person(2)&&row.audience==='employee'));
 assert.ok(!result.reviews.some(row=>row.employee.id===person(7)||row.employee.id===person(3)));
});

test('Admin preview retains the native global overview with all write capabilities false',()=>{
 const result=preview(4),native=json(signed(4,`select ${normal()};`)).at(-1);
 assert.equal(result.reviews.length,5);assert.deepEqual(result.startablePeople,[]);
 assert.deepEqual(result.reviews,native.reviews);
 for(const row of result.reviews)for(const [key,value] of Object.entries(row.capabilities))assert.equal(value,key==='downloadDocument');
});

test('dedicated document preview binds target and review and never adds the private note',()=>{
 for(const target of [1,2,4,6,8,9]){
  const id=reviews.get(target===6?6:target===8?7:target===9?2:1);
  const actual=json(signed(5,`select ${document(target,id)};`)).at(-1);
  const native=json(signed(target,`select public.get_performance_review_document(${q(id)});`)).at(-1);
  assert.deepEqual(actual,native);assert.ok(!Object.hasOwn(actual,'managerNote'));
  if(target===1)for(const key of ['managerAnswers','ratings','summary','overallRating','meeting'])assert.ok(!Object.hasOwn(actual,key));
 }
 for(const [target,employee] of [[1,6],[6,1],[2,7],[3,1],[8,1]])reject(signed(5,`select ${document(target,reviews.get(employee))};`));
 for(const id of [null,'c9999999-0000-4000-8000-000000000001'])reject(signed(5,`select ${document(1,id)};`));
});

test('preview reads succeed in READ ONLY transactions without business, audit or outbox changes',()=>{
 const before=state();
 for(const target of [1,2,3,4,6,7,8,9])c.sql(db,`begin read only;${signed(5,`select ${workspace(target)};`)}rollback;`);
 for(const target of [1,2,4])c.sql(db,`begin read only;${signed(5,`select ${document(target,reviews.get(1))};`)}rollback;`);
 assert.equal(state(),before);
});

test('preview does not impersonate its target or enable the actual P0 write RPCs',()=>{
 const native=json(signed(5,`select ${workspace(2)};select ${normal()};`)).at(-1);
 assert.equal(native.viewerContext.actorUserId,user(5));assert.equal(native.viewerContext.role,'system_admin');
 reject(signed(5,`select ${workspace(2)};select public.start_performance_review(${q(randomUUID())},${q(person(1))},'2032','2032-12-31');`));
 reject(signed(5,`select ${workspace(1)};select public.mutate_performance_review(${q(randomUUID())},${q(reviews.get(1))},'self:1','save_self',${q(JSON.stringify({answers:Array(12).fill('Synthetic prohibited write')}))}::jsonb);`));
});

for(const actor of [1,2,3,4,6,7,8,9])test(`ordinary actor ${actor} cannot use either P0 preview RPC despite claimed metadata`,()=>{
 const extra={role:'system_admin',app_metadata:{app_role:'system_admin'}};
 reject(signed(actor,`select ${workspace(1)};`,extra));reject(signed(actor,`select ${document(1,reviews.get(1))};`,extra));
});

for(const [label,change,extra] of [
 ['stale P0 session','',{iat:1}],['anonymous P0','',{is_anonymous:true}],
 ['disabled P0',`update public.profiles set account_status='disabled' where id=${q(user(5))};`,{}],
 ['missing P0 login',`update public.profiles set login_name=null where id=${q(user(5))};`,{}],
 ['demoted P0',`update public.profiles set app_role='admin' where id=${q(user(5))};`,{}],
])test(`${label} is freshly rejected by workspace and document`,()=>{
 reject(change+signed(5,`select ${workspace(1)};`,extra));reject(change+signed(5,`select ${document(1,reviews.get(1))};`,extra));
});

test('missing authenticated identity and invalid target never fall back to the P0 global workspace',()=>{
 reject("set local role authenticated;select set_config('request.jwt.claims','{}',true);select "+workspace(1)+';');
 for(const target of [null,person(5),'b9999999-0000-4000-8000-000000000001']){
  reject(signed(5,`select public.performance_review_workspace_for_preview(${q(target)});`));
  reject(signed(5,`select public.get_performance_review_document_for_preview(${q(target)},${q(reviews.get(1))});`));
 }
});

for(const [label,change] of [
 ['unlinked',`update public.internal_org_people set auth_user_id=null where id=${q(person(1))};`],
 ['inactive person',`update public.internal_org_people set is_active=false where id=${q(person(1))};`],
 ['org-unit target',`update public.internal_org_people set node_kind='org_unit' where id=${q(person(1))};`],
 ['disabled account',`update public.profiles set account_status='disabled' where id=${q(user(1))};`],
 ['archived account',`update public.profiles set account_status='archived' where id=${q(user(1))};`],
 ['missing login',`update public.profiles set login_name=null where id=${q(user(1))};`],
 ['legacy role',`update public.profiles set app_role='hr' where id=${q(user(1))};`],
 ['missing profile',`delete from public.profiles where id=${q(user(1))};`],
 ['duplicate person link',`alter table public.internal_org_people drop constraint internal_org_people_auth_user_id_key;update public.internal_org_people set auth_user_id=${q(user(1))} where id=${q(person(3))};`],
])test(`${label} target is rejected by both APIs`,()=>{
 reject(change+signed(5,`select ${workspace(1)};`));reject(change+signed(5,`select ${document(1,reviews.get(1))};`));
});

test('role and reporting changes are recalculated without transferring assigned history',()=>{
 const result=json(`update public.profiles set app_role='employee' where id=${q(user(2))};`+signed(5,`select ${workspace(2)};`)).at(-1);
 assert.equal(result.viewerContext.role,'employee');assert.deepEqual(result.startablePeople,[]);assert.equal(result.reviews.length,1);assert.equal(result.reviews[0].employee.id,person(2));
 const moved=json(`update public.internal_org_people set parent_id=${q(person(3))} where id=${q(person(1))};`+signed(5,`select ${workspace(2)};select ${workspace(3)};`)).slice(-2);
 assert.ok(moved[0].reviews.some(row=>row.id===reviews.get(1)));assert.ok(!moved[0].startablePeople.some(row=>row.id===person(1)));
 assert.ok(!moved[1].reviews.some(row=>row.id===reviews.get(1)));assert.ok(moved[1].startablePeople.some(row=>row.id===person(1)));
 for(const change of [`update public.internal_org_people set company_key='equipsy' where id=${q(person(1))};`,`update public.internal_org_people set is_active=false where id=${q(person(1))};`]){
  const result=json(change+signed(5,`select ${workspace(2)};`)).at(-1);assert.ok(!result.reviews.some(row=>row.id===reviews.get(1)));
  reject(change+signed(5,`select ${document(2,reviews.get(1))};`));
 }
});

test('effective ACLs expose only the two authenticated APIs and no private helpers or tables',()=>{
 for(const role of ['anon','authenticated','service_role'])for(const signature of [...apis,...helpers]){
  const allowed=c.sql(db,`select has_function_privilege(${q(role)},${q(signature)},'EXECUTE');`).trim();assert.equal(allowed,role==='authenticated'&&apis.includes(signature)?'t':'f',`${role} ${signature}`);
 }
 const metadata=rows(c.sql(db,`select jsonb_build_object('definer',bool_and(prosecdef),'stable',bool_and(provolatile='s'),'path',bool_and(proconfig=array['search_path=""'])) from pg_proc where oid in(${[...apis,...helpers].map(s=>q(s)+'::regprocedure').join(',')});`))[0];
 assert.deepEqual(metadata,{definer:true,stable:true,path:true});
 for(const role of ['anon','service_role'])reject(`set local role ${role};select ${workspace(1)};`);
 reject(signed(5,`select * from private.performance_review_preview_actor(${q(person(1))});`));
 for(const role of ['anon','authenticated','service_role'])assert.equal(c.sql(db,`select has_table_privilege(${q(role)},'private.performance_reviews','SELECT,INSERT,UPDATE,DELETE');`).trim(),'f');
});

test('healthy catalog baseline advances only for the five new preview functions',()=>{
 const database='mam_test_pr_preview_healthy';predecessor(database);
 c.sql(database,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;');
 const before=c.sql(database,'select schema_hash from private.confirmed_test_purge_schema;');c.sql(database,source);
 assert.equal(c.sql(database,'select schema_hash=private.confirmed_test_purge_schema_hash() from private.confirmed_test_purge_schema;').trim(),'t');
 assert.notEqual(c.sql(database,'select schema_hash from private.confirmed_test_purge_schema;'),before);
});

test('existing unrelated catalog HOLD is preserved and concurrent unrelated delta rolls back',()=>{
 const database='mam_test_pr_preview_hold';predecessor(database);
 c.sql(database,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;grant select on public.profiles to authenticated;');
 const before=c.sql(database,'select schema_hash from private.confirmed_test_purge_schema;');c.sql(database,source);
 assert.equal(c.sql(database,'select schema_hash from private.confirmed_test_purge_schema;'),before);
 assert.equal(c.sql(database,'select schema_hash=private.confirmed_test_purge_schema_hash() from private.confirmed_test_purge_schema;').trim(),'f');
 const delta='mam_test_pr_preview_delta';predecessor(delta);
 const denied=c.run(delta,source.replace('do $preview_catalog_after$','grant select on public.profiles to authenticated;\ndo $preview_catalog_after$'));
 assert.notEqual(denied.status,0);assert.match(denied.stderr,/55000.*Performance preview unrelated catalog delta/s);
 assert.equal(c.sql(delta,"select to_regprocedure('public.performance_review_workspace_for_preview(uuid)') is null;").trim(),'t');
 assert.equal(c.sql(delta,"select has_table_privilege('authenticated','public.profiles','SELECT');").trim(),'f');
});

test('CLI-generated migration order also accepts preview before independent notification migration',()=>{
 const database='mam_test_pr_preview_order';predecessor(database,false);c.sql(database,source);
 c.sql(database,readFileSync('supabase/migrations/20261019110000_performance_review_notifications.sql','utf8'));
 assert.equal(c.sql(database,"select to_regprocedure('public.performance_review_workspace_for_preview(uuid)') is not null and to_regclass('private.performance_review_notifications') is not null;").trim(),'t');
});
