import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const exports = {};
new Function('exports','require',ts.transpileModule(readFileSync('src/lib/leave-notice.ts','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS}
}).outputText)(exports,require);
const check = (overrides={},today='2026-09-21') => exports.requiresLeaveNotice({
 employmentType:'full_time',leaveType:'Annual leave',startDate:'2026-09-22',onBehalfOf:false,...overrides
},today);
test('annual and unpaid leave do not require 14 calendar days notice',()=>{
 for(const employmentType of ['full_time','part_time','casual','overseas','abn',null])
 for(const leaveType of ['Annual leave','Unpaid leave']) {
  for(const startDate of ['2026-09-21','2026-09-22','2026-10-04','2026-10-05']) {
   assert.equal(check({employmentType,leaveType,startDate}),false);
  }
 }
});
test('all other leave categories and on-behalf requests remain unrestricted by notice',()=>{
 for(const leaveType of ['Sick leave',"Carer's leave",'trade school'])
 for(const onBehalfOf of [true,false]) {
  assert.equal(check({leaveType,onBehalfOf}),false);
 }
});
