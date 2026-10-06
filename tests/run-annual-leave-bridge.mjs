import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {load,api,config} from './openclaw-v3-fixture.mjs';
import {sql,target,command,postgresEnv} from '../scripts/local-test-postgres.mjs';

const [socket,database]=process.argv.slice(2);
assert.match(database??'',/^mam_test_annual_/);
const employee='b1000000-0000-4000-8000-000000000002';
const seed=readFileSync('tests/annual-leave-all-submitters.sql','utf8').split('DO $$ BEGIN\n  BEGIN')[0]
  .replace('\\ir sql-test-auth.sql',`\\ir ${path.resolve('tests/sql-test-auth.sql')}`);
const seedPath=path.join(socket,`${database}-bridge-seed.sql`);
writeFileSync(seedPath,seed+`update private.leave_accrual_policies set enabled=false,requires_review=false where person_id::text like 'b1000000-%';
select public.set_openclaw_phone_identity('${employee}',null,'+61400000002','synthetic:annual-gate');
update private.openclaw_leave_release_gate set enabled=true where singleton;
commit;`,{mode:0o600});
command('psql',[...target(socket,database),'-f',seedPath]);
const literal=value=>"'"+String(value).replaceAll("'","''")+"'";
const names={
  openclaw_leave_v3_snapshot:['p_key','p_draft_id'],
  openclaw_leave_v3_submit:['p_key','p_body_fingerprint','p_source_fingerprint','p_packet','p_person_id','p_draft','p_token_hash'],
};
let rejects=0,dispatches=0;
const client={rpc(name,args){
  assert.ok(name in names,'Unexpected database boundary');
  return {async abortSignal(){
    const values=names[name].map(key=>args[key]==null?'null':literal(typeof args[key]==='object'?JSON.stringify(args[key]):args[key]));
    try {
      const result=sql(socket,database,`begin; set local role service_role; select public.${name}(${values.join(',')}); commit;`);
      return {data:JSON.parse(result.trim().split('\n').find(line=>line.startsWith('{'))),error:null};
    } catch(error) {
      assert.match(error.message,/psql failed/);
      assert.match(error.message,/Not enough balance|Future accrual could not be confirmed/,'T05: rejection must be annual balance, not fixture setup');
      rejects++;
      return {data:null,error:{message:'Synthetic SQL rejection'}};
    }
  }};
}};
const store=load('src/lib/openclaw-leave-store.ts',{'server-only':{},'./supabase/admin':{createAdminClient:()=>client}}).createLeaveBridgeStore();
const route=load('src/app/api/internal/integrations/openclaw/leave/route.ts',{
  '@/lib/openclaw-leave-contract':api,
  '@/lib/openclaw-leave-store':{createLeaveBridgeStore:()=>store},
  '@/lib/leave-notification-outbox':{dispatchLeaveNotificationsForRequest:()=>assert.fail('No email transport is allowed')},
  'next/server':{after:()=>dispatches++},
});
const env={MAM_OPENCLAW_LEAVE_ENABLED:'true',MAM_OPENCLAW_LEAVE_BRIDGE_SECRET:config.key,MAM_OPENCLAW_LEAVE_ACCOUNT:config.account};
const beforeEnv=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));
Object.assign(process.env,env);
let sequence=0;
const packet=(operation,payload)=>({version:3,account:config.account,channel:'whatsapp',sender:'+61400000002',session:'synthetic-annual',eventId:`annual-${++sequence}`,operation,payload});
async function call(packet){
  const raw=JSON.stringify(packet),timestamp=String(Date.now());
  const signature=createHmac('sha256',config.key).update(`POST\n${api.LEAVE_BRIDGE_PATH}\n${timestamp}\n${raw}`).digest('hex');
  const result=await route.POST(new Request('https://example.test'+api.LEAVE_BRIDGE_PATH,{method:'POST',body:raw,
    headers:{'content-type':'application/json','x-mam-timestamp':timestamp,'x-mam-signature':signature}}));
  return {status:result.status,body:await result.json()};
}
function counts(){
  return JSON.parse(sql(socket,database,`select jsonb_build_object('requests',(select count(*) from public.leave_requests where employee_person_id='${employee}'),
    'receipts',(select count(*) from private.openclaw_leave_receipts),'nonces',(select count(*) from private.openclaw_leave_drafts),
    'events',(select count(*) from public.leave_request_events),'outbox',(select count(*) from private.leave_notification_outbox));`).trim());
}
try {
  const before=counts();
  const day=sql(socket,database,"select ((current_date+28)-(extract(isodow from current_date+28)::integer-1))::text;").trim();
  const prepared=await call(packet('prepare',{leaveType:'Annual leave',startDate:day,endDate:day,employeeNote:''}));
  assert.equal(prepared.status,200);
  assert.equal(prepared.body.code,'prepared');
  const confirmation=packet('confirm',{draftToken:prepared.body.draftToken,shownMessageId:'synthetic-provider-1',replyToMessageId:null,text:'Confirm'});
  const denied=await call(confirmation);
  assert.equal(denied.status,503);
  assert.equal(denied.body.code,'unavailable');
  assert.equal(rejects,1);
  assert.equal(dispatches,0);
  assert.deepEqual(counts(),before,'T05: insufficient bridge left partial canonical/receipt/nonce/audit/outbox state');
  sql(socket,database,`update private.employee_annual_leave_balances set hours=10 where person_id='${employee}';`);
  const accepted=await call(confirmation);
  assert.equal(accepted.status,200);
  assert.equal(accepted.body.code,'submitted');
  const committed=counts();
  assert.equal(committed.requests,before.requests+1);
  assert.equal(committed.receipts,before.receipts+1);
  assert.equal(committed.nonces,before.nonces+1);
  const replay=await call(confirmation);
  assert.deepEqual(replay,accepted);
  assert.deepEqual(counts(),committed,'T05: bridge replay duplicated database state');
  assert.equal(dispatches,2);
  sql(socket,database,`update private.employee_annual_leave_balances set hours=0 where person_id='${employee}';`);
  const deniedLeaf=spawnSync('psql',[...target(socket,database),'-Atq','-c',`begin; select * from private.openclaw_submit_self('${employee}','Annual leave','${day}','${day}',null,null,null); rollback;`],{env:postgresEnv,encoding:'utf8'});
  assert.notEqual(deniedLeaf.status,0);
  assert.match(deniedLeaf.stderr,/Not enough balance|Future accrual could not be confirmed/);
  assert.deepEqual(counts(),committed);
  console.log('PASS T05 real route contract store service RPC private leaf and exact replay; no email dispatched');
} finally {
  for(const key of Object.keys(env)) {if(beforeEnv[key]===undefined)delete process.env[key];else process.env[key]=beforeEnv[key];}
}
