import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { Temporal } from 'temporal-polyfill';
import { createAllDayEvent, createEvent } from '@dayflow/core';
import { loadModule } from './helpers/contact-lifetime-harness.mjs';
const payload={version:1,event:'subscription-renewal-reminder',deliveryId:'subscription-renewal:b1000000-0000-4000-8000-000000000001:2026-10-22:upcoming',serviceName:'Synthetic renewal service',nextRenewalOn:'2026-10-22',phase:'upcoming',toRecipients:'delegate@example.test,penny@example.test'};
test('renewal dispatcher is independently disabled and requires matching sender evidence',async()=>{
 const names=['MAM_SUBSCRIPTION_RENEWAL_MAIL_START_ON','MAM_N8N_LEAVE_WEBHOOK_ORIGIN','MAM_N8N_LEAVE_WEBHOOK_SECRET'];
 const saved=names.map(n=>process.env[n]),fetchBefore=globalThis.fetch;
 try{
  let reads=0;
  const {dispatchSubscriptionRenewalMail}=loadModule('src/lib/subscription-renewal-mail.ts',{'@/lib/supabase/admin':{createAdminClient:()=>({rpc:async(name,args)=>{reads++;assert.equal(name,'list_subscription_renewal_mail');assert.deepEqual(args,{p_start_on:'2026-10-15',p_limit:5});return {data:[{payload}],error:null};}})}});
  delete process.env.MAM_SUBSCRIPTION_RENEWAL_MAIL_START_ON;
  assert.deepEqual(await dispatchSubscriptionRenewalMail(),{ok:true,selected:0,sent:0});assert.equal(reads,0);
  process.env.MAM_SUBSCRIPTION_RENEWAL_MAIL_START_ON='2026-10-15';process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN='https://n8n.example.test';process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET='synthetic-secret';
  globalThis.fetch=()=>assert.fail('Must not start renewal near the shared deadline');
  assert.deepEqual(await dispatchSubscriptionRenewalMail(Date.now()+1_000),{ok:false,selected:1,sent:0});
  for(const mismatch of [{}, {actualRecipient:'other@example.test'}, {deliveryId:payload.deliveryId.replace('upcoming','due')},{actualCcRecipients:'unexpected@example.test'}]){
   globalThis.fetch=async(url,options)=>{assert.equal(url.href,'https://n8n.example.test/webhook/mam-subscription-renewal-mail-v1');assert.equal(options.redirect,'error');assert.deepEqual(JSON.parse(options.body),payload);return {ok:true,json:async()=>({ok:true,sent:true,deliveryId:payload.deliveryId,actualRecipient:payload.toRecipients,actualCcRecipients:'',...mismatch})};};
   assert.equal((await dispatchSubscriptionRenewalMail()).sent,Object.keys(mismatch).length?0:1);
  }
  globalThis.fetch=async()=>{throw Error('Unknown send outcome');};assert.equal((await dispatchSubscriptionRenewalMail()).ok,false);
 }finally{globalThis.fetch=fetchBefore;names.forEach((n,i)=>{if(saved[i]===undefined)delete process.env[n];else process.env[n]=saved[i];});}
});
test('renewal receipt reserve uses the date-aware RPC without changing quarterly review routing',async()=>{
 const {handleNotificationReceipts}=loadModule('src/lib/notification-receipts.ts');const secret='synthetic-renewal-secret'.repeat(3);
 for(const phase of ['upcoming','due','daily']){
  const eventKey=payload.deliveryId.replace('upcoming',phase);let calls=0;
  const response=await handleNotificationReceipts(new Request('https://example.test/api/internal/integrations/notifications/receipts',{method:'POST',headers:{'content-type':'application/json','x-mam-notification-secret':secret},body:JSON.stringify({action:'reserve',eventKey,recipient:payload.toRecipients,cc:'',legacyEventKey:null})}),secret,async(name)=>{calls++;assert.equal(name,'reserve_subscription_renewal_mail');return {data:{outcome:'send',eventKey,deliveryToken:'a1000000-0000-4000-8000-000000000001'},error:null};});
  assert.equal(response.status,phase==='daily'?400:200);assert.equal(calls,phase==='daily'?0:1);
 }
});
test('existing authenticated cron dispatches request, quarterly review and renewal using its shared deadline',async()=>{
 const old=process.env.MAM_SUBSCRIPTION_REQUEST_CRON_SECRET;process.env.MAM_SUBSCRIPTION_REQUEST_CRON_SECRET='synthetic-cron';
 const calls=[],report={ok:true,selected:0,sent:0};
 try{
  const route=loadModule('src/app/api/cron/subscription-requests/route.ts',{
   '@/lib/subscription-request-mail':{dispatchSubscriptionRequestMail:async()=>{calls.push(['request']);return report;}},
   '@/lib/subscription-review-mail':{dispatchSubscriptionReviewMail:async(deadline)=>{calls.push(['review',deadline]);return report;}},
   '@/lib/subscription-renewal-mail':{dispatchSubscriptionRenewalMail:async(deadline)=>{calls.push(['renewal',deadline]);return report;}},
  });
  assert.equal((await route.GET(new Request('https://example.test/api/cron/subscription-requests'))).status,401);assert.equal(calls.length,0);
  const result=await route.GET(new Request('https://example.test/api/cron/subscription-requests',{headers:{authorization:'Bearer synthetic-cron'}}));
  assert.equal(result.status,200);assert.deepEqual(calls.map(c=>c[0]),['request','review','renewal']);assert.equal(calls[1][1],calls[2][1]);assert.deepEqual(await result.json(),{ok:true,submissions:report,reviews:report,renewals:report});
 }finally{if(old===undefined)delete process.env.MAM_SUBSCRIPTION_REQUEST_CRON_SECRET;else process.env.MAM_SUBSCRIPTION_REQUEST_CRON_SECRET=old;}
});
test('real DayFlow renewal calendar uses its own date and layer, with no financial or credential payload',()=>{
 const file='src/components/team-calendar.tsx',source=readFileSync(file,'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const needed=new Set(['isLeapYear','birthdayDate','formatDate','formatDateRange','milestoneLabel','createMAMEvent','buildEvents']);
 const snippets=ast.statements.filter(s=>ts.isFunctionDeclaration(s)&&needed.has(s.name?.text)).map(s=>s.getText(ast));
 const compiled=ts.transpileModule(snippets.join('\n')+'\nexports.buildEvents=buildEvents;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const exports={};new Function('exports','createAllDayEvent','createEvent','Temporal','getVictorianPublicHolidays','timeZone','BALANCE_PENDING_STATUS','leaveColors',compiled)(exports,createAllDayEvent,createEvent,Temporal,()=>[],'Australia/Melbourne','Approved – pending leave balance',[]);
 const common={subscriptionId:'b1000000-0000-4000-8000-000000000001',serviceName:'Synthetic renewal service',status:'active'};
 const events=exports.buildEvents([],[],[],[{...common,dueDate:'2027-01-04'}],[],[2026,2027],[{...common,dueDate:'2026-10-22'}]);
 const renewal=events.find(e=>e.calendarId==='subscription-renewal'),review=events.find(e=>e.calendarId==='subscription');
 assert.ok(renewal&&review);assert.equal(renewal.start.toString(),'2026-10-22');assert.equal(review.start.toString(),'2027-01-04');assert.equal(renewal.meta.subscriptionId,common.subscriptionId);
 assert.match(renewal.title,/Subscription renewal/);assert.match(review.title,/Subscription review/);assert.deepEqual(Object.keys(renewal.meta).sort(),['dateLabel','detail','kind','priority','subject','subscriptionId']);
});
