import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import {executeGraph} from './performance-review-n8n-runner.mjs';

const nativeRequire=createRequire(import.meta.url);
const id='730f0200-0000-4000-8000-000000000003';
const token='730f0200-0000-4000-8000-000000000004';
const recipient=['core1','core2','core3','core4','core5','manager'].map(v=>v+'@example.invalid').sort().join(',');
const secret='synthetic-notification-secret-0123456789abcdef';
const base='https://mam-team-management-system-ten.vercel.app';
function payload(event='onboarding') {return {version:1,event,eventKey:`employee-lifecycle:${id}:${event}`,personId:id,deliveryId:id,claimToken:token,recipient,
  employee:{name:'Synthetic <Employee>',company:'MAM',role:'Installer',department:'Warehouse',location:'Australia',employmentType:'Full-time',startDate:'2026-11-02',endDate:event==='offboarding'?'2026-11-30':null}};}
const provider={accepted:true,messageId:null,requestId:null,statusCode:202};
const receipt=(p,duplicate=false)=>({...(duplicate?{outcome:'duplicate'}:{}),ok:true,sent:!duplicate,alreadySent:duplicate,eventKey:p.eventKey,actualRecipient:p.recipient,actualCcRecipients:'',providerReceipt:provider});
const builder=spawnSync('python3',['-B','scripts/build-employee-lifecycle-workflow.py'],{encoding:'utf8'});
assert.equal(builder.status,0,builder.stderr);
const workflow=JSON.parse(builder.stdout);
function graph(p,{reserve,send,confirm}={}) {
  const calls=[];
  return {calls,run:()=>executeGraph(workflow,'Receive Lifecycle Notification',{body:p},async(n,body)=>{
    calls.push({name:n.name,body});
    if(n.name==='Reserve Notification Delivery') return reserve??{statusCode:200,body:{outcome:'send',eventKey:p.eventKey,deliveryToken:token}};
    if(n.name==='Send Lifecycle Notification') {if(send===null) throw Error('synthetic timeout');return send??{statusCode:202,body:''};}
    return confirm??{statusCode:200,body:receipt(p)};
  })};
}
function harness({env={},rpc=()=>({data:[],error:null}),fetch:transport=()=>{throw Error('No transport');}}={}) {
  const cache=new Map(),calls=[],requests=[],afters=[];
  const vars={VERCEL_ENV:'production',MAM_N8N_LEAVE_WEBHOOK_ORIGIN:'https://n8n.srv1866578.hstgr.cloud',MAM_N8N_LEAVE_WEBHOOK_SECRET:secret,CRON_SECRET:secret,...env};
  function load(file) {
    if(cache.has(file))return cache.get(file).exports;
    assert.ok(['src/lib/employee-lifecycle-mail.ts','src/lib/performance-review-mail-policy.ts','src/lib/notification-receipts.ts','src/app/api/cron/employee-lifecycle/route.ts'].includes(file));
    const mod={exports:{}};cache.set(file,mod);
    const source=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    new Function('require','module','exports','process','fetch',source)(name=>{
      if(name==='server-only')return {};
      if(name==='next/server')return {after:cb=>afters.push(cb)};
      if(name==='@/lib/supabase/admin')return {createAdminClient:()=>({rpc:(name,args)=>{calls.push({name,args});const op=Promise.resolve().then(()=>rpc(name,args));op.retry=value=>{assert.equal(value,false);return op;};op.abortSignal=()=>op;return op;}})};
      if(name.startsWith('@/'))return load('src/'+name.slice(2)+'.ts');
      assert.equal(name,'node:crypto');return nativeRequire(name);
    },mod,mod.exports,{env:vars},async(url,options)=>{requests.push({url,options});return transport(url,options);});
    return mod.exports;
  }
  return {load,calls,requests,afters};
}

test('both approved templates send one HTML message to exact six recipients after durable reservation',async()=>{
  for(const event of ['onboarding','offboarding']) {
    const p=payload(event),h=graph(p),result=await h.run();
    assert.deepEqual(result.value,receipt(p));assert.equal(h.calls.length,3);
    const mail=h.calls[1].body.message;
    assert.equal(mail.toRecipients.map(r=>r.emailAddress.address).join(','),recipient);
    assert.deepEqual(mail.ccRecipients,[]);assert.deepEqual(mail.bccRecipients,[]);
    assert.match(mail.body.content,/Not all items below apply/);assert.match(mail.body.content,/Synthetic &lt;Employee&gt;/);
    assert.doesNotMatch(mail.body.content,/PREVIEW|<Employee>|archive_reason|personal_email/);
    assert.equal(h.calls[0].body.claimToken,token);
  }
});
test('invalid fields, dates, recipients and event identity fail before any external operation',async()=>{
  const mutations=[p=>p.recipient+=',other@example.invalid',p=>p.recipient='bad',p=>p.employee.startDate='2026-02-30',p=>p.employee.privateReason='private',p=>p.eventKey+='other',p=>p.employee.name='bad\r\nBcc:other',p=>p.version=2,p=>p.claimToken='bad'];
  for(const mutate of mutations){const p=payload();mutate(p);const h=graph(p);assert.equal((await h.run()).value.ok,false);assert.equal(h.calls.length,0);}
});
test('confirmed duplicate never sends again; unknown reservation or provider result stays held',async()=>{
  const p=payload();
  let h=graph(p,{reserve:{statusCode:200,body:receipt(p,true)}});assert.equal((await h.run()).value.alreadySent,true);assert.equal(h.calls.length,1);
  for(const reserve of [{statusCode:503,body:{}},{statusCode:200,body:{outcome:'rejected'}},{statusCode:200,body:{outcome:'send',eventKey:'wrong',deliveryToken:token}}]){
    h=graph(p,{reserve});assert.equal((await h.run()).value.ok,false);assert.equal(h.calls.length,1);
  }
  for(const send of [null,{statusCode:500,body:''},{statusCode:202,body:'unexpected'}]){
    h=graph(p,{send});assert.equal((await h.run()).value.ok,false);assert.equal(h.calls.length,2);
  }
});
test('workflow uses every-minute scheduler, authenticated webhooks and no saved employee execution payloads',()=>{
  assert.equal(workflow.settings.timezone,'Australia/Melbourne');
  assert.equal(workflow.settings.saveDataSuccessExecution,'none');assert.equal(workflow.settings.saveDataErrorExecution,'none');
  const timer=workflow.nodes.find(n=>n.name==='Every Minute');assert.equal(timer.parameters.rule.interval[0].expression,'0 * * * * *');
  for(const n of workflow.nodes){assert.equal(n.retryOnFail,false);if(n.type.endsWith('.webhook'))assert.equal(n.parameters.authentication,'headerAuth');}
});
test('app dispatch forwards only database-claimed safe values and verifies exact provider evidence',async()=>{
  const p=payload(),{version,deliveryId,claimToken,...body}=p;void version;
  const h=harness({rpc:(name,args)=>{
    if(name==='claim_employee_lifecycle_mail')return {data:[{delivery_id:deliveryId,person_id:id,claim_token:claimToken,payload:body}],error:null};
    assert.equal(name,'finish_employee_lifecycle_mail');assert.equal(args.p_delivered,true);return {data:true,error:null};
  },fetch:async(url,options)=>{assert.equal(url,'https://n8n.srv1866578.hstgr.cloud/webhook/mam-people-hub-employee-lifecycle-v1');assert.deepEqual(JSON.parse(options.body),p);return Response.json(receipt(p));}});
  assert.deepEqual(await h.load('src/lib/employee-lifecycle-mail.ts').dispatchEmployeeLifecycleMail(id),{ok:true,code:'processed',claimed:1,sent:1,held:0});
});
test('app never delivers in preview or sandbox; cron denies unauthenticated callers before database access',async()=>{
  for(const env of [{VERCEL_ENV:'preview'},{VERCEL_ENV:'development'},{MAM_SANDBOX_E2E:'true'}]){
    const h=harness({env});assert.equal((await h.load('src/lib/employee-lifecycle-mail.ts').dispatchEmployeeLifecycleMail()).code,'disabled');assert.equal(h.calls.length,0);
  }
  const h=harness();const response=await h.load('src/app/api/cron/employee-lifecycle/route.ts').GET(new Request(base+'/api/cron/employee-lifecycle'));
  assert.equal(response.status,401);assert.equal(h.calls.length,0);
});
test('app failure records uncertain result and does not repeat provider call within dispatch',async()=>{
  const p=payload(),{version,deliveryId,claimToken,...body}=p;void version;
  const h=harness({rpc:(name,args)=>{
    if(name==='claim_employee_lifecycle_mail')return {data:[{delivery_id:deliveryId,person_id:id,claim_token:claimToken,payload:body}],error:null};
    assert.equal(args.p_delivered,false);return {data:true,error:null};
  },fetch:()=>{throw Error('synthetic unknown');}});
  assert.equal((await h.load('src/lib/employee-lifecycle-mail.ts').dispatchEmployeeLifecycleMail(id)).held,1);assert.equal(h.requests.length,1);
});
test('receipt bridge requires lifecycle claim token and forwards only to lifecycle reserve RPC',async()=>{
  const p=payload(),h=harness(),handler=h.load('src/lib/notification-receipts.ts').handleNotificationReceipts;
  const body={action:'reserve',eventKey:p.eventKey,recipient:p.recipient,cc:'',legacyEventKey:null,claimToken:token};
  const request=b=>new Request(base+'/api/internal/integrations/notifications/receipts',{method:'POST',headers:{'Content-Type':'application/json','X-MAM-Notification-Secret':secret},body:JSON.stringify(b)});
  let calls=0;
  const rpc=async(name,args)=>{calls++;assert.equal(name,'reserve_employee_lifecycle_mail');assert.equal(args.p_claim_token,token);return {error:null,data:{outcome:'send',eventKey:p.eventKey,deliveryToken:token}};};
  assert.equal((await handler(request(body),secret,rpc)).status,200);assert.equal(calls,1);
  delete body.claimToken;assert.equal((await handler(request(body),secret,rpc)).status,400);assert.equal(calls,1);
});

test('scheduled dispatch starts due employees together and preserves per-employee receipts',async()=>{
  const messages=[payload(),payload('offboarding')];
  let started=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const h=harness({rpc:(name,args)=>{
    if(name==='claim_employee_lifecycle_mail'){
      assert.equal(args.p_limit,10);
      return {data:messages.map(p=>{const {version,deliveryId,claimToken,...body}=p;void version;return {delivery_id:deliveryId,person_id:id,claim_token:claimToken,payload:body};}),error:null};
    }
    assert.equal(args.p_delivered,true);return {data:true,error:null};
  },fetch:async(_url,options)=>{started++;if(started===2)release();await gate;return Response.json(receipt(JSON.parse(options.body)));}});
  assert.deepEqual(await h.load('src/lib/employee-lifecycle-mail.ts').dispatchEmployeeLifecycleMail(),{ok:true,code:'processed',claimed:2,sent:2,held:0});
  assert.equal(h.requests.length,2);
});
