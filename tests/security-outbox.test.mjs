import {Receiver} from './notification-workflow-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { loadUatSafety } from './helpers/uat-safety-loader.mjs';
const require = createRequire(import.meta.url);
const ts = require('typescript');
function load(file, imports) {
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const m={exports:{}};
  new Function('require','module','exports',code)((id)=> {
    if(id === '@/lib/uat-safety') return loadUatSafety();
    if(id in imports) return imports[id];
    throw new Error(`Unexpected import ${id}`);
  },m,m.exports);
  return m.exports;
}
const id='10000000-0000-4000-8000-000000000001';
test('outbox refuses missing bearer before any dispatch',async()=>{
  const {GET}=load('src/app/api/cron/leave-notifications/route.ts',{
    'node:crypto':require('node:crypto'),
    '@/lib/leave-notification-outbox':{dispatchLeaveNotificationOutbox:()=>{throw new Error('must not dispatch');}},
  });
  const r=await GET(new Request('https://example.test/api/cron/leave-notifications'));
  assert.equal(r.status,401); assert.equal(r.headers.get('cache-control'),'no-store');
});
test('outbox keeps stable event keys and requires matching receipt before ack',async(t)=>{
  const oldFetch=globalThis.fetch;
  const saved={...process.env};
  t.after(()=>{globalThis.fetch=oldFetch; for(const k of ['MAM_N8N_LEAVE_WEBHOOK_URL','MAM_N8N_LEAVE_WEBHOOK_ORIGIN','MAM_N8N_LEAVE_WEBHOOK_SECRET']) {
    if(saved[k]===undefined) delete process.env[k]; else process.env[k]=saved[k];
  }});
  process.env.MAM_N8N_LEAVE_WEBHOOK_URL='https://example.test/hook';
  process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN='https://example.test';
  process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET='synthetic';
  const acks=[]; const keys=[]; let mode='failure';
  const row={delivery_id:id,claim_token:id,payload:{requestId:id,event:'leave-approved',employeeEmails:['employee@example.test'],managerNote:'First\nSecond\u0001'}};
  const {dispatchLeaveNotificationOutbox}=load('src/lib/leave-notification-outbox.ts',{
    'server-only':{}, 'node:crypto':require('node:crypto'),
    '@/lib/supabase/admin':{createAdminClient:()=>({rpc:async(name,args)=>{
      if(name==='claim_leave_notification_outbox')return {data:[row],error:null};
      acks.push(args);return {data:true,error:null};
    }})},
  });
  globalThis.fetch=async(url,options)=>{
    assert.equal(String(url),'https://example.test/hook');assert.equal(options.redirect,'error');
    const payload=JSON.parse(options.body);keys.push(payload.eventKey);
    assert.equal(payload.managerNote,'First\nSecond');
    if(mode==='failure') throw new Error('simulated timeout');
    return Response.json({ok:true,sent:mode==='sent',alreadySent:mode==='duplicate',
      eventKey:mode==='wrong-key'?'wrong':payload.eventKey,actualRecipient:'employee@example.test'});
  };
  assert.equal((await dispatchLeaveNotificationOutbox()).failed,1);
  assert.equal(acks.at(-1).p_delivered,false);
  mode='wrong-key'; assert.equal((await dispatchLeaveNotificationOutbox()).failed,1);
  mode='sent'; assert.equal((await dispatchLeaveNotificationOutbox()).sent,1);
  mode='duplicate'; assert.equal((await dispatchLeaveNotificationOutbox()).sent,1);
  assert.equal(new Set(keys).size,1); assert.equal(acks.at(-1).p_delivered,true);
});
test('global framing policy includes every route',()=>{
  const config=fs.readFileSync('next.config.ts','utf8');
  assert(config.includes('source: "/:path*"'));
  assert(config.includes('frame-ancestors \'none\''));
  assert(config.includes('{ key: "X-Frame-Options", value: "DENY" }'));
});

test('legacy sick copies have stable receipts and never expose balances to the email webhook',async(t)=>{
  const oldFetch=globalThis.fetch; const saved={...process.env};
  t.after(()=>{globalThis.fetch=oldFetch;for(const k of ['MAM_N8N_LEAVE_WEBHOOK_URL','MAM_N8N_LEAVE_WEBHOOK_ORIGIN','MAM_N8N_LEAVE_WEBHOOK_SECRET']) {
    if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];
  }});
  process.env.MAM_N8N_LEAVE_WEBHOOK_URL='https://example.test/hook';
  process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN='https://example.test';
  process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET='synthetic';
  const row={delivery_id:id,claim_token:id,payload:{requestId:id,event:'leave-submitted',leaveType:'Sick leave',
    employeeEmails:['employee@example.test'],managerEmail:'manager@example.test,employee@example.test',
    leaveBalance:{kind:'sick',status:'current',hours:40.9297}}};
  const acks=[];const keys={reviewers:[],employee:[]};let failEmployee=true;
  const {dispatchLeaveNotificationOutbox}=load('src/lib/leave-notification-outbox.ts',{
    'server-only':{},'node:crypto':require('node:crypto'),
    '@/lib/supabase/admin':{createAdminClient:()=>({rpc:async(name,args)=>{
      if(name==='claim_leave_notification_outbox')return {data:[row],error:null};
      acks.push(args);return {data:true,error:null};
    }})},
  });
  globalThis.fetch=async(url,options)=>{
    const payload=JSON.parse(options.body);keys[payload.audience].push(payload.eventKey);
    assert.equal(payload.leaveBalance,undefined);
    if(payload.audience==='employee'){
      if(failEmployee)throw new Error('synthetic timeout');
    }
    return Response.json({ok:true,sent:failEmployee,alreadySent:!failEmployee,eventKey:payload.eventKey,
      actualRecipient:payload.audience==='employee'?'employee@example.test':'hr@mobilityaccess.com.au,manager@example.test'});
  };
  assert.equal((await dispatchLeaveNotificationOutbox()).failed,1);
  assert.equal(acks.at(-1).p_delivered,false);
  failEmployee=false;
  assert.equal((await dispatchLeaveNotificationOutbox()).sent,1);
  assert.equal(acks.at(-1).p_delivered,true);
  assert.equal(new Set(keys.reviewers).size,1);assert.equal(new Set(keys.employee).size,1);
  assert.notEqual(keys.employee[0],keys.reviewers[0]);
});

test('balance-free submissions use separate stable copies and retain the legacy dedupe key',async(t)=>{
  const oldFetch=globalThis.fetch; const saved={...process.env};
  t.after(()=>{globalThis.fetch=oldFetch;for(const k of ['MAM_N8N_LEAVE_WEBHOOK_URL','MAM_N8N_LEAVE_WEBHOOK_ORIGIN','MAM_N8N_LEAVE_WEBHOOK_SECRET']) {
    if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];
  }});
  Object.assign(process.env,{MAM_N8N_LEAVE_WEBHOOK_URL:'https://example.test/hook',MAM_N8N_LEAVE_WEBHOOK_ORIGIN:'https://example.test',MAM_N8N_LEAVE_WEBHOOK_SECRET:'synthetic'});
  const bodies=[],acks=[];
  const row={delivery_id:id,claim_token:id,payload:{requestId:id,event:'leave-submitted',leaveType:'Annual leave',employeeEmails:['employee@example.test','personal@example.test'],managerEmail:'manager@example.test'}};
  const {dispatchLeaveNotificationOutbox:run}=load('src/lib/leave-notification-outbox.ts',{
    'server-only':{},'node:crypto':require('node:crypto'),
    '@/lib/supabase/admin':{createAdminClient:()=>({rpc:async(name,args)=>{
      if(name==='claim_leave_notification_outbox')return {data:[row],error:null};
      acks.push(args);return {data:true,error:null};
    }})},
  });
  const receiver=new Receiver(); let failEmployee=true;
  globalThis.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);bodies.push(body);
    // A connection failure before the receiver runs has no send side effect.
    // Ambiguous failures after reservation are covered by notification-receipts.
    if(body.audience==='employee'&&failEmployee)throw new Error('offline before receipt');
    const receipt=receiver.run({version:1,employeeName:'Synthetic Person',employeeEmail:null,company:'mam',startDate:'2026-10-01',endDate:'2026-10-01',startTime:null,endTime:null,days:1,hours:7.6,status:'Pending',...body});
    assert.equal(receipt.alreadySent,body.audience==='reviewers'&&bodies.length>2);
    return Response.json(receipt);
  };
  assert.equal((await run()).failed,1);
  assert.equal(acks.at(-1).p_delivered,false);
  assert.equal(receiver.api.rows.has(bodies[1].eventKey),false);
  failEmployee=false;assert.equal((await run()).sent,1);
  assert.deepEqual(bodies.map(b=>b.audience),['reviewers','employee','reviewers','employee']);
  assert.equal(bodies[0].eventKey,bodies[2].eventKey);
  assert.equal(bodies[1].eventKey,bodies[3].eventKey);
  assert.notEqual(bodies[0].eventKey,bodies[1].eventKey);
  const legacy=`leave:${id}:leave-submitted:${require('node:crypto').createHash('sha256').update(id).digest('hex').slice(0,24)}`;
  assert(bodies.every(b=>b.legacyEventKey===legacy&&!('leaveBalance' in b)));
});
