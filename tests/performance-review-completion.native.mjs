import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync, readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {download, ordinary, sourceSize, atLimit, parityCases} from './performance-review-completion-word-fixture.mjs';
import {ownedCluster, rows, actor, q, person} from './performance-review-production-harness.mjs';

const migration = 'supabase/migrations/20261017103000_performance_review_completion_guards.sql';
const answers = value => Array(12).fill(value);
const meeting = {date:'2026-01-02', time:'10:00', duration:30, mode:'in_person', location:'Synthetic room', notes:'Synthetic notes', held:true};
const managerInput = value => ({answers:answers(value), ratings:answers('2 Meets expectations'), summary:'Synthetic summary', overallRating:'2 Meets expectations', managerNote:'PRIVATE-SYNTHETIC-NOTE'});
const mutation = (id, revision, command, input, operation=randomUUID()) => `select public.mutate_performance_review(${q(operation)},${q(id)},${q(revision)},${q(command)},${q(JSON.stringify(input))}::jsonb);`;

test('native saved text rejects vertical tab through self manager note summary and meeting RPCs',()=>{
 const c=ownedCluster(17);
 try {
  const db='mam_test_pr_completion_text';c.setup(db);if(existsSync(migration))c.sql(db,readFileSync(migration,'utf8'));
  const started=rows(c.sql(db,actor(2,`select public.start_performance_review(${q(randomUUID())},${q(person(1))},'2026','2026-12-31');`))).find(r=>r.committed);
  const id=started.review.id,bad='LEFT\u000bRIGHT';
  let result=c.run(db,actor(1,mutation(id,'self:0','save_self',{answers:answers(bad)})));
  assert.equal(result.status,3,'unsupported self text must fail before storage');assert.match(result.stderr,/22023/);
  c.sql(db,actor(1,mutation(id,'self:0','submit_self',{answers:answers('Evidence')})));
  for(const key of ['answers','summary','managerNote']) {
   const input={...managerInput('Evidence'),[key]:key==='answers'?answers(bad):bad};
   result=c.run(db,actor(2,mutation(id,'manager:1:0','save_manager',input)));assert.equal(result.status,3,key);assert.match(result.stderr,/22023/);
  }
  c.sql(db,actor(2,mutation(id,'manager:1:0','complete_manager',managerInput('Evidence'))));
  for(const key of ['location','notes']) {
   const input={...meeting,[key]:bad};delete input.held;
   result=c.run(db,actor(2,mutation(id,'manager:1:1','save_meeting',input)));assert.equal(result.status,3,key);assert.match(result.stderr,/22023/);
  }
  assert.equal(c.sql(db,'select count(*) from private.performance_review_mail_outbox;').trim(),'0');
 } finally {c.stop();}
});

test('start rejects unrepresentable directory snapshots without changing directory data',()=>{
 const c=ownedCluster(17);
 try {
  const db='mam_test_pr_completion_identity';c.setup(db);if(existsSync(migration))c.sql(db,readFileSync(migration,'utf8'));
  c.sql(db,`update public.internal_org_people set full_name=E'LEFT\\013RIGHT' where id=${q(person(1))};`);
  const before=c.sql(db,'select md5(jsonb_agg(to_jsonb(p) order by p.id)::text) from public.internal_org_people p;');
  const result=c.run(db,actor(2,`select public.start_performance_review(${q(randomUUID())},${q(person(1))},'2026','2026-12-31');`));
  assert.equal(result.status,3);assert.match(result.stderr,/22023/);
  assert.equal(c.sql(db,'select count(*) from private.performance_reviews;').trim(),'0');
  assert.equal(c.sql(db,'select md5(jsonb_agg(to_jsonb(p) order by p.id)::text) from public.internal_org_people p;'),before);
 } finally {c.stop();}
});

test('native exact byte budget equals real Word for every variable placement and both companies',()=>{
 const c=ownedCluster(17);
 try {
  const db='mam_test_pr_completion_parity';c.setup(db);c.sql(db,readFileSync(migration,'utf8'));
  const cases=parityCases();
  for(let start=0;start<cases.length;start+=16) {
   const batch=cases.slice(start,start+16);
   const actual=rows(c.sql(db,batch.map(({label,document})=>`select jsonb_build_object('label',${q(label)},'bytes',private.performance_review_docx_bytes(${q(JSON.stringify(document))}::jsonb));`).join('\n')));
   assert.equal(actual.length,batch.length);
   actual.forEach((row,i)=>{assert.equal(row.label,batch[i].label);assert.equal(row.bytes,download(batch[i].document).bytes.length,row.label);});
  }
  const bad=Array.from({length:32},(_,i)=>i).filter(i=>![9,10,13].includes(i)).concat([127,0xfffe,0xffff]);
  for(const code of bad) {
   const literal=JSON.stringify('LEFT'+String.fromCodePoint(code)+'RIGHT');
   const r=c.run(db,code===0?`select ${q(literal)}::jsonb;`:`select jsonb_build_object('valid',private.performance_review_text(${q(literal)}::jsonb));`);
   if(code===0){assert.equal(r.status,3);assert.match(r.stderr,/22P05/);}else {assert.equal(r.status,0,r.stderr);assert.equal(rows(r.stdout)[0].valid,false,`control ${code}`);}
  }
 } finally {c.stop();}
});

test('ordinary 8000 text and exact two MiB attachments finalise while one byte over keeps the draft',()=>{
 const c=ownedCluster(17);
 try {
  const db='mam_test_pr_completion_positive';c.setup(db);c.sql(db,readFileSync(migration,'utf8'));
  for(const [company,employee,manager]of [['MAM',1,2],['Equipsy',7,8]])for(const [index,kind]of ['plain','escaped','unicode','below','equal','above'].entries()) {
   const started=rows(c.sql(db,actor(manager,`select public.start_performance_review(${q(randomUUID())},${q(person(employee))},${q(String(2026+index))},'2026-12-31');`))).find(r=>r.committed);
   const id=started.review.id,d=ordinary(company);d.employee=started.review.employee;d.manager=started.review.manager;d.code=started.review.code;d.cycle=started.review.cycle;
   if(['plain','escaped','unicode'].includes(kind)) {const value=kind==='plain'?'x'.repeat(8000):kind==='escaped'?"'".repeat(8000):'🦽'.repeat(4000);d.selfAnswers.fill(value);d.managerAnswers.fill(value);d.summary=value;d.meeting.location=value;d.meeting.notes=value;}else atLimit(d,2097152+({below:-1,equal:0,above:1}[kind]));
   const bytes=download(d).bytes.length;assert.equal(bytes,sourceSize(d));
   c.sql(db,actor(employee,mutation(id,'self:0','submit_self',{answers:d.selfAnswers})));
   c.sql(db,actor(manager,mutation(id,'manager:1:0','complete_manager',{answers:d.managerAnswers,ratings:d.ratings,summary:d.summary,overallRating:d.overallRating,managerNote:'Private note '+"'".repeat(7987)})));
   const op=randomUUID(),query=actor(manager,mutation(id,'manager:1:1','submit_review',{...d.meeting,held:true},op));
   const result=c.run(db,query);
   const state=rows(c.sql(db,`select jsonb_build_object('document',final_document,'held',meeting_held_at is not null,'final',finalised_at is not null,'version',manager_version,'events',(select count(*) from private.performance_review_events where review_id=r.id),'operations',(select count(*) from private.performance_review_operations where review_id=r.id),'outbox',(select count(*) from private.performance_review_mail_outbox where review_id=r.id)) from private.performance_reviews r where id=${q(id)};`))[0];
   if(kind==='above') {assert.equal(result.status,3);assert.match(result.stderr,/22023/);assert.deepEqual([state.final,state.held,state.version,state.events,state.operations,state.outbox],[false,false,1,3,3,0]);}
   else {
    assert.equal(result.status,0,result.stderr);assert.ok(bytes<=2097152);assert.deepEqual([state.final,state.held,state.version,state.events,state.operations,state.outbox],[true,true,2,4,4,1]);assert.deepEqual(state.document,d);assert.ok(!Object.hasOwn(state.document,'managerNote'));
    const replay=c.run(db,query);assert.equal(replay.status,0,replay.stderr);assert.equal(c.sql(db,`select count(*) from private.performance_review_mail_outbox where review_id=${q(id)};`).trim(),'1');
   }
  }
 } finally {c.stop();}
});

test('raw authenticated final rejects canonical Word overflow before any final or outbox commit', () => {
  const c = ownedCluster(17);
  try {
    const db='mam_test_pr_completion';
    c.setup(db);
    if (existsSync(migration)) c.sql(db,readFileSync(migration,'utf8'));
    for (const [company, employee, manager] of [['MAM',1,2],['Equipsy',7,8]]) {
      const started=rows(c.sql(db,actor(manager,`select public.start_performance_review(${q(randomUUID())},${q(person(employee))},'2026','2026-12-31');`))).find(row=>row.committed===true);
      const id=started.review.id;
      const value='R\n'.repeat(3998)+'END';
      c.sql(db,actor(employee,mutation(id,'self:0','submit_self',{answers:answers(value)})));
      c.sql(db,actor(manager,mutation(id,'manager:1:0','complete_manager',managerInput(value))));
      const before=rows(c.sql(db,`select jsonb_build_object('review',to_jsonb(r),'events',(select count(*) from private.performance_review_events where review_id=r.id),'operations',(select count(*) from private.performance_review_operations where review_id=r.id)) from private.performance_reviews r where id=${q(id)};`))[0];
      const result=c.run(db,actor(manager,mutation(id,'manager:1:1','submit_review',meeting)));
      const after=rows(c.sql(db,`select jsonb_build_object('review',to_jsonb(r),'events',(select count(*) from private.performance_review_events where review_id=r.id),'operations',(select count(*) from private.performance_review_operations where review_id=r.id),'outbox',(select count(*) from private.performance_review_mail_outbox where review_id=r.id)) from private.performance_reviews r where id=${q(id)};`))[0];
      assert.equal(after.outbox,0,`${company}: overflow must create zero outbox rows`);
      assert.deepEqual(after.review,before.review,`${company}: exact draft must survive`);
      assert.equal(after.events,before.events);
      assert.equal(after.operations,before.operations);
      assert.equal(result.status,3);
      assert.match(result.stderr,/22023/);
    }
  } finally { c.stop(); }
});
