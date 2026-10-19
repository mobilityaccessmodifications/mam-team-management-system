import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {ownedCluster,definition,rows,q,user,person,env} from './performance-review-production-harness.mjs';
import {randomUUID} from 'node:crypto';

const migration='supabase/migrations/20261019211233_performance_review_p0_manager_delegation.sql';
const source=readFileSync(migration,'utf8');
const db='mam_test_pr_delegate';
const apis=['public.performance_review_workspace_for_delegate(uuid)','public.start_performance_review_for_delegate(uuid,uuid,uuid,text,text)','public.mutate_performance_review_for_delegate(uuid,uuid,uuid,text,text,jsonb)','public.get_performance_review_operation_for_delegate(uuid,uuid,uuid)'];
const helper='private.performance_review_delegate_project(private.performance_reviews,uuid,uuid)';
const signed=(i,sql,extra={})=>`set local role authenticated;select set_config('request.jwt.claims',${q(JSON.stringify({sub:user(i),iat:1900000000,...extra}))},true);${sql}`;
const workspace=(target=2)=>`public.performance_review_workspace_for_delegate(${q(person(target))})`;
const start=(target=2,operation=randomUUID(),employee=1,cycle='2032',due='2032-12-31')=>`public.start_performance_review_for_delegate(${q(person(target))},${q(operation)},${q(person(employee))},${q(cycle)},${q(due)})`;
const mutate=(target,id,revision,command,input,operation=randomUUID())=>`public.mutate_performance_review_for_delegate(${q(person(target))},${q(operation)},${q(id)},${q(revision)},${q(command)},${q(JSON.stringify(input))}::jsonb)`;
const operation=(target,op,id=null)=>`public.get_performance_review_operation_for_delegate(${q(person(target))},${q(op)},${q(id)})`;
const assessment={answers:Array(12).fill('Synthetic manager answer'),ratings:Array(12).fill('2 Meets expectations'),summary:'Synthetic summary',overallRating:'2 Meets expectations',managerNote:'SYNTHETIC-PRIVATE-NOTE'};
const meeting={date:'2026-01-02',time:'10:00',duration:30,mode:'in_person',location:'Synthetic room',notes:'Synthetic meeting',held:true};
let c,beforeFunctions,review,selfReview,foreignReview,delegateReview,delegateOperation;
const transaction=sql=>`begin;${sql}rollback;`;
const json=sql=>rows(c.sql(db,transaction(sql))).filter(row=>!Object.hasOwn(row,'sub'));
const run=sql=>rows(c.sql(db,`begin;${sql}commit;`)).filter(row=>!Object.hasOwn(row,'sub'));
const reject=(sql,code='42501')=>{const r=c.run(db,transaction(sql));assert.notEqual(r.status,0);assert.match(r.stderr,new RegExp(`${code}.*`,'s'));return r;};
const preserve=()=>c.sql(db,`select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('private','public') and p.prokind='f' and not exists(select 1 from unnest(array[${[...apis,helper].map(q).join(',')}]) signature where to_regprocedure(signature)=p.oid) order by n.nspname,p.proname,p.oid;`);
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
 c.sql(database,"alter table private.employee_directory_details add column work_email text;insert into private.employee_directory_details(person_id,work_email) select id,'person'||right(id::text,1)||'@example.test' from public.internal_org_people;");
 c.sql(database,readFileSync('supabase/migrations/20260923010000_durable_notification_delivery_receipts.sql','utf8'));
 c.sql(database,definition('20261014110000_subscription_review_managers_mail.sql','create or replace function private.notification_event_key_valid('));
 c.sql(database,readFileSync('supabase/migrations/20261019105639_performance_review_readonly_preview.sql','utf8'));
 c.sql(database,readFileSync('supabase/migrations/20261019110000_performance_review_notifications.sql','utf8'));
}
before(()=>{
 c=ownedCluster(17);predecessor(db);beforeFunctions=preserve();c.sql(db,source);
 const nativeStart=(manager,employee,cycle='2031')=>run(signed(manager,`select public.start_performance_review(${q(randomUUID())},${q(person(employee))},${q(cycle)},'2031-12-31');`)).at(-1).review.id;
 review=nativeStart(2,1);selfReview=nativeStart(9,2);foreignReview=nativeStart(8,7);
 run(signed(1,`select public.mutate_performance_review(${q(randomUUID())},${q(review)},'self:0','submit_self',${q(JSON.stringify({answers:Array(12).fill('Synthetic self answer')}))}::jsonb);`));
 delegateOperation=randomUUID();delegateReview=run(signed(5,`select ${start(2,delegateOperation)};`)).at(-1).review.id;
});
after(()=>c?.stop());

test('migration preserves all native, readonly preview, notification and Careers routines',()=>assert.equal(preserve(),beforeFunctions));

test('P0 Manager workspace matches native assigned capabilities and candidates while own self remains readonly',()=>{
 const result=json(signed(5,`select ${workspace()};`)).at(-1);
 const native=json(signed(2,'select public.performance_review_workspace();')).at(-1);
 assert.deepEqual(result.viewerContext,{...native.viewerContext,actorUserId:user(5)});
 assert.deepEqual(result.startablePeople,native.startablePeople);
 assert.deepEqual(result.reviews,native.reviews.map(row=>row.audience==='employee'?{...row,capabilities:{saveSelf:false,submitSelf:false,downloadDocument:true}}:row));
 assert.ok(result.reviews.some(row=>row.id===review&&row.capabilities.saveManager));
 assert.ok(result.reviews.some(row=>row.id===selfReview&&!row.capabilities.saveSelf));
 assert.ok(!result.reviews.some(row=>row.id===foreignReview));
});

test('readonly preview API stays readonly for Manager and other roles after delegation migration',()=>{
 for(const target of [1,2,4,6])for(const row of json(signed(5,`select public.performance_review_workspace_for_preview(${q(person(target))});`)).at(-1).reviews){
  for(const [key,value] of Object.entries(row.capabilities))assert.equal(value,key==='downloadDocument');
 }
});

test('delegate start stores selected Manager identity and real P0 audit, including target-bound operation body',()=>{
 const meta=rows(c.sql(db,`select jsonb_build_object('manager',r.assigned_manager_person_id,'identity',r.manager_identity,'actor',e.actor_user_id,'subject',e.subject_person_id,'body',o.body,'opActor',o.actor_user_id) from private.performance_reviews r join private.performance_review_events e on e.review_id=r.id and e.kind='start' join private.performance_review_operations o on o.review_id=r.id where r.id=${q(delegateReview)};`))[0];
 assert.equal(meta.manager,person(2));assert.deepEqual(meta.identity,{id:person(2),name:'Synthetic person 2'});
 assert.equal(meta.actor,user(5));assert.equal(meta.opActor,user(5));assert.equal(meta.subject,person(1));assert.equal(meta.body.delegatePersonId,person(2));
 assert.equal(c.sql(db,`select count(*) from private.performance_review_notifications where review_id=${q(delegateReview)} and event='started';`).trim(),'1');
 assert.equal(c.sql(db,`select count(*) from private.performance_review_mail_outbox where review_id=${q(delegateReview)};`).trim(),'0');
});

test('delegate start retry returns exact receipt without duplicate audit or employee notification',()=>{
 const before=state();const result=run(signed(5,`select ${start(2,delegateOperation)};`)).at(-1);
 assert.equal(result.review.id,delegateReview);assert.equal(result.existing,false);assert.equal(state(),before);
 const next=json(signed(5,`select ${start()};`)).at(-1);assert.equal(next.existing,true);assert.equal(next.review.id,delegateReview);
});

test('start operation collision includes target, cycle, due date and native-versus-delegate identity',()=>{
 for(const call of [start(8,delegateOperation,7),start(2,delegateOperation,1,'2033'),start(2,delegateOperation,1,'2032','2032-12-30')])reject(signed(5,`select ${call};`),'PT409');
 reject(`update public.profiles set app_role='manager' where id=${q(user(5))};`+signed(5,`select ${start()};`));
});

test('all four delegated manager commands preserve native state machine and final mail behavior',()=>{
 const op=randomUUID();
 const result=json(signed(5,`select ${mutate(2,review,'manager:1:0','save_manager',assessment,op)};select ${mutate(2,review,'manager:1:0','save_manager',assessment,op)};select ${mutate(2,review,'manager:1:1','complete_manager',assessment)};select ${mutate(2,review,'manager:1:2','save_meeting',Object.fromEntries(Object.entries(meeting).filter(([key])=>key!=='held')))};select ${mutate(2,review,'manager:1:3','submit_review',meeting)};`)+`reset role;select jsonb_build_object('events',(select jsonb_agg(jsonb_build_object('actor',actor_user_id,'kind',kind)) from private.performance_review_events where review_id=${q(review)} and kind in('save_manager','complete_manager','save_meeting','submit_review')),'outbox',(select count(*) from private.performance_review_mail_outbox where review_id=${q(review)}),'ops',(select count(*) from private.performance_review_operations where review_id=${q(review)} and actor_user_id=${q(user(5))}),'document',(select final_document from private.performance_reviews where id=${q(review)}));`);
 const final=result.at(-2).review,meta=result.at(-1);assert.ok(final.finalisedAt);assert.equal(meta.outbox,1);assert.equal(meta.ops,4);
 assert.equal(meta.events.length,4);assert.ok(meta.events.every(event=>event.actor===user(5)));
 assert.equal(meta.document.employee.id,person(1));assert.equal(meta.document.manager.id,person(2));assert.ok(!Object.hasOwn(meta.document,'managerNote'));
 assert.ok(Object.entries(final.capabilities).every(([key,value])=>value===(key==='downloadDocument')));
 assert.deepEqual(result[0],result[1]);
});

for(const command of ['save_self','submit_self'])test(`delegate cannot ${command}, including Manager's own self assessment`,()=>{
 for(const id of [review,selfReview])reject(signed(5,`select ${mutate(2,id,'self:0',command,{answers:Array(12).fill('Synthetic prohibited')})};`),'22023');
});

test('delegate manager writes enforce assigned scope and block foreign and own-self reviews',()=>{
 for(const [target,id] of [[2,foreignReview],[3,review],[2,selfReview]])reject(signed(5,`select ${mutate(target,id,'manager:1:0','save_manager',assessment)};`));
 reject(signed(5,`select ${mutate(2,delegateReview,'manager:0:0','save_manager',assessment)};`),'PT409');
 reject(signed(5,`select ${mutate(2,review,'manager:1:1','save_manager',assessment)};`),'PT409');
});

test('manager operation retry is idempotent while changed input and target collide or deny',()=>{
 const op=randomUUID();const sql=signed(5,`select ${mutate(2,review,'manager:1:0','save_manager',assessment,op)};`);
 const result=json(sql+`select ${mutate(2,review,'manager:1:0','save_manager',assessment,op)};`);assert.deepEqual(result[0],result[1]);
 reject(sql+`select ${mutate(2,review,'manager:1:0','save_manager',{...assessment,summary:'Changed synthetic'},op)};`,'PT409');
 reject(sql+`select ${mutate(8,foreignReview,'manager:0:0','save_manager',assessment,op)};`,'PT409');
});

test('completion retains required assessment, XML-safe text, meeting-ended and attachment guards',()=>{
 const prefix=signed(5,`select ${mutate(2,review,'manager:1:0','complete_manager',assessment)};`);
 reject(signed(5,`select ${mutate(2,review,'manager:1:0','complete_manager',{...assessment,summary:''})};`),'22023');
 reject(signed(5,`select ${mutate(2,review,'manager:1:0','save_manager',{...assessment,summary:'bad\u0001xml'})};`),'22023');
 reject(prefix+`select ${mutate(2,review,'manager:1:1','submit_review',{...meeting,date:'2099-01-02'})};`,'22023');
 reject(prefix+`select ${mutate(2,review,'manager:1:1','submit_review',{...meeting,held:false})};`,'22023');
 reject(signed(5,`select ${mutate(2,review,'manager:1:0','submit_review',meeting)};`),'22023');
 const giant={...assessment,answers:Array(12).fill('\n'.repeat(7999)+'x')};
 assert.match(reject(signed(5,`select ${mutate(2,review,'manager:1:0','complete_manager',giant)};select ${mutate(2,review,'manager:1:1','submit_review',meeting)};`),'22023').stderr,/Review attachment exceeds the supported size/);
});

test('operation reconciliation returns current delegated projection and rejects another target or review',()=>{
 const result=json(signed(5,`select ${operation(2,delegateOperation)};`)).at(-1);
 assert.equal(result.status,'committed');assert.equal(result.review.id,delegateReview);
 assert.deepEqual(json(signed(5,`select ${operation(2,randomUUID())};`)).at(-1),{status:'not_found',review:null});
 reject(signed(5,`select ${operation(3,delegateOperation)};`));reject(signed(5,`select ${operation(2,delegateOperation,review)};`));
 const native=rows(c.sql(db,`select row_to_json(x) from(select operation_id from private.performance_review_operations where actor_user_id=${q(user(2))} limit 1)x;`))[0].operation_id;
 assert.deepEqual(json(signed(5,`select ${operation(2,native)};`)).at(-1),{status:'not_found',review:null});
 reject(signed(5,`select ${operation(2,null)};`),'22023');
});

test('workspace and operation reads succeed in READ ONLY with no audit, business or notification writes',()=>{
 const before=state();c.sql(db,`begin read only;${signed(5,`select ${workspace()};select ${operation(2,delegateOperation)};`)}rollback;`);assert.equal(state(),before);
});

for(const actor of [1,2,3,4,6,7,8,9])test(`ordinary actor ${actor} cannot use any delegated API even with claimed P0 metadata`,()=>{
 for(const call of [workspace(),start(),mutate(2,review,'manager:1:0','save_manager',assessment),operation(2,delegateOperation)])reject(signed(actor,`select ${call};`,{role:'system_admin',app_metadata:{app_role:'system_admin'}}));
});

for(const target of [1,4,6])test(`non-Manager target ${target} cannot receive delegate authority`,()=>{
 for(const call of [workspace(target),start(target),mutate(target,review,'manager:1:0','save_manager',assessment),operation(target,delegateOperation)])reject(signed(5,`select ${call};`));
});

for(const [label,change,extra] of [
 ['stale P0 session','',{iat:1}],['anonymous P0 session','',{is_anonymous:true}],
 ['disabled P0',`update public.profiles set account_status='disabled' where id=${q(user(5))};`,{}],
 ['demoted P0',`update public.profiles set app_role='admin' where id=${q(user(5))};`,{}],
 ['P0 without login',`update public.profiles set login_name=null where id=${q(user(5))};`,{}],
 ['demoted Manager',`update public.profiles set app_role='employee' where id=${q(user(2))};`,{}],
 ['disabled Manager',`update public.profiles set account_status='disabled' where id=${q(user(2))};`,{}],
 ['unlinked Manager',`update public.internal_org_people set auth_user_id=null where id=${q(person(2))};`,{}],
 ['inactive Manager',`update public.internal_org_people set is_active=false where id=${q(person(2))};`,{}],
])test(`${label} is rejected on reads, writes and retry receipts`,()=>{
 for(const call of [workspace(),start(2,delegateOperation),mutate(2,review,'manager:1:0','save_manager',assessment),operation(2,delegateOperation)])reject(change+signed(5,`select ${call};`,extra));
});

test('employee eligibility changes remove assigned scope; reporting move only changes new candidates',()=>{
 for(const change of [`update public.internal_org_people set company_key='equipsy' where id=${q(person(1))};`,`update public.internal_org_people set is_active=false where id=${q(person(1))};`,`update public.profiles set account_status='disabled' where id=${q(user(1))};`,`update public.profiles set app_role='admin' where id=${q(user(1))};`]){
  reject(change+signed(5,`select ${mutate(2,review,'manager:1:0','save_manager',assessment)};`));reject(change+signed(5,`select ${operation(2,delegateOperation)};`));
 }
 const changed=`update public.internal_org_people set parent_id=${q(person(3))} where id=${q(person(1))};`;
 const view=json(changed+signed(5,`select ${workspace()};`)).at(-1);assert.ok(view.reviews.some(row=>row.id===review));assert.ok(!view.startablePeople.some(row=>row.id===person(1)));
 reject(changed+signed(5,`select ${start(2,delegateOperation)};`));
 assert.equal(json(changed+signed(5,`select ${mutate(2,review,'manager:1:0','save_manager',assessment)};`)).at(-1).committed,true);
});

test('effective ACLs expose four authenticated APIs and no private helper or review table access',()=>{
 for(const role of ['anon','authenticated','service_role'])for(const signature of [...apis,helper])assert.equal(c.sql(db,`select has_function_privilege(${q(role)},${q(signature)},'EXECUTE');`).trim(),role==='authenticated'&&apis.includes(signature)?'t':'f',`${role}: ${signature}`);
 const meta=rows(c.sql(db,`select jsonb_build_object('definer',bool_and(prosecdef),'path',bool_and(proconfig=array['search_path=""'])) from pg_proc where oid in(${[...apis,helper].map(s=>q(s)+'::regprocedure').join(',')});`))[0];
 assert.deepEqual(meta,{definer:true,path:true});
 for(const signature of [apis[0],apis[3],helper])assert.equal(c.sql(db,`select provolatile from pg_proc where oid=${q(signature)}::regprocedure;`).trim(),'s');
 for(const signature of [apis[1],apis[2]])assert.equal(c.sql(db,`select provolatile from pg_proc where oid=${q(signature)}::regprocedure;`).trim(),'v');
 for(const role of ['anon','authenticated','service_role'])assert.equal(c.sql(db,`select has_table_privilege(${q(role)},'private.performance_reviews','SELECT,INSERT,UPDATE,DELETE');`).trim(),'f');
 for(const role of ['anon','service_role'])reject(`set local role ${role};select ${workspace()};`);
});

test('healthy purge baseline advances only for five new functions; pre-existing HOLD remains untouched',()=>{
 for(const held of [false,true]){
  const database=`mam_test_pr_delegate_${held?'hold':'healthy'}`;predecessor(database);
  c.sql(database,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;'+(held?'grant select on public.profiles to authenticated;':''));
  const before=c.sql(database,'select schema_hash from private.confirmed_test_purge_schema;');c.sql(database,source);
  assert.equal(c.sql(database,'select schema_hash=private.confirmed_test_purge_schema_hash() from private.confirmed_test_purge_schema;').trim(),held?'f':'t');
  if(held)assert.equal(c.sql(database,'select schema_hash from private.confirmed_test_purge_schema;'),before);else assert.notEqual(c.sql(database,'select schema_hash from private.confirmed_test_purge_schema;'),before);
 }
});

test('unrelated ACL delta during migration is detected and rolled back',()=>{
 const database='mam_test_pr_delegate_delta';predecessor(database);
 const result=c.run(database,source.replace('do $delegate_catalog_after$','grant select on public.profiles to authenticated;\ndo $delegate_catalog_after$'));
 assert.notEqual(result.status,0);assert.match(result.stderr,/55000.*Performance delegate unrelated catalog delta/s);
 assert.equal(c.sql(database,"select to_regprocedure('public.performance_review_workspace_for_delegate(uuid)') is null;").trim(),'t');
 assert.equal(c.sql(database,"select has_table_privilege('authenticated','public.profiles','SELECT');").trim(),'f');
});

function connection(){
 const child=spawn('psql',['-X','-h',c.socket,'-p',String(c.port),'-U','postgres','-d',db,'-At','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-f','-'],{env,stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
 const closed=new Promise(resolve=>child.on('close',exit=>resolve({exit,stdout,stderr})));
 return {child,closed,get stdout(){return stdout;}};
}
async function barrier(predicate){const until=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<until,'Delegation native barrier timed out');await new Promise(resolve=>setTimeout(resolve,15));}}
for(const [label,change,restore,call] of [
 ['Manager demotion while retry waits',()=>`update public.profiles set app_role='employee' where id=${q(user(2))};`,()=>`update public.profiles set app_role='manager' where id=${q(user(2))};`,()=>start(2,delegateOperation)],
 ['P0 disable while manager mutation waits',()=>`update public.profiles set account_status='disabled' where id=${q(user(5))};`,()=>`update public.profiles set account_status='active' where id=${q(user(5))};`,()=>mutate(2,review,'manager:1:0','save_manager',assessment)],
])test(`${label} is revalidated after canonical role lock before any business write`,async()=>{
 let holder,queued;const before=state();
 try{
  holder=connection();queued=connection();
  holder.child.stdin.write(`begin;select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));${change()}select 'delegate-holder-ready';\n`);
  await barrier(()=>holder.stdout.includes('delegate-holder-ready'));
  queued.child.stdin.end(`set application_name='delegate-owned-queued';begin;${signed(5,`select ${call()};`)}commit;`);
  await barrier(()=>c.sql(db,"select exists(select 1 from pg_stat_activity where datname=current_database() and application_name='delegate-owned-queued' and wait_event_type='Lock' and wait_event='advisory');").trim()==='t');
  holder.child.stdin.end('commit;\n');assert.equal((await holder.closed).exit,0);
  const result=await queued.closed;assert.equal(result.exit,3,result.stderr);assert.match(result.stderr,/42501/);
 }finally{
  if(holder?.child.stdin.writable)holder.child.stdin.end('rollback;\n');
  if(queued?.child.stdin.writable)queued.child.stdin.end('rollback;\n');
  await Promise.all([holder?.closed,queued?.closed]);c.sql(db,restore());
 }
 assert.equal(state(),before);
});
