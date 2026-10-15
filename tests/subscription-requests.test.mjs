import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
function load() {
  assert.ok(existsSync('src/lib/subscription-request-types.ts'), 'Request form validation is not implemented');
  const loaded = { exports: {} };
  new Function('module','exports',ts.transpileModule(readFileSync('src/lib/subscription-request-types.ts','utf8'), { compilerOptions: { module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022 } }).outputText)(loaded,loaded.exports);
  return loaded.exports;
}
export const payload = { kind:'new_purchase', service:'Synthetic Service', plan:'Team', purpose:'Synthetic project work', company:'mam', payer:'MAM', duration:'12 months', billing:'annual', currency:'USD', tax:'Exclusive', quoteCents:12000, noQuoteReason:'', audEstimateCents:18000, payment:'card', cardLabel:'Synthetic business card', cardHolder:'Synthetic holder', responsiblePersonId:null, intendedUsers:'Project team' };
test('request submission validates distinct original currency, estimate and payment fields', () => {
  const { validateRequestPayload } = load();
  assert.deepEqual(validateRequestPayload(payload,true),payload);
  assert.throws(()=>validateRequestPayload({...payload,cardHolder:''},true),/card/i);
  assert.throws(()=>validateRequestPayload({...payload,quoteCents:null},true),/quote/i);
  assert.throws(()=>validateRequestPayload({...payload,quoteCents:null,noQuoteReason:'Supplier quote pending',audEstimateCents:null},true),/AUD/i);
  assert.throws(()=>validateRequestPayload({...payload,password:'forbidden'},true),/field/i);
  assert.throws(()=>validateRequestPayload({...payload,quoteCents:-1},true),/amount/i);
  assert.deepEqual(validateRequestPayload({},false),{});
});
test('simplified request compares independent AUD prices and locks the chosen quote', () => {
  const { validateRequestPayload } = load();
  const simple={formVersion:2,kind:'new_purchase',service:'Synthetic Service',purpose:'Work',company:'equipsy',duration:'ongoing',billing:'annual',currency:'AUD',monthlyCostCents:1200,annualCostCents:10000,quoteCents:10000,audEstimateCents:10000,payment:'card',cardLabel:'Synthetic card',cardHolder:'Synthetic holder',intendedUsers:'Synthetic team'};
  assert.deepEqual(validateRequestPayload(simple,true),simple);
  assert.throws(()=>validateRequestPayload({...simple,quoteCents:14400},true),/billing cost/i);
  assert.throws(()=>validateRequestPayload({...simple,monthlyCostCents:null},true),/alternative/i);
  assert.doesNotThrow(()=>validateRequestPayload({...simple,monthlyCostCents:null,comparisonUnavailableReason:'Annual only'},true));
  assert.throws(()=>validateRequestPayload({...simple,annualCostCents:null},true),/selected/i);
  for(const extra of [{requestedBy:'Other person'},{password:'forbidden'},{currency:'USD'},{duration:'Forever'},{kind:'renewal'},{service:'x'.repeat(161)}])assert.throws(()=>validateRequestPayload({...simple,...extra},true));
});

export const templatePayload={formVersion:3,kind:'new_purchase',service:'Synthetic Tool',purpose:'Project work',company:'mam',duration:'ongoing',billing:'annual',currency:'AUD',monthlyCostCents:1200,annualCostCents:10000,oneOffCostCents:2500,quoteCents:10000,audEstimateCents:10000,payment:'invoice',intendedUsers:'Synthetic team',websiteUrl:'https://example.test/product',category:'software_app',usageFrequency:'Daily',invoiceEmail:'accounts@example.test',invoiceContact:'Synthetic accounts'};
test('template request keeps upfront and recurring costs separate and supports standalone purchases',()=>{
  const {validateRequestPayload}=load();
  assert.deepEqual(validateRequestPayload(templatePayload,true),templatePayload);
  assert.throws(()=>validateRequestPayload({...templatePayload,quoteCents:12500,audEstimateCents:12500},true),/billing cost/);
  const oneOff={...templatePayload,billing:'one_off',monthlyCostCents:null,annualCostCents:null,quoteCents:2500,audEstimateCents:2500,category:'hardware'};
  assert.deepEqual(validateRequestPayload(oneOff,true),oneOff);
  assert.throws(()=>validateRequestPayload({...oneOff,oneOffCostCents:0,quoteCents:0,audEstimateCents:0},true),/cost/);
  for(const extra of [{category:''},{category:'unknown'},{websiteUrl:'javascript:alert(1)'},{websiteUrl:'https://user:secret@example.test'},{websiteUrl:'https://example.test/ space'},{invoiceEmail:'invalid'},{approvedByName:'Synthetic'},{budgetApproved:true},{requestedBy:'Synthetic'},{password:'forbidden'},{oneOffCostCents:0.5}])assert.throws(()=>validateRequestPayload({...templatePayload,...extra},true));
  assert.throws(()=>validateRequestPayload({...templatePayload,formVersion:2},true),/field/);
});
test('finance approval requires an explicit budget decision and rejects forged actor metadata',()=>{
  const {validateRequestFinance}=load();
  const finance={budgetApproved:true,invoiceEmail:'accounts@example.test',invoiceContact:'Synthetic accounts'};
  assert.deepEqual(validateRequestFinance(finance,'approve'),finance);
  assert.deepEqual(validateRequestFinance({budgetApproved:false},'return'),{budgetApproved:false});
  for(const value of [{budgetApproved:false},{budgetApproved:'yes'},{...finance,approvedByName:'Forged'},{...finance,approvedAt:'2026-01-01'},{...finance,invoiceEmail:'invalid'},{...finance,invoiceContact:'x'.repeat(161)}])assert.throws(()=>validateRequestFinance(value,'approve'));
});
