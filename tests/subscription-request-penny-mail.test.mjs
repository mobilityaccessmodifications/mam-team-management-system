import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { buildSubscriptionRequestPennyMailWorkflow } from '../scripts/build-subscription-request-penny-mail-workflow.mjs';
import { loadModule } from './helpers/contact-lifetime-harness.mjs';
const workflow=buildSubscriptionRequestPennyMailWorkflow({outlookCredential:{id:'synthetic-ai-outlook',name:'Synthetic AI Outlook'}});
const run=(name,input,context={})=>vm.runInNewContext('(function(){'+workflow.nodes.find(n=>n.name===name).parameters.jsCode+'})()',{
 $input:{first:()=>({json:input})},$:(name)=>({first:()=>({json:context[name]})}),$json:input,Intl,
})[0].json;
const fixture={version:2,event:'subscription-request-submitted',deliveryId:'subscription-request:b1000000-0000-4000-8000-000000000001:2',applicantName:'Synthetic Applicant',applicantWorkEmail:'applicant@example.test',approverWorkEmail:'penny@example.test',request:{formVersion:2,service:'Example <script>service</script>',plan:null,purpose:'Work & collaboration',company:'mam',duration:'ongoing',billing:'annual',currency:'AUD',quoteCents:25000,audEstimateCents:25000,noQuoteReason:null,intendedUsers:'Project team',monthlyCostCents:3000,annualCostCents:25000,comparisonUnavailableReason:null,payment:'card',cardLabel:'Synthetic company card',cardHolder:'Synthetic card holder'}};
test('Penny approval receiver uses canonical To, applicant CC, independent prices and leave theme',()=>{
 const valid=run('Validate Subscription Request',{body:fixture});assert.equal(valid.valid,true);assert.equal(valid.actualRecipient,fixture.approverWorkEmail);assert.equal(valid.ccRecipients,fixture.applicantWorkEmail);
 const mail=run('Build Subscription Email',valid);assert.match(mail.subject,/Subscription approval requested/);assert.match(mail.bodyContent,/awaiting your approval/);assert.match(mail.bodyContent,/Monthly cost:<\/strong>.*\$30\.00/);assert.match(mail.bodyContent,/Annual cost:<\/strong>.*\$250\.00/);assert.match(mail.bodyContent,/Synthetic company card/);assert.match(mail.bodyContent,/Synthetic card holder/);assert.match(mail.bodyContent,/view=people&amp;tab=tasks/);assert.match(mail.bodyContent,/background:#ef6c24/);assert.match(mail.bodyContent,/mam-logo.jpg/);assert.match(mail.bodyContent,/&lt;script&gt;/);assert.doesNotMatch(mail.bodyContent,/<script>|task is due|marketing@/);
 assert.equal(workflow.nodes.length,14);assert.ok(workflow.nodes.every(n=>n.type!=='n8n-nodes-base.scheduleTrigger'));
 const sender=workflow.nodes.find(n=>n.name==='Send Subscription Email');assert.equal(sender.parameters.toRecipients,'={{ $json.actualRecipient }}');assert.equal(sender.credentials.microsoftOutlookOAuth2Api.id,'synthetic-ai-outlook');assert.equal(sender.retryOnFail,undefined);
 assert.equal(run('Validate Subscription Request',{body:{...fixture,applicantWorkEmail:fixture.approverWorkEmail}}).ccRecipients,'');
});
test('Penny receiver rejects address injection, private fields and inconsistent approved cost comparison',()=>{
 for(const altered of [{...fixture,to:'other@example.test'},{...fixture,approverWorkEmail:'penny@example.test,other@example.test'},{...fixture,approverWorkEmail:'penny@example.test\r\nBcc:other@example.test'},{...fixture,approverWorkEmail:' Penny@example.test'},{...fixture,applicantWorkEmail:'a@example.test;b@example.test'},{...fixture,request:{...fixture.request,password:'synthetic'}},{...fixture,request:{...fixture.request,quoteCents:3000}},{...fixture,request:{...fixture.request,annualCostCents:null}},{...fixture,request:{...fixture.request,monthlyCostCents:null}},{...fixture,request:{...fixture.request,cardHolder:null}},{...fixture,request:{...fixture.request,currency:'USD'}},{...fixture,version:1}])assert.equal(run('Validate Subscription Request',{body:altered}).valid,false);
 assert.equal(run('Validate Subscription Request',{body:{...fixture,request:{...fixture.request,monthlyCostCents:null,comparisonUnavailableReason:'Only annual pricing is published'}}}).valid,true);
});
test('Penny receiver requires exact reservation and matching permanent receipt before reporting delivery',()=>{
 const valid=run('Validate Subscription Request',{body:fixture}),ctx={'Validate Subscription Request':valid};
 const reservation={outcome:'send',eventKey:fixture.deliveryId,deliveryToken:'a1000000-0000-4000-8000-000000000001'};
 assert.equal(run('Gate Subscription Delivery',reservation,ctx).shouldSend,true);
 assert.equal(run('Gate Subscription Delivery',{...reservation,eventKey:'wrong'},ctx).shouldSend,false);
 const duplicate={outcome:'duplicate',ok:true,alreadySent:true,eventKey:fixture.deliveryId,actualRecipient:fixture.approverWorkEmail,actualCcRecipients:fixture.applicantWorkEmail};
 assert.equal(run('Gate Subscription Delivery',duplicate,ctx).alreadySent,true);
 assert.equal(run('Gate Subscription Delivery',{...duplicate,actualRecipient:'marketing@example.test'},ctx).alreadySent,false);
 const mail=run('Build Subscription Email',valid),confirmed={ok:true,sent:true,eventKey:fixture.deliveryId,actualRecipient:fixture.approverWorkEmail,actualCcRecipients:fixture.applicantWorkEmail};
 assert.equal(run('Validate Subscription Confirmation',confirmed,{'Build Subscription Email':mail}).ok,true);
 assert.equal(run('Validate Subscription Confirmation',{...confirmed,actualCcRecipients:'other@example.test'},{'Build Subscription Email':mail}).ok,false);
 for(const n of workflow.nodes.filter(n=>n.type==='n8n-nodes-base.httpRequest')){assert.equal(n.parameters.options.redirect.redirect.followRedirects,false);assert.equal(n.retryOnFail,undefined);}
});
test('subscription-request reservations always use the live canonical approval guard',async()=>{
 const {handleNotificationReceipts}=loadModule('src/lib/notification-receipts.ts');
 const secret='synthetic-penny-receipt-secret'.repeat(2),token='a1000000-0000-4000-8000-000000000001';let calls=0;
 const response=await handleNotificationReceipts(new Request('https://example.test/api/internal/integrations/notifications/receipts',{method:'POST',headers:{'content-type':'application/json','x-mam-notification-secret':secret},body:JSON.stringify({action:'reserve',eventKey:fixture.deliveryId,recipient:fixture.approverWorkEmail,cc:fixture.applicantWorkEmail,legacyEventKey:null})}),secret,async(name,args)=>{calls++;assert.equal(name,'reserve_subscription_request_mail');assert.equal(args.p_recipient,fixture.approverWorkEmail);return {data:{outcome:'send',eventKey:fixture.deliveryId,deliveryToken:token},error:null};});
 assert.equal(response.status,200);assert.equal(calls,1);
});
