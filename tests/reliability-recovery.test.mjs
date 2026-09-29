import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadAssetQrModule } from './asset-qr-test-loader.mjs';
import test from 'node:test';
const require = createRequire(import.meta.url);
const ts = require('typescript');
function load(file, imports) {
  const js = ts.transpileModule(readFileSync(file,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const mod = {exports:{}};
  new Function('require','module','exports',js)((id)=>id in imports ? imports[id] : require(id),mod,mod.exports);
  return mod.exports;
}
const checkInAck = load('src/lib/check-in-delivery-ack.ts', {});
const id='10000000-0000-4000-8000-000000000001';
const path=`${id}/${id}.csv`;
test('archive cleanup resumes after storage deletion succeeds but database finalisation fails',async()=>{
  let deleted=false,finished=false,completeCalls=0;
  const admin={storage:{from:()=>({remove:async()=>{const data=deleted?[]:[{name:path}];deleted=true;return {data,error:null};},list:async()=>({data:[],error:null})})},rpc:async(name)=>{
    if(name==='list_expired_payroll_balance_source_archives') return {data:finished?[]:[{archive_id:id,storage_path:path,was_uploaded:true}],error:null};
    if(name==='complete_payroll_balance_source_archive_deletion'){completeCalls++;if(completeCalls===1)return {error:{message:'temporary database outage'}};finished=true;return {data:1,error:null};}
    return {data:name==='list_stale_leave_attachment_orphans'?[]:0,error:null};
  }};
  const {runLeaveAttachmentMaintenance:run}=load('src/lib/leave-attachment-maintenance.ts',{'server-only':{},'@/lib/supabase/admin':{createAdminClient:()=>admin}});
  await assert.rejects(run(),/finalised/);
  const result=await run();assert.equal(result.prunedPayrollArchiveRecords,1);assert.equal(completeCalls,2);
});
test('archive cleanup does not treat permission errors or an existing file as successful deletion',async()=>{
  for(const probe of [{data:null,error:{status:403}},{data:null,error:{status:400}},{data:[{name:`${id}.csv`}],error:null}]){
    let finalised=false;
    const admin={storage:{from:()=>({remove:async()=>({data:[],error:null}),list:async()=>probe})},rpc:async(name)=>{
      if(name==='list_stale_leave_attachment_orphans')return {data:[],error:null};
      if(name==='list_expired_payroll_balance_source_archives')return {data:[{archive_id:id,storage_path:path,was_uploaded:true}],error:null};
      finalised=true;return {data:1,error:null};
    }};
    const {runLeaveAttachmentMaintenance:run}=load('src/lib/leave-attachment-maintenance.ts',{'server-only':{},'@/lib/supabase/admin':{createAdminClient:()=>admin}});
    await assert.rejects(run(),/incomplete/);assert.equal(finalised,false);
  }
});
test('check-in network failures and failed acknowledgements surface as retryable HTTP failures',async()=>{
  const oldDate=globalThis.Date,oldFetch=globalThis.fetch,oldEnv={...process.env};
  globalThis.Date=class extends oldDate{constructor(...args){super(...(args.length?args:['2026-09-21T00:00:00Z']));}};
  Object.assign(process.env,{CRON_SECRET:'synthetic-only',CHECK_IN_EMAIL_MODE:'marketing-test',N8N_CHECKIN_REMINDER_WEBHOOK_SECRET:'synthetic',N8N_CHECKIN_REMINDER_WEBHOOK_ORIGIN:'https://synthetic.example',N8N_CHECKIN_REMINDER_WEBHOOK_URL:'https://synthetic.example/hook'});
  try{
    for(const scenario of ['network','completion','retry-write']){
      const calls=[];
      const admin={rpc:async(name)=>{calls.push(name);
        if(name==='claim_due_employee_check_in_reminders')return {data:[{reminder_id:id,claim_token:id}],error:null};
        if(name==='prepare_employee_check_in_reminder_delivery')return {data:[{reminder_id:id,employee_first_name:'Test',employee_last_name:'Person',employee_work_email:'test@example.test',employee_personal_email:'home@example.test',role:'Test',department:'Test',manager_name:'Test Manager',manager_email:'manager@example.test',milestone:'2_week',reminder_sequence:'initial',due_date:'2026-09-28',notify_date:'2026-09-21'}],error:null};
        if(name==='claim_due_employee_check_in_review_notifications')return {data:[],error:null};
        return {data:false,error:scenario==='retry-write'?{message:'offline'}:null};
      }};
      globalThis.fetch=async(_url,options)=>{if(scenario!=='completion')throw new Error('offline');const payload=JSON.parse(options.body);assert.equal(payload.mode,'test');assert.equal(payload.employee.workEmail,'test@example.test');return Response.json({ok:true,sent:true,alreadySent:false,deliveryId:`checkin:${id}:2-week:initial:test`});};
      const {GET}=load('src/app/api/cron/check-in-reminders/route.ts',{'@/lib/check-in-delivery-ack':checkInAck,'@/lib/supabase/admin':{createAdminClient:()=>admin},'@/lib/check-in-register':{getCheckInResourceLinks:()=>({managerGuideUrl:'https://synthetic.example/guide',checkInFormUrl:'https://synthetic.example/form',probationTemplatesUrl:'https://synthetic.example/templates'})}});
      const response=await GET(new Request('https://synthetic.example/cron',{headers:{authorization:'Bearer synthetic-only'}}));
      assert.equal(response.status,503);assert.equal((await response.json()).ok,false);
      assert.ok(calls.includes(scenario==='completion'?'complete_employee_check_in_reminder_delivery':'fail_employee_check_in_reminder_delivery'));
    }
  }finally{globalThis.Date=oldDate;globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in oldEnv))delete process.env[k];Object.assign(process.env,oldEnv);}
});

test('check-in worker delivers a recipient-free People & Culture escalation through the durable queue',async()=>{
  const oldDate=globalThis.Date,oldFetch=globalThis.fetch,oldEnv={...process.env};
  globalThis.Date=class extends oldDate{constructor(...args){super(...(args.length?args:['2026-09-21T00:00:00Z']));}};
  Object.assign(process.env,{CRON_SECRET:'synthetic-only',CHECK_IN_EMAIL_MODE:'marketing-test',N8N_CHECKIN_REMINDER_WEBHOOK_SECRET:'synthetic',N8N_CHECKIN_REMINDER_WEBHOOK_ORIGIN:'https://synthetic.example',N8N_CHECKIN_REMINDER_WEBHOOK_URL:'https://synthetic.example/hook'});
  const notificationId='30000000-0000-4000-8000-000000000001';
  const reviewId='40000000-0000-4000-8000-000000000001';
  const claimToken='50000000-0000-4000-8000-000000000001';
  const calls=[];
  try{
    const admin={rpc:async(name,args)=>{calls.push({name,args});
      if(name==='claim_due_employee_check_in_reminders')return {data:[],error:null};
      if(name==='claim_due_employee_check_in_review_notifications')return {data:[{notification_id:notificationId,claim_token:claimToken}],error:null};
      if(name==='prepare_employee_check_in_review_notification_delivery')return {data:[{notification_id:notificationId,review_id:reviewId,review_version:2,employee_name:'Test Person',manager_name:'Test Manager',milestone:'5_month',review_date:'2026-09-20',notes:'HR review requested.'}],error:null};
      if(name==='complete_employee_check_in_review_notification_delivery')return {data:true,error:null};
      throw new Error('Unexpected RPC '+name);
    }};
    globalThis.fetch=async(_url,options)=>{
      const payload=JSON.parse(options.body);
      const deliveryId='checkin-review:'+reviewId+':hr:2:test';
      assert.equal(options.headers['Idempotency-Key'],deliveryId);
      assert.equal(payload.event,'checkin-review-escalation');
      assert.equal(payload.deliveryId,deliveryId);
      assert.equal(Object.hasOwn(payload,'recipient'),false);
      assert.equal(Object.hasOwn(payload,'email'),false);
      return Response.json({ok:true,sent:true,alreadySent:false,deliveryId});
    };
    const {GET}=load('src/app/api/cron/check-in-reminders/route.ts',{'@/lib/check-in-delivery-ack':checkInAck,'@/lib/supabase/admin':{createAdminClient:()=>admin},'@/lib/check-in-register':{getCheckInResourceLinks:()=>({managerGuideUrl:'https://synthetic.example/guide',checkInFormUrl:'https://synthetic.example/form',probationTemplatesUrl:'https://synthetic.example/templates'})}});
    const response=await GET(new Request('https://synthetic.example/cron',{headers:{authorization:'Bearer synthetic-only'}}));
    const body=await response.json();
    assert.equal(response.status,200);
    assert.equal(body.ok,true);
    assert.equal(body.reviewNotifications.sent,1);
    assert.ok(calls.some(call=>call.name==='complete_employee_check_in_review_notification_delivery'
      && call.args.p_notification_id===notificationId
      && call.args.p_claim_token===claimToken
      && call.args.p_provider_delivery_id==='checkin-review:'+reviewId+':hr:2:test'));
  }finally{globalThis.Date=oldDate;globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in oldEnv))delete process.env[k];Object.assign(process.env,oldEnv);}
});

test('independent recovery credential permits only the five leased delivery workers',async()=>{
  const prior={recovery:process.env.MAM_BACKGROUND_RECOVERY_SECRET,cron:process.env.CRON_SECRET};
  process.env.MAM_BACKGROUND_RECOVERY_SECRET='synthetic-recovery';process.env.CRON_SECRET='synthetic-primary';
  const calls=[];
  const worker=async(request)=>{assert.equal(request.headers.get('authorization'),'Bearer synthetic-primary');calls.push(1);return Response.json({ok:true});};
  const {GET}=load('src/app/api/cron/recovery/route.ts',{
    '../leave-notifications/route':{GET:worker},'../check-in-reminders/route':{GET:worker},'../leave-priority-reminders/route':{GET:worker},
    '../new-starter-day-one/route':{GET:worker},'../onboarding-credentials/route':{GET:worker},
  });
  const request=(job,token='synthetic-recovery')=>new Request(`https://synthetic.example/recovery?job=${job}`,{headers:{authorization:`Bearer ${token}`}});
  try{
    assert.equal((await GET(request('leave-notifications','wrong'))).status,401);
    for(const name of ['leave-attachment-cleanup','constructor','__proto__','https://attacker.example'])assert.equal((await GET(request(name))).status,400);
    assert.equal(calls.length,0);
    for(const name of ['leave-notifications','check-in-reminders','new-starter-day-one','onboarding-credentials','leave-priority-reminders'])assert.equal((await GET(request(name))).status,200);
    assert.equal(calls.length,5);
  }finally{
    for(const [key,value] of [['MAM_BACKGROUND_RECOVERY_SECRET',prior.recovery],['CRON_SECRET',prior.cron]]){
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  }
});

test('Outlook CC expression produces no invalid blank recipient',()=>{
  const script=readFileSync('scripts/deploy-reliability-workflows.py','utf8');
  const expression=script.match(/CC_EXPRESSION = "=\{\{ (.*?) \}\}"/)[1];
  const evaluate=new Function('$json',`return (${expression})`);
  assert.deepEqual(evaluate({ccRecipients:''}),[]);
  assert.deepEqual(evaluate({}),[]);
  assert.deepEqual(evaluate({ccRecipients:'hr@example.test, accounts@example.test'}),['hr@example.test','accounts@example.test']);
});

test('recovery reaches its bearer-authenticated handler without a browser session or Supabase cookie refresh',async()=>{
  const {proxy}=load('src/proxy.ts',{
    '@/lib/asset-qr':loadAssetQrModule(),
    '@supabase/ssr':{createServerClient:()=>{throw new Error('Recovery must not depend on cookie refresh');}},
    'next/server':{NextResponse:{next:()=>({status:200}),redirect:()=>({status:307})}},
    '@/lib/supabase/config':{isSupabaseConfigured:()=>false,requireSupabaseConfig:()=>{throw new Error('Unexpected browser configuration');}},
  });
  const request=(pathname)=>({nextUrl:{pathname,clone:()=>new URL(`https://synthetic.example${pathname}`)}});
  assert.equal((await proxy(request('/api/cron/recovery'))).status,200);
  for(const path of ['/api/cron/recovery/other','/api/cron/not-authorised','/'])assert.equal((await proxy(request(path))).status,307);
});
test('manual recovery runs only trusted main code in its branch-restricted credential environment',()=>{
  const workflow=readFileSync('.github/workflows/background-recovery.yml','utf8');
  assert.match(workflow,/if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow,/environment: people-hub-production/);
  assert.match(workflow,/ref: main/);
  assert.match(workflow,/persist-credentials: false/);
});
