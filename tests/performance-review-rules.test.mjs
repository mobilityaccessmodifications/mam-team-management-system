import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { loadModule } from './helpers/contact-lifetime-harness.mjs';
function rules() {
  assert.ok(existsSync('src/lib/performance-review-rules.ts'), 'Native performance input rules are missing');
  return loadModule('src/lib/performance-review-rules.ts');
}
const operationId='10000000-0000-4000-8000-000000000001';
const reviewId='20000000-0000-4000-8000-000000000001';
const self=()=>({operationId,reviewId,expectedRevision:'self:0',command:'save_self',input:{answers:Array(12).fill('')}});
test('self input preserves twelve answers and rejects open keys and oversized UTF16',()=>{
  const r=rules();const input=self();input.input.answers[0]='🦽'.repeat(4000);
  assert.deepEqual(r.parseMutationInput(input),input);
  for(const value of [{...input,actorUserId:operationId},{...input,input:{...input.input,managerNote:'secret'}},{...input,input:{answers:Array(11).fill('')}},{...input,input:{answers:Array(12).fill('🦽'.repeat(4001))}}]) assert.throws(()=>r.parseMutationInput(value));
});
test('submission enforces original required answers and exact manager ratings',()=>{
  const r=rules();const s=self();s.command='submit_self';s.input.answers=Array(12).fill('Answer');
  assert.deepEqual(r.parseMutationInput(s),s);
  for(const i of [0,3,4,5,6,7,8,9,10]) { const b=structuredClone(s);b.input.answers[i]='\u2003';assert.throws(()=>r.parseMutationInput(b)); }
  for(const i of [1,2,11]) { const b=structuredClone(s);b.input.answers[i]='';assert.deepEqual(r.parseMutationInput(b),b); }
  const m={...s,expectedRevision:'manager:1:0',command:'complete_manager',input:{answers:Array(12).fill('Evidence'),ratings:Array(12).fill('2 Meets expectations'),summary:'Summary',overallRating:'N Not enough evidence',managerNote:'Private'}};
  assert.deepEqual(r.parseMutationInput(m),m);
  for(const key of ['summary','overallRating','managerNote']) {const b=structuredClone(m);b.input[key]='';assert.throws(()=>r.parseMutationInput(b));}
  for(const i of [0,1,2,6,7,8,9]) {const b=structuredClone(m);b.input.ratings[i]='';assert.throws(()=>r.parseMutationInput(b));}
  const b=structuredClone(m);b.input.ratings[11]='unknown';assert.throws(()=>r.parseMutationInput(b));
  const draft={...m,command:'save_manager',input:{answers:Array(12).fill(''),ratings:Array(12).fill(''),summary:'',overallRating:'',managerNote:''}};assert.deepEqual(r.parseMutationInput(draft),draft);
});
test('Melbourne meeting validation rejects DST gaps and folds and requires Boolean held',()=>{
  const r=rules();const meeting={date:'2026-10-16',time:'23:55',duration:10,mode:'in_person',location:'Room',notes:''};
  assert.equal(r.meetingEndMillis(meeting),Date.parse('2026-10-16T13:05:00Z'));
  const input={operationId,reviewId,expectedRevision:'manager:1:2',command:'save_meeting',input:meeting};
  assert.deepEqual(r.parseMutationInput(input),input);
  assert.deepEqual(r.parseMutationInput({...input,command:'submit_review',input:{...meeting,held:true}}).input.held,true);
  for(const held of [false,'true',1,null]) assert.throws(()=>r.parseMutationInput({...input,command:'submit_review',input:{...meeting,held}}));
  for(const bad of [{date:'2026-02-30'},{date:'2026-10-04',time:'02:30'},{date:'2026-04-05',time:'02:30'},{duration:4},{duration:481},{duration:5.5},{time:'24:00'},{mode:'teams',location:'http://teams.microsoft.com/x'}]) assert.throws(()=>r.parseMutationInput({...input,input:{...meeting,...bad}}));
  assert.doesNotThrow(()=>r.parseMutationInput({...input,input:{...meeting,duration:5,mode:'teams',location:'https://teams.microsoft.com/l/meetup-join/test'}}));
});
test('start and reconcile requests preserve IDs and real calendar dates without extra keys',()=>{
  const r=rules();const start={operationId,employeePersonId:reviewId,cycle:'2026',dueDate:'2028-02-29'};
  assert.deepEqual(r.parseStartInput(start),start);
  for(const bad of [{...start,dueDate:'2026-02-29'},{...start,cycle:'20260'},{...start,managerId:operationId}]) assert.throws(()=>r.parseStartInput(bad));
  assert.deepEqual(r.parseReconcileInput({operationId,reviewId:null}),{operationId,reviewId:null});
  assert.throws(()=>r.parseReconcileInput({operationId}));
});
test('raw arrays reject symbols and accessors before reading and snapshot accepted bodies',()=>{
 const r=rules();let reads=0;const s=self();Object.defineProperty(s.input.answers,'0',{get(){reads++;return 'hidden';},enumerable:true});assert.throws(()=>r.parseMutationInput(s));assert.equal(reads,0);
 const b=self();b.input.answers[Symbol('hidden')]='x';assert.throws(()=>r.parseMutationInput(b));
 const original=self();const parsed=r.parseMutationInput(original);original.input.answers[0]='changed during auth';assert.equal(parsed.input.answers[0],'');
});
