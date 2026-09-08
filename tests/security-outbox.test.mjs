import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
function load(file, imports) {
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const m={exports:{}};
  new Function('require','module','exports',code)((id)=> {
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
