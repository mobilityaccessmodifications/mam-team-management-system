import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const validator=new Function('$input','$getWorkflowStaticData',fs.readFileSync('workflows/leave-notification-validator.n8n.txt','utf8'));
const batchId='10000000-0000-4000-8000-000000000001';
const payload={version:1,event:'payroll-comparison-alert',batchId,eventKey:`payroll-comparison:${batchId}`,differenceCount:2};
const run=(body=payload,state={})=>validator({first:()=>({json:{headers:{'content-type':'application/json'},body}})},()=>state)[0].json;
test('comparison alerts go only to Marketing and contain no employee balances',()=>{
 const result=run();assert.equal(result.outcome,'send');assert.equal(result.deliveryRecipient,'marketing@mobilityaccess.com.au');assert.equal(result.ccRecipients,'');assert(result.emailHtml.includes('2 leave balance differences'));assert(result.emailHtml.includes('have not been changed'));
});
test('comparison alerts reject injected recipients, invalid counts and duplicate delivery',()=>{
 for(const extra of [{recipient:'attacker@example.test'},{differenceCount:0},{differenceCount:2001},{eventKey:'different'}])assert.equal(run({...payload,...extra}).outcome,'rejected');
 assert.equal(run(payload,{leaveNotificationEvents:{[payload.eventKey]:{state:'sent',at:Date.now()}}}).outcome,'duplicate');
});
