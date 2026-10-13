import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { buildSubscriptionRequestMailWorkflow } from '../scripts/build-subscription-request-mail-workflow.mjs';
import { loadModule } from './helpers/contact-lifetime-harness.mjs';
const workflow=buildSubscriptionRequestMailWorkflow({outlookCredential:{id:'synthetic-credential',name:'Synthetic MAM Outlook'},cronCredential:{id:'synthetic-subscription-cron',name:'Synthetic subscription-only cron'}});
const run=(name,input,context={})=>vm.runInNewContext(workflow.nodes.find(n=>n.name===name).parameters.jsCode.replace(/^/,'(function(){')+'})()',{
  $input:{first:()=>({json:input})},$:(name)=>({first:()=>({json:context[name]})}),$json:input,Intl,
})[0].json;
const fixture={version:1,event:'subscription-request-submitted',deliveryId:'subscription-request:b1000000-0000-4000-8000-000000000001:2',applicantName:'Synthetic Applicant',applicantWorkEmail:'applicant@example.test',request:{service:'Example <script>service</script>',plan:'Team',purpose:'Work & collaboration',company:'mam',duration:'12 months',billing:'monthly',currency:'AUD',quoteCents:3000,audEstimateCents:3000,noQuoteReason:null,intendedUsers:'Project team'}};
test('submission mail fixes the recipient, copies only the applicant and matches the leave theme',()=>{
 const valid=run('Validate Subscription Request',{body:fixture});assert.equal(valid.valid,true);assert.equal(valid.actualRecipient,'marketing@mobilityaccess.com.au');assert.equal(valid.ccRecipients,'applicant@example.test');
 const mail=run('Build Subscription Email',valid);assert.match(mail.bodyContent,/awaiting review/);assert.match(mail.bodyContent,/view=people&amp;tab=tasks/);assert.match(mail.bodyContent,/background:#ef6c24/);assert.match(mail.bodyContent,/mam-logo.jpg/);assert.match(mail.bodyContent,/&lt;script&gt;/);assert.doesNotMatch(mail.bodyContent,/<script>|task is due|\bDone\b/);
 const send=workflow.nodes.find(n=>n.name==='Send Subscription Email');assert.equal(send.parameters.toRecipients,'marketing@mobilityaccess.com.au');assert.equal(send.parameters.additionalFields.ccRecipients,'={{ $json.ccRecipients }}');assert.equal(send.retryOnFail,undefined);
});
test('malformed, recipient-injecting and credential-bearing mail payloads fail closed',()=>{
 for(const altered of [{...fixture,to:'other@example.test'},{...fixture,applicantWorkEmail:'a@example.test,b@example.test'},{...fixture,applicantWorkEmail:'a@example.test\r\nBcc:b@example.test'},{...fixture,request:{...fixture.request,password:'secret'}},{...fixture,event:'subscription-review-due'},{...fixture,version:2}])assert.equal(run('Validate Subscription Request',{body:altered}).valid,false);
 assert.equal(run('Validate Subscription Request',{body:{...fixture,applicantWorkEmail:'marketing@mobilityaccess.com.au'}}).ccRecipients,'');
});
test('only a matching durable reservation or matching duplicate can complete the mail path',()=>{
 const c=run('Validate Subscription Request',{body:fixture});const ctx={'Validate Subscription Request':c};
 assert.equal(run('Gate Subscription Delivery',{outcome:'send',eventKey:fixture.deliveryId,deliveryToken:'a1000000-0000-4000-8000-000000000001'},ctx).shouldSend,true);
 assert.equal(run('Gate Subscription Delivery',{outcome:'send',eventKey:'wrong',deliveryToken:'a1000000-0000-4000-8000-000000000001'},ctx).shouldSend,false);
 const duplicate={outcome:'duplicate',ok:true,alreadySent:true,eventKey:fixture.deliveryId,actualRecipient:c.actualRecipient,actualCcRecipients:c.ccRecipients};
 assert.equal(run('Gate Subscription Delivery',duplicate,ctx).alreadySent,true);assert.equal(run('Gate Subscription Delivery',{...duplicate,actualCcRecipients:'wrong@example.test'},ctx).alreadySent,false);
});
test('worker confirms only exact To/CC receipts and retains failures for retry without choosing recipients',async()=>{
 const oldFetch=globalThis.fetch;const oldOrigin=process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN;const oldSecret=process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET;
 process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN='https://n8n.example.test';process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET='synthetic-secret-for-notification-test';
 try {
  for(const mismatch of [false,true]){
   const calls=[];const admin={rpc:async(name,args)=>{calls.push({name,args});return name==='claim_subscription_request_mail'?{data:[{request_id:'b1000000-0000-4000-8000-000000000001',version:2,claim_token:'synthetic-token',payload:fixture}],error:null}:{data:true,error:null};}};
   globalThis.fetch=async(url,options)=>{assert.equal(url.href,'https://n8n.example.test/webhook/mam-subscription-request-mail-v1');assert.deepEqual(JSON.parse(options.body),fixture);return {ok:true,json:async()=>({ok:true,sent:true,deliveryId:fixture.deliveryId,actualRecipient:'marketing@mobilityaccess.com.au',actualCcRecipients:mismatch?'other@example.test':'applicant@example.test'})};};
   const worker=loadModule('src/lib/subscription-request-mail.ts',{'@/lib/supabase/admin':{createAdminClient:()=>admin}});
   const result=await worker.dispatchSubscriptionRequestMail();assert.equal(result.sent,mismatch?0:1);assert.equal(calls.filter(c=>c.name==='finish_subscription_request_mail').length,mismatch?0:1);
  }
 }finally{globalThis.fetch=oldFetch;if(oldOrigin===undefined)delete process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN;else process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN=oldOrigin;if(oldSecret===undefined)delete process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET;else process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET=oldSecret;}
});

test('mail cron accepts only its separately scoped credential',async()=>{
 const oldCron=process.env.CRON_SECRET,oldScoped=process.env.MAM_SUBSCRIPTION_REQUEST_CRON_SECRET;process.env.CRON_SECRET='synthetic-other-worker';process.env.MAM_SUBSCRIPTION_REQUEST_CRON_SECRET='synthetic-subscription-worker';let calls=0;
 try{const route=loadModule('src/app/api/cron/subscription-requests/route.ts',{'@/lib/subscription-request-mail':{dispatchSubscriptionRequestMail:async()=>{calls++;return {ok:true,claimed:0,sent:0};}}});
 for(const token of ['',process.env.CRON_SECRET])assert.equal((await route.GET(new Request('https://example.test/api/cron/subscription-requests',{headers:{authorization:'Bearer '+token}}))).status,401);
 assert.equal(calls,0);assert.equal((await route.GET(new Request('https://example.test/api/cron/subscription-requests',{headers:{authorization:'Bearer '+process.env.MAM_SUBSCRIPTION_REQUEST_CRON_SECRET}}))).status,200);assert.equal(calls,1);
 }finally{if(oldCron===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=oldCron;if(oldScoped===undefined)delete process.env.MAM_SUBSCRIPTION_REQUEST_CRON_SECRET;else process.env.MAM_SUBSCRIPTION_REQUEST_CRON_SECRET=oldScoped;}
});
