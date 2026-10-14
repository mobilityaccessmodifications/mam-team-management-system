import test from 'node:test';
import assert from 'node:assert/strict';
import {loadModule} from './helpers/contact-lifetime-harness.mjs';

test('AUD entry retains cents without float rounding or inventing annual quotes',()=>{
  const {parseRequestAmount,formatRequestAmount,withSelectedRequestCost}=loadModule('src/lib/subscription-request-form.ts');
  for(const [value,cents] of [['',null],['0',0],['12.',1200],['12.3',1230],['12.34',1234],['0.29',29],['1000000.00',100000000]])assert.equal(parseRequestAmount(value),cents);
  for(const value of ['-1','12.345','1e3','NaN','1,000','1000000.01'])assert.throws(()=>parseRequestAmount(value));
  assert.equal(formatRequestAmount(29),'0.29');assert.equal(formatRequestAmount(null),'');
  assert.deepEqual(withSelectedRequestCost({billing:'annual',monthlyCostCents:1200,annualCostCents:10000}),{billing:'annual',monthlyCostCents:1200,annualCostCents:10000,quoteCents:10000,audEstimateCents:10000});
  assert.equal(withSelectedRequestCost({billing:'annual',monthlyCostCents:1200}).quoteCents,null);
});
