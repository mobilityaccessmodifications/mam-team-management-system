import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const ts=require('typescript');
const exports={};
new Function('exports','require',ts.transpileModule(readFileSync('src/lib/leave-notice.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(exports,()=>({melbourneToday:()=> '2026-09-21'}));
const check=(overrides={},today='2026-09-21')=>exports.requiresLeaveNotice({employmentType:'full_time',leaveType:'Annual leave',startDate:'2026-09-22',onBehalfOf:false,...overrides},today);
test('non-ABN annual/unpaid self-service requires 14 calendar days',()=>{
 for(const employmentType of ['full_time','part_time','casual',null]) for(const leaveType of ['Annual leave','Unpaid leave']) {
  assert.equal(check({employmentType,leaveType}),true);
  assert.equal(check({employmentType,leaveType,startDate:'2026-10-04'}),true);
  assert.equal(check({employmentType,leaveType,startDate:'2026-10-05'}),false);
 }
});
test('ABN, on-behalf and sick/carer flows are unchanged',()=>{
 assert.equal(check({employmentType:'abn',leaveType:'Unpaid leave'}),false);
 assert.equal(check({onBehalfOf:true}),false);
 for(const leaveType of ['Sick leave',"Carer's leave"]) assert.equal(check({leaveType}),false);
});
test('notice boundary crosses DST, year and leap-day using calendar dates',()=>{
 assert.equal(check({startDate:'2027-01-03'},'2026-12-21'),true);
 assert.equal(check({startDate:'2027-01-04'},'2026-12-21'),false);
 assert.equal(check({startDate:'2028-03-01'},'2028-02-16'),false);
 assert.equal(check({startDate:'2026-10-05'}),false);
});

test('trade school has no minimum notice period for self-service or on-behalf requests',()=>{
 for(const onBehalfOf of [false,true]) assert.equal(check({leaveType:'trade school',onBehalfOf}),false);
});
