import assert from 'node:assert/strict';
import test from 'node:test';
import {loadModule} from './helpers/contact-lifetime-harness.mjs';
import {productionActionHarness, enabled, finalInput} from './performance-review-production-ui-fixture.mjs';
import {document, mutation, meeting} from './performance-review-backend-fixtures.mjs';
const rules=loadModule('src/lib/performance-review-rules.ts');
const controls=[...Array.from({length:32},(_,i)=>i).filter(i=>![9,10,13].includes(i)),127,0xfffe,0xffff].map(i=>String.fromCodePoint(i));
const unsupported=[...controls,'\ud800','\udfff'];
const valid=['Plain','合法文本 🦽 𐀀 e\u0301','TAB\tLF\nCR\rCRLF\r\nEND','\u0080\u0085\u009f\ue000\ufffd\u{10ffff}',"&<>\"'",'a'.repeat(8000),'🦽'.repeat(4000)];
const inputs=value=>[
 {...mutation(),input:{answers:Array(12).fill(value)}},
 {...mutation(),command:'save_manager',expectedRevision:'manager:1:0',input:{answers:Array(12).fill(value),ratings:Array(12).fill(''),summary:'',overallRating:'',managerNote:''}},
 ...['summary','managerNote'].map(key=>({...mutation(),command:'save_manager',expectedRevision:'manager:1:0',input:{answers:Array(12).fill(''),ratings:Array(12).fill(''),summary:'',overallRating:'',managerNote:'',[key]:value}})),
 ...['location','notes'].map(key=>({...mutation(),command:'save_meeting',expectedRevision:'manager:1:0',input:{...meeting,[key]:value}})),
];

test('all saved performance text rejects unsupported controls and nonrepresentable scalars',()=>{
 for(const bad of unsupported) for(const input of inputs('LEFT'+bad+'RIGHT')) assert.throws(()=>rules.parseMutationInput(input),/Invalid performance review data/);
});
test('legal Unicode and TAB LF CR remain exact with the existing UTF16 boundary',()=>{
 for(const value of valid) for(const input of inputs(value)) assert.deepEqual(rules.parseMutationInput(input),input);
 for(const value of ['x'.repeat(8001),'🦽'.repeat(4001)]) for(const input of inputs(value)) assert.throws(()=>rules.parseMutationInput(input));
});
test('document fields derived from the directory reject rather than strip unsupported text',()=>{
 for(const bad of unsupported) for(const [target,key] of [['employee','name'],['employee','jobTitle'],['employee','team'],['manager','name']]) {
  const d=document('manager');d[target][key]='LEFT'+bad+'RIGHT';assert.throws(()=>rules.parseDocument(d));
 }
});
test('real mutation Action returns safe invalid before auth RPC or after registration',async()=>enabled(async()=>{
 for(const input of inputs('LEFT\u000bRIGHT')) {
  const h=productionActionHarness(); const result=await h.actions.mutatePerformanceReview(input);
  assert.equal(result.code,'invalid');assert.equal(result.uncertain,false);assert.equal(h.authCalls(),0);assert.equal(h.calls.length,0);assert.equal(h.registrations.length,0);
 }
 const h=productionActionHarness({response:{data:null,error:{code:'22023',message:'PRIVATE SQL ATTACHMENT'},status:400}});
 const result=await h.actions.mutatePerformanceReview(finalInput());
 assert.equal(result.code,'invalid');assert.equal(result.uncertain,false);assert.equal(h.business().length,1);assert.equal(h.registrations.length,0);assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
}));
