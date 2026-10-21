import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {ownedCluster,definition,rows,q,user,person,actor,env} from './performance-review-production-harness.mjs';
import {buildReviewDocx} from '../src/lib/performance-review-word.mjs';
import {QUESTIONS} from '../src/lib/performance-review-questions.mjs';

const migration='supabase/migrations/20261021041145_performance_review_goals_final_recipients.sql';
const source=readFileSync(migration,'utf8'),db='mam_test_pr_goals_final';
const major=Number(process.env.MAM_PERFORMANCE_GOALS_TEST_PG_MAJOR??'17');
const id='c7000000-0000-4000-8000-000000000001';
const goal={priority:'Synthetic agreed goal',measureOfSuccess:'Synthetic measure',supportAndResponsiblePerson:'Synthetic owner and support',dueDate:'2027-04-30',progressCheck:'Synthetic monthly progress check'};
const assessment={answers:Array(12).fill('Synthetic manager evidence'),ratings:Array(12).fill('2 Meets expectations'),summary:'Synthetic summary',overallRating:'2 Meets expectations',managerNote:'PRIVATE-SYNTHETIC-NOTE'};
const meeting={date:'2026-01-02',time:'10:00',duration:30,mode:'in_person',location:'Boardroom',notes:'Synthetic meeting notes',held:true};
const mutate=(review,revision,command,input,operation=randomUUID())=>`select public.mutate_performance_review(${q(operation)},${q(review)},${q(revision)},${q(command)},${q(JSON.stringify(input))}::jsonb);`;
const delegated=(review,revision,command,input,operation=randomUUID())=>`select public.mutate_performance_review_for_delegate(${q(person(2))},${q(operation)},${q(review)},${q(revision)},${q(command)},${q(JSON.stringify(input))}::jsonb);`;
let c;
function predecessor(database){
 c.setup(database);c.sql(database,readFileSync('supabase/migrations/20261017103000_performance_review_completion_guards.sql','utf8'));
 c.sql(database,definition('20261006104000_unified_portal_roles.sql','create or replace function private.is_system_portal_account_admin()'));
 c.sql(database,'revoke all on function private.is_system_portal_account_admin() from public,anon,authenticated,service_role;');
 c.sql(database,"alter table private.employee_directory_details add column work_email text;insert into private.employee_directory_details(person_id,work_email) select id,'person'||right(id::text,1)||'@mobilityaccess.com.au' from public.internal_org_people;");
 c.sql(database,readFileSync('supabase/migrations/20260923010000_durable_notification_delivery_receipts.sql','utf8'));
 c.sql(database,definition('20261014110000_subscription_review_managers_mail.sql','create or replace function private.notification_event_key_valid('));
 for(const f of ['20261019105639_performance_review_readonly_preview.sql','20261019110000_performance_review_notifications.sql','20261019211233_performance_review_p0_manager_delegation.sql','20261019225516_performance_review_admin_reviewer.sql','20261020003343_performance_review_careers_cc.sql','20261020212355_performance_review_meeting_invitation.sql','20261020232835_performance_review_meeting_invitation_status.sql','20261020235553_performance_review_invitation_manager_routing.sql','20261021010742_performance_review_self_submitted_manager.sql','20261021024049_performance_review_manager_mail_manual_meeting.sql'])c.sql(database,readFileSync('supabase/migrations/'+f,'utf8'));
 c.sql(database,"update private.notification_delivery_control set legacy_import_sha256=repeat('a',64),legacy_import_count=0,legacy_imported_at=clock_timestamp();select private.set_notification_delivery_ready(true);");
}
const configured=`insert into public.internal_org_people(id,auth_user_id,full_name) values(${q(person(5))},${q(user(5))},'Synthetic named reviewer B');insert into private.employee_directory_details(person_id,work_email) values(${q(person(5))},'person5@mobilityaccess.com.au');insert into private.performance_review_final_recipients values('penny',${q(user(4))},${q(person(4))}),('steven',${q(user(5))},${q(person(5))});`;
const seed=(reviewer='manager',subject=1)=>`insert into private.performance_reviews(id,employee_person_id,assigned_manager_person_id,assigned_admin_user_id,cycle,due_date,employee_identity,manager_identity,self_submitted_at,finalised_at,final_document,manager_note) values(${q(id)},${q(person(subject))},${reviewer==='manager'?q(person(2)):'null'},${reviewer==='manager'?'null':q(user(reviewer==='admin5'?5:4))},'2039','2039-12-31',private.performance_review_identity(${q(person(subject))}),${reviewer==='manager'?'private.performance_review_identity('+q(person(2))+')':`jsonb_build_object('id',${q(user(reviewer==='admin5'?5:4))},'name','Synthetic admin reviewer')`},clock_timestamp(),clock_timestamp(),'${JSON.stringify({code:'PR-2039-1'})}','Synthetic private note');insert into private.performance_review_mail_outbox(review_id) values(${q(id)});`;
const probe=sql=>rows(c.sql(db,`begin;${sql}rollback;`));
const claim=`set local role service_role;select payload from public.claim_performance_review_mail(${q(id)},1);reset role;`;
const begun=(primary,cc)=>`select jsonb_build_object('allowed',public.begin_performance_review_final_mail(delivery_id,claim_token,repeat('a',64),${q(primary)},${cc===null?'null':`array[${cc.map(q).join(',')}]::text[]`})) from claimed;`;
const claimTable=`create temporary table claimed as select * from public.claim_performance_review_mail(${q(id)},1);grant select on claimed to service_role;`;
function started(database=db,employee=1,manager=2,cycle='2036'){
 return rows(c.sql(database,actor(manager,`select public.start_performance_review(${q(randomUUID())},${q(person(employee))},${q(cycle)},'2036-12-31');`))).find(r=>r.committed).review;
}
function readyReview(database=db,employee=1,manager=2,cycle='2036'){
 const review=started(database,employee,manager,cycle);
 c.sql(database,actor(employee,mutate(review.id,'self:0','submit_self',{answers:Array(12).fill('Synthetic employee evidence')})));
 return review;
}
const reviewState=review=>c.sql(db,`select jsonb_build_object('review',to_jsonb(r),'operations',(select jsonb_agg(to_jsonb(o) order by operation_id) from private.performance_review_operations o where review_id=r.id),'events',(select jsonb_agg(to_jsonb(e) order by id) from private.performance_review_events e where review_id=r.id),'outbox',(select jsonb_agg(to_jsonb(o) order by delivery_id) from private.performance_review_mail_outbox o where review_id=r.id)) from private.performance_reviews r where id=${q(review)};`);

before(()=>{c=ownedCluster(major);predecessor(db);c.sql(db,source);});
after(()=>c?.stop());

test('goal validator bounds exact fields, UTF-16 text and real ISO due dates while accepting partial drafts',()=>{
 const cases=[
  [[],false,true],[[],true,false],[[goal],true,true],[[{...goal,priority:''}],false,true],[[{...goal,priority:''}],true,false],
  [[{...goal,dueDate:''}],false,true],[[{...goal,dueDate:''}],true,false],[[{...goal,dueDate:'2027-02-29'}],false,false],
  [[{...goal,dueDate:'2028-02-29'}],true,true],[[{...goal,dueDate:'2028-2-29'}],false,false],
  [[{...goal,priority:'x'.repeat(2000)}],true,true],[[{...goal,priority:'x'.repeat(2001)}],false,false],
  [[{...goal,priority:'🦽'.repeat(1000)}],true,true],[[{...goal,priority:'🦽'.repeat(1001)}],false,false],
  [[{...goal,priority:'LEFT\u000bRIGHT'}],false,false],[[{...goal,extra:'untrusted'}],false,false],
  [[{priority:'Missing columns'}],false,false],[Array(10).fill(goal),true,true],[Array(11).fill(goal),false,false],
  [null,false,false],[{},false,false],['goals',false,false],[[null],false,false],
 ];
 const out=probe(cases.map(([value,required])=>`select jsonb_build_object('valid',private.performance_review_goals(${q(JSON.stringify(value))}::jsonb,${required}));`).join('\n'));
 out.forEach((row,i)=>assert.equal(row.valid,cases[i][2],String(i)));
});

test('draft goals persist through native autosave, old omitted input, operation replay and immutable collision handling',()=>{
 const review=readyReview(db,1,2,'2030'),op=randomUUID(),input={...assessment,goals:[goal,{...goal,priority:''}]};
 const query=actor(2,mutate(review.id,'manager:1:0','save_manager',input,op));
 const first=rows(c.sql(db,query)).at(-1);assert.deepEqual(first.review.goals,input.goals);
 assert.deepEqual(rows(c.sql(db,query)).at(-1),first);
 const before=reviewState(review.id),collision=c.run(db,actor(2,mutate(review.id,'manager:1:0','save_manager',{...input,goals:[]},op)));
 assert.notEqual(collision.status,0);assert.match(collision.stderr,/PT409/);assert.equal(reviewState(review.id),before);
 const omitted=rows(c.sql(db,actor(2,mutate(review.id,'manager:1:1','save_manager',assessment)))).at(-1);
 assert.deepEqual(omitted.review.goals,input.goals);
 const cleared=rows(c.sql(db,actor(2,mutate(review.id,'manager:1:2','save_manager',{...assessment,goals:[]})))).at(-1);
 assert.deepEqual(cleared.review.goals,[]);
 assert.equal(c.sql(db,`select count(*) from private.performance_review_mail_outbox where review_id=${q(review.id)};`).trim(),'0');
});

test('post-meeting final submission requires complete goals and snapshots exact goals without leaking the private note',()=>{
 const review=readyReview(db,1,2,'2031');
 let row=rows(c.sql(db,actor(2,mutate(review.id,'manager:1:0','complete_manager',{...assessment,goals:[{...goal,progressCheck:''}]})))).at(-1).review;
 assert.ok(row.managerCompletedAt,'inviting a meeting accepts incomplete goals');
 const before=reviewState(review.id),bad=c.run(db,actor(2,mutate(review.id,'manager:1:1','submit_review',meeting)));
 assert.notEqual(bad.status,0);assert.match(bad.stderr,/Complete review goals first/);assert.equal(reviewState(review.id),before);
 row=rows(c.sql(db,actor(2,mutate(review.id,'manager:1:1','save_manager',{...assessment,goals:[goal,{...goal,priority:'Second synthetic goal'}]})))).at(-1).review;
 const op=randomUUID(),finalQuery=actor(2,mutate(review.id,row.managerRevision,'submit_review',meeting,op));
 const result=rows(c.sql(db,finalQuery)).at(-1);assert.ok(result.review.finalisedAt);
 const snapshot=rows(c.sql(db,`select final_document from private.performance_reviews where id=${q(review.id)};`))[0];
 assert.deepEqual(snapshot.goals,row.goals);assert.equal(Object.hasOwn(snapshot,'managerNote'),false);
 assert.deepEqual(rows(c.sql(db,finalQuery)).at(-1),result);
 assert.equal(c.sql(db,`select count(*) from private.performance_review_mail_outbox where review_id=${q(review.id)};`).trim(),'1');
});

test('manager preview delegation saves goals with real actor attribution; employee projections and documents omit goals',()=>{
 const review=readyReview(db,1,2,'2032');
 const result=rows(c.sql(db,actor(5,delegated(review.id,'manager:1:0','save_manager',{...assessment,goals:[goal]})))).at(-1);
 assert.deepEqual(result.review.goals,[goal]);
 const employee=rows(c.sql(db,actor(1,'select public.performance_review_workspace();'))).at(-1).reviews.find(r=>r.id===review.id);
 assert.equal(Object.hasOwn(employee,'goals'),false);
 const document=rows(c.sql(db,actor(1,`select public.get_performance_review_document(${q(review.id)});`))).at(-1);
 assert.equal(Object.hasOwn(document,'goals'),false);
 const managerPreview=rows(c.sql(db,actor(5,`select public.performance_review_workspace_for_preview(${q(person(2))});`))).at(-1).reviews.find(r=>r.id===review.id);
 assert.deepEqual(managerPreview.goals,[goal]);assert.equal(managerPreview.capabilities.saveManager,false);
 const event=rows(c.sql(db,`select jsonb_build_object('actor',actor_user_id) from private.performance_review_events where review_id=${q(review.id)} and kind='save_manager';`))[0];
 assert.equal(event.actor,user(5));
});

test('native Admin and selected-Manager delegation enforce goal completion before snapshotting their final document',()=>{
 for(const delegate of [false,true]){
  const review=readyReview(db,1,delegate?2:4,delegate?'2034':'2035');
  const revision=version=>`${delegate?'manager':'read'}:1:${version}`;
  const command=(version,kind,input)=>delegate?delegated(review.id,revision(version),kind,input):mutate(review.id,revision(version),kind,input);
  c.sql(db,actor(delegate?5:4,command(0,'complete_manager',{...assessment,goals:[]})));
  const before=reviewState(review.id),bad=c.run(db,actor(delegate?5:4,command(1,'submit_review',meeting)));
  assert.notEqual(bad.status,0);assert.match(bad.stderr,/Complete review goals first/);assert.equal(reviewState(review.id),before);
  c.sql(db,actor(delegate?5:4,command(1,'save_manager',{...assessment,goals:[goal]})));
  const final=rows(c.sql(db,actor(delegate?5:4,command(2,'submit_review',meeting)))).at(-1).review;
  assert.ok(final.finalisedAt);assert.deepEqual(final.goals,[goal]);
  const snapshot=rows(c.sql(db,`select final_document from private.performance_reviews where id=${q(review.id)};`))[0];
  assert.deepEqual(snapshot.goals,[goal]);assert.equal(Object.hasOwn(snapshot,'managerNote'),false);
 }
});

test('empty named recipient configuration fails closed without broadening admin membership',()=>{
 const out=probe(seed()+claim);assert.equal(out.length,1);assert.equal(out[0].recipient,'person2@mobilityaccess.com.au');assert.equal(out[0].ccRecipients,null);
 assert.equal(c.sql(db,'select count(*) from private.performance_review_final_recipients;').trim(),'0');
});

test('final mail resolves only two named canonical current reviewers and binds the entire ordered recipient set once',()=>{
 const out=probe(configured+seed()+claim);
 assert.equal(out.length,1);assert.equal(out[0].recipient,'person2@mobilityaccess.com.au');assert.deepEqual(out[0].ccRecipients,['person4@mobilityaccess.com.au','person5@mobilityaccess.com.au']);
 assert.deepEqual(Object.keys(out[0]).sort(),['reviewId','reviewCode','finalisedAt','managerNote','document','recipient','ccRecipients'].sort());
 const results=probe(configured+seed()+claimTable+'set local role service_role;'+
  begun('person3@mobilityaccess.com.au',['person4@mobilityaccess.com.au','person5@mobilityaccess.com.au'])+
  begun('person2@mobilityaccess.com.au',['person5@mobilityaccess.com.au','person4@mobilityaccess.com.au'])+
  begun('person2@mobilityaccess.com.au',['person4@mobilityaccess.com.au'])+
  begun('person2@mobilityaccess.com.au',['person4@mobilityaccess.com.au','person5@mobilityaccess.com.au','person6@mobilityaccess.com.au'])+
  begun('person2@mobilityaccess.com.au',['person4@mobilityaccess.com.au','person5@mobilityaccess.com.au'])+
  begun('person2@mobilityaccess.com.au',['person4@mobilityaccess.com.au','person5@mobilityaccess.com.au'])+'reset role;');
 assert.deepEqual(results,[{allowed:false},{allowed:false},{allowed:false},{allowed:false},{allowed:true},{allowed:false}]);
});

test('final CC deduplicates a primary admin recipient and never exposes an employee own private review',()=>{
 const dedup=probe(configured+seed('admin')+`update public.internal_org_people set parent_id=null where id=${q(person(1))};`+claim)[0];
 assert.equal(dedup.recipient,'person4@mobilityaccess.com.au');assert.deepEqual(dedup.ccRecipients,['person5@mobilityaccess.com.au']);
 const subject=probe(configured+seed('admin5',4)+`update public.internal_org_people set parent_id=${q(person(2))} where id=${q(person(4))};`+claim)[0];
 assert.equal(subject.recipient,'person2@mobilityaccess.com.au');assert.deepEqual(subject.ccRecipients,['person5@mobilityaccess.com.au']);
 const noCc=probe(configured+seed('admin5',4)+claim)[0];
 assert.equal(noCc.recipient,'person5@mobilityaccess.com.au');assert.deepEqual(noCc.ccRecipients,[]);
 const validEmpty=probe(configured+seed('admin5',4)+claimTable+'set local role service_role;'+begun('person5@mobilityaccess.com.au',[])+'reset role;');assert.deepEqual(validEmpty,[{allowed:true}]);
});

test('missing, inactive, wrong-role, relinked, duplicate, external and Careers named reviewers fail closed',()=>{
 for(const change of [
  "delete from private.performance_review_final_recipients where slot='steven';",
  `update public.internal_org_people set is_active=false where id=${q(person(4))};`,
  `update public.profiles set account_status='disabled' where id=${q(user(4))};`,
  `update public.profiles set app_role='manager' where id=${q(user(4))};`,
  `update public.internal_org_people set auth_user_id=null where id=${q(person(4))};`,
  `update private.employee_directory_details set work_email='person4@mobilityaccess.com.au' where person_id=${q(person(6))};`,
  `update private.employee_directory_details set work_email='external@example.net' where person_id=${q(person(4))};`,
  `update private.employee_directory_details set work_email='careers@mobilityaccess.com.au' where person_id=${q(person(4))};`,
 ])assert.equal(probe(configured+seed()+change+claim)[0].ccRecipients,null,change);
});

test('directory changes after claim block begin and every legacy unbound provider begin is inaccessible',()=>{
 for(const change of [
  `update private.employee_directory_details set work_email='updated@mobilityaccess.com.au' where person_id=${q(person(4))};`,
  `update public.internal_org_people set is_active=false where id=${q(person(5))};`,
  `update private.performance_review_final_recipients set auth_user_id=${q(user(6))},person_id=${q(person(6))} where slot='penny';`,
 ])assert.deepEqual(probe(configured+seed()+claimTable+change+begun('person2@mobilityaccess.com.au',['person4@mobilityaccess.com.au','person5@mobilityaccess.com.au'])),[{allowed:false}]);
 for(const role of ['anon','authenticated','service_role']){
  const access=rows(c.sql(db,`select jsonb_build_object('legacy',has_function_privilege(${q(role)},'public.begin_performance_review_mail(uuid,uuid,text)','execute'),'managerOnly',has_function_privilege(${q(role)},'public.begin_performance_review_manager_mail(uuid,uuid,text,text)','execute'),'final',has_function_privilege(${q(role)},'public.begin_performance_review_final_mail(uuid,uuid,text,text,text[])','execute'),'config',has_table_privilege(${q(role)},'private.performance_review_final_recipients','select,insert,update,delete'));`))[0];
  assert.deepEqual(access,{legacy:false,managerOnly:false,final:role==='service_role',config:false});
 }
});

test('configuration writes cannot race the final provider begin revalidation',async()=>{
 c.sql(db,configured+seed()+`create table private.synthetic_claim as select * from public.claim_performance_review_mail(${q(id)},1);grant select on private.synthetic_claim to service_role;`);
 const blocker=spawn('psql',['-X','-h',c.socket,'-p',String(c.port),'-U','postgres','-d',db,'-At','-v','ON_ERROR_STOP=1'],{env,stdio:['pipe','pipe','pipe']});
 let output='';const closed=new Promise(resolve=>blocker.on('close',resolve));
 const locked=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('configuration lock did not start')),5000);blocker.stdout.on('data',data=>{output+=data;if(output.includes('CONFIG_LOCKED')){clearTimeout(timeout);resolve();}});blocker.on('error',reject);});
 blocker.stdin.end('begin;lock table private.performance_review_final_recipients in row exclusive mode;select \'CONFIG_LOCKED\';select pg_sleep(1.5);rollback;');
 await locked;
 const blocked=c.run(db,`begin;set local lock_timeout='50ms';set local role service_role;select public.begin_performance_review_final_mail(delivery_id,claim_token,repeat('a',64),'person2@mobilityaccess.com.au',array['person4@mobilityaccess.com.au','person5@mobilityaccess.com.au']) from private.synthetic_claim;rollback;`);
 assert.notEqual(blocked.status,0);assert.match(blocked.stderr,/55P03/);assert.equal(await closed,0);
 c.sql(db,`drop table private.synthetic_claim;delete from private.performance_review_notifications where review_id=${q(id)};delete from private.performance_review_mail_outbox where review_id=${q(id)};delete from private.performance_reviews where id=${q(id)};delete from private.performance_review_final_recipients;delete from private.employee_directory_details where person_id=${q(person(5))};delete from public.internal_org_people where id=${q(person(5))};`);
});

function ordinary(company='MAM',goals=[]){
 const savedMeeting={...meeting};delete savedMeeting.held;
 return {audience:'manager',code:'PR-2036-1',cycle:'2036',employee:{id:person(1),name:'Synthetic employee',jobTitle:'Synthetic role',team:'Synthetic team',company},manager:{id:person(2),name:'Synthetic manager'},selfAnswers:Array(12).fill('Synthetic self evidence'),managerAnswers:Array(12).fill('Synthetic manager evidence'),ratings:Array(12).fill('2 Meets expectations'),summary:'Synthetic summary',overallRating:'2 Meets expectations',meeting:savedMeeting,goals};
}
const wordBytes=document=>buildReviewDocx(document,QUESTIONS[document.employee.company]).length;
test('exact SQL Word budget matches canonical renderer for legacy and 1–10 goal rows, Unicode, XML escaping and line breaks',()=>{
 const cases=[];
 for(const company of ['MAM','Equipsy']){
  cases.push(ordinary(company,[]));const legacy=ordinary(company);delete legacy.goals;cases.push(legacy);
  for(const n of [1,3,10])cases.push(ordinary(company,Array.from({length:n},(_,i)=>({...goal,priority:`Synthetic goal ${i}`}))));
  for(const field of ['priority','measureOfSuccess','supportAndResponsiblePerson','progressCheck'])for(const value of ['🦽'.repeat(1000),'&<>"\'\r\n\n\r\t e\u0301\u0085\ufffd\u{10ffff}','\t'.repeat(2000),'\n'.repeat(2000)])cases.push(ordinary(company,[{...goal,[field]:value}]));
 }
 const out=probe(cases.map(document=>`select jsonb_build_object('bytes',private.performance_review_docx_bytes(${q(JSON.stringify(document))}::jsonb));`).join('\n'));
 out.forEach((row,i)=>assert.equal(row.bytes,wordBytes(cases[i]),String(i)));
});

test('goal-bearing final snapshots enforce the complete Word byte cap at one byte below, exactly at and one byte above two MiB',()=>{
 for(const [index,limit] of [2097151,2097152,2097153].entries()){
  const review=started(db,1,2,String(2040+index)),document=ordinary('MAM',[goal,{...goal,priority:'Second synthetic goal'}]);
  Object.assign(document,{employee:review.employee,manager:review.manager,code:review.code,cycle:review.cycle});
  document.selfAnswers.fill('x'.repeat(8000));document.managerAnswers.fill('x'.repeat(8000));document.meeting.notes='';
  let remaining=limit-wordBytes(document);assert.ok(remaining>0);
  for(const answers of [document.selfAnswers,document.managerAnswers])for(let i=0;i<12;i++){
   const n=Math.min(7999,Math.floor(remaining/38));answers[i]='\n'.repeat(n)+'x'.repeat(8000-n);remaining-=n*38;
  }
  assert.ok(remaining<8000);document.meeting.notes='x'.repeat(remaining);assert.equal(wordBytes(document),limit);
  const sqlBytes=probe(`select jsonb_build_object('bytes',private.performance_review_docx_bytes(${q(JSON.stringify(document))}::jsonb));`)[0].bytes;
  assert.equal(sqlBytes,limit);
  c.sql(db,actor(1,mutate(review.id,'self:0','submit_self',{answers:document.selfAnswers})));
  c.sql(db,actor(2,mutate(review.id,'manager:1:0','complete_manager',{answers:document.managerAnswers,ratings:document.ratings,summary:document.summary,overallRating:document.overallRating,managerNote:assessment.managerNote,goals:document.goals})));
  const before=reviewState(review.id),result=c.run(db,actor(2,mutate(review.id,'manager:1:1','submit_review',{...document.meeting,held:true})));
  if(limit>2097152){assert.notEqual(result.status,0);assert.match(result.stderr,/attachment exceeds/);assert.equal(reviewState(review.id),before);}
  else {assert.equal(result.status,0,result.stderr);assert.deepEqual(rows(c.sql(db,`select final_document from private.performance_reviews where id=${q(review.id)};`))[0],document);}
 }
});

for(const hold of [false,true])test(`migration preserves ${hold?'prior purge HOLD':'healthy purge fingerprint'} and historical immutable snapshots and receipts`,()=>{
 const database='mam_test_pr_goals_purge_'+(hold?'hold':'healthy');predecessor(database);
 const review=readyReview(database,1,2,'2033');c.sql(database,actor(2,mutate(review.id,'manager:1:0','save_manager',assessment)));
 c.sql(database,seed());
 const state=()=>c.sql(database,'select to_jsonb(r) from private.performance_reviews r order by id;select to_jsonb(o) from private.performance_review_operations o order by actor_user_id,operation_id;select to_jsonb(o) from private.performance_review_mail_outbox o order by delivery_id;');
 const before=state();c.sql(database,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash();');
 if(hold)c.sql(database,'grant select on public.profiles to authenticated;');
 const stored=c.sql(database,'select schema_hash from private.confirmed_test_purge_schema;');c.sql(database,source);
 assert.equal(c.sql(database,'select schema_hash=private.confirmed_test_purge_schema_hash() from private.confirmed_test_purge_schema;').trim(),hold?'f':'t');
 assert.equal(c.sql(database,'select schema_hash from private.confirmed_test_purge_schema;')===stored,hold);
 const after=c.sql(database,"select to_jsonb(r)-'goals' from private.performance_reviews r order by id;select to_jsonb(o) from private.performance_review_operations o order by actor_user_id,operation_id;select to_jsonb(o) from private.performance_review_mail_outbox o order by delivery_id;");
 assert.equal(after,before);assert.equal(c.sql(database,"select bool_and(goals='[]'::jsonb) from private.performance_reviews;").trim(),'t');
});

for(const [label,mutation] of [['catalog','grant select on public.profiles to authenticated;'],['row',"update private.performance_review_mail_outbox set queued_at=queued_at+interval '1 second';"]])test(`migration rolls back an unrelated ${label} mutation and its new column/config atomically`,()=>{
 const database='mam_test_pr_goals_delta_'+label;predecessor(database);c.sql(database,seed());
 const before=c.sql(database,'select to_jsonb(r) from private.performance_reviews r;select to_jsonb(o) from private.performance_review_mail_outbox o;');
 const result=c.run(database,source.replace('do $goals_final_catalog_after$',mutation+'\ndo $goals_final_catalog_after$'));
 assert.notEqual(result.status,0);assert.match(result.stderr,/unrelated catalog delta/);
 assert.equal(c.sql(database,'select to_jsonb(r) from private.performance_reviews r;select to_jsonb(o) from private.performance_review_mail_outbox o;'),before);
 assert.equal(c.sql(database,"select to_regclass('private.performance_review_final_recipients') is null and not exists(select 1 from pg_attribute where attrelid='private.performance_reviews'::regclass and attname='goals' and not attisdropped);").trim(),'t');
});
