import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { buildSubscriptionReviewMailWorkflow } from '../scripts/build-subscription-review-mail-workflow.mjs';
import { loadModule } from './helpers/contact-lifetime-harness.mjs';
const workflow=buildSubscriptionReviewMailWorkflow({outlookCredential:{id:'synthetic-ai-outlook',name:'Synthetic AI Outlook'}});
const run=(name,input,context={})=>vm.runInNewContext('(function(){'+workflow.nodes.find(n=>n.name===name).parameters.jsCode+'})()',{
 $input:{first:()=>({json:input})},$:(name)=>({first:()=>({json:context[name]})}),$json:input,Intl,
})[0].json;
const fixture={version:1,event:'subscription-review-reminder',deliveryId:'subscription-review:b1000000-0000-4000-8000-000000000001:2026-10-21:upcoming',serviceName:'Synthetic <script>service</script>',nextReviewOn:'2026-10-21',phase:'upcoming',toRecipients:'delegate@example.test,penny@example.test'};
test('review mail uses canonical database recipients, shared theme, AI sender and Tasks link',()=>{
 const valid=run('Validate Subscription Review',{body:fixture});assert.equal(valid.valid,true);assert.equal(valid.actualRecipient,fixture.toRecipients);assert.equal(valid.ccRecipients,'');
 const mail=run('Build Subscription Email',valid);assert.match(mail.bodyContent,/quarterly review/);assert.match(mail.bodyContent,/21 Oct 2026/);assert.match(mail.bodyContent,/mark the review Done/);assert.match(mail.bodyContent,/view=people&amp;tab=tasks/);assert.match(mail.bodyContent,/background:#ef6c24/);assert.match(mail.bodyContent,/mam-logo.jpg/);assert.match(mail.bodyContent,/&lt;script&gt;/);assert.doesNotMatch(mail.bodyContent,/<script>|task is due|request has been submitted/);
 const sender=workflow.nodes.find(n=>n.name==='Send Subscription Email');assert.equal(sender.parameters.toRecipients,'={{ $json.actualRecipient }}');assert.equal(sender.credentials.microsoftOutlookOAuth2Api.id,'synthetic-ai-outlook');assert.equal(sender.retryOnFail,undefined);
 assert.ok(workflow.nodes.every(n=>n.type!=='n8n-nodes-base.scheduleTrigger'));
});
test('review receiver rejects wrong phase/date, extra private fields and recipient injection',()=>{
 for(const altered of [{...fixture,password:'synthetic'},{...fixture,phase:'due'},{...fixture,nextReviewOn:'2026-10-20'},{...fixture,event:'subscription-request-submitted'},{...fixture,toRecipients:'penny@example.test,delegate@example.test'},{...fixture,toRecipients:'delegate@example.test,delegate@example.test'},{...fixture,toRecipients:'delegate@example.test\r\nBcc:other@example.test'}])assert.equal(run('Validate Subscription Review',{body:altered}).valid,false);
});
test('review sender requires an exact permanent reservation and an exact matching confirmation',()=>{
 const valid=run('Validate Subscription Review',{body:fixture}),ctx={'Validate Subscription Review':valid};
 const reservation={outcome:'send',eventKey:fixture.deliveryId,deliveryToken:'a1000000-0000-4000-8000-000000000001'};
 assert.equal(run('Gate Subscription Delivery',reservation,ctx).shouldSend,true);
 assert.equal(run('Gate Subscription Delivery',{...reservation,eventKey:'wrong'},ctx).shouldSend,false);
 const duplicate={outcome:'duplicate',ok:true,alreadySent:true,eventKey:fixture.deliveryId,actualRecipient:fixture.toRecipients,actualCcRecipients:''};
 assert.equal(run('Gate Subscription Delivery',duplicate,ctx).alreadySent,true);
 assert.equal(run('Gate Subscription Delivery',{...duplicate,actualRecipient:'other@example.test'},ctx).alreadySent,false);
 const mail=run('Build Subscription Email',valid),confirmed={ok:true,sent:true,eventKey:fixture.deliveryId,actualRecipient:fixture.toRecipients,actualCcRecipients:''};
 assert.equal(run('Validate Subscription Confirmation',confirmed,{'Build Subscription Email':mail}).ok,true);
 assert.equal(run('Validate Subscription Confirmation',{...confirmed,actualCcRecipients:'other@example.test'},{'Build Subscription Email':mail}).ok,false);
 for(const n of workflow.nodes.filter(n=>n.type==='n8n-nodes-base.httpRequest')){assert.equal(n.parameters.options.redirect.redirect.followRedirects,false);assert.equal(n.retryOnFail,undefined);}
});
test('review dispatch stays disabled without a start date and accepts only exact provider proof',async()=>{
 const oldFetch=globalThis.fetch,names=['MAM_SUBSCRIPTION_REVIEW_MAIL_START_ON','MAM_N8N_LEAVE_WEBHOOK_ORIGIN','MAM_N8N_LEAVE_WEBHOOK_SECRET'],saved=names.map(n=>process.env[n]);
 try{
  let reads=0;const worker=loadModule('src/lib/subscription-review-mail.ts',{'@/lib/supabase/admin':{createAdminClient:()=>({rpc:async(name,args)=>{reads++;assert.equal(name,'list_subscription_review_mail');assert.deepEqual(args,{p_start_on:'2026-10-14',p_limit:5});return {data:[{payload:fixture}],error:null};}})}});
  delete process.env.MAM_SUBSCRIPTION_REVIEW_MAIL_START_ON;
  assert.deepEqual(await worker.dispatchSubscriptionReviewMail(),{ok:true,selected:0,sent:0});assert.equal(reads,0);
  process.env.MAM_SUBSCRIPTION_REVIEW_MAIL_START_ON='2026-10-14';process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN='https://n8n.example.test';process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET='synthetic-secret';
  globalThis.fetch=async()=>{throw Error('No send should start near the cron deadline');};
  assert.deepEqual(await worker.dispatchSubscriptionReviewMail(Date.now()+1_000),{ok:false,selected:1,sent:0});
  for(const mismatch of [false,true]){
   globalThis.fetch=async(url,options)=>{assert.equal(url.href,'https://n8n.example.test/webhook/mam-subscription-review-mail-v1');assert.equal(options.redirect,'error');assert.deepEqual(JSON.parse(options.body),fixture);return {ok:true,json:async()=>({ok:true,sent:true,deliveryId:fixture.deliveryId,actualRecipient:mismatch?'other@example.test':fixture.toRecipients,actualCcRecipients:''})};};
   assert.equal((await worker.dispatchSubscriptionReviewMail()).sent,mismatch?0:1);
  }
  globalThis.fetch=async()=>{throw Error('synthetic uncertain network outcome');};
  assert.equal((await worker.dispatchSubscriptionReviewMail()).ok,false);
 }finally{globalThis.fetch=oldFetch;names.forEach((n,i)=>{if(saved[i]===undefined)delete process.env[n];else process.env[n]=saved[i];});}
});
test('receipt API admits only bounded review date and phase keys',async()=>{
 const {handleNotificationReceipts}=loadModule('src/lib/notification-receipts.ts');
 const secret='synthetic-review-receipt-secret'.repeat(2),token='a1000000-0000-4000-8000-000000000001';
 for(const suffix of ['2026-10-21:upcoming','2026-10-21:due','2026-13-21:due','2026-10-00:due','2026-10-21:daily']){
  const key='subscription-review:b1000000-0000-4000-8000-000000000001:'+suffix;let calls=0;
  const response=await handleNotificationReceipts(new Request('https://example.test/api/internal/integrations/notifications/receipts',{method:'POST',headers:{'content-type':'application/json','x-mam-notification-secret':secret},body:JSON.stringify({action:'reserve',eventKey:key,recipient:fixture.toRecipients,cc:'',legacyEventKey:null})}),secret,async(name)=>{calls++;assert.equal(name,'reserve_subscription_review_mail');return {data:{outcome:'send',eventKey:key,deliveryToken:token},error:null};});
  const valid=['2026-10-21:upcoming','2026-10-21:due'].includes(suffix);assert.equal(response.status,valid?200:400);assert.equal(calls,valid?1:0);
 }
});
