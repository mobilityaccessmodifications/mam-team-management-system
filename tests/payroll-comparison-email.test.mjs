import test from 'node:test';
import assert from 'node:assert/strict';
import {prepare,confirmDelivery} from './notification-workflow-harness.mjs';
const batchId='10000000-0000-4000-8000-000000000001';
const payload={version:1,event:'payroll-comparison-alert',batchId,eventKey:`payroll-comparison:${batchId}`,differenceCount:2};
const run=(body=payload,state={})=>prepare(body,state);
test('comparison alerts go only to Marketing and contain no employee balances',()=>{
 const result=run();assert.equal(result.outcome,'send');assert.equal(result.deliveryRecipient,'marketing@mobilityaccess.com.au');assert.equal(result.ccRecipients,'');assert(result.emailHtml.includes('2 leave balance differences'));assert(result.emailHtml.includes('have not been changed'));
});
test('comparison alerts reject injected recipients, invalid counts and duplicate delivery',()=>{
 for(const extra of [{recipient:'attacker@example.test'},{differenceCount:0},{differenceCount:2001},{eventKey:'different'}])assert.equal(run({...payload,...extra}).outcome,'rejected');
 const state={};const source=run(payload,state);
 confirmDelivery(source,[{json:{statusCode:202}}],state);
 assert.equal(run(payload,state).outcome,'duplicate');
 const legacy=run(payload,{leaveNotificationEvents:{[payload.eventKey]:{state:'sent',at:Date.now()}}});
 assert.equal(legacy.rejectionCode,'receipt-evidence-unavailable');assert.equal(legacy.actualRecipient,undefined);
});
