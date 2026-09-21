import test from 'node:test';
import assert from 'node:assert/strict';
import {load,fixture,input,employee,now} from './openclaw-v3-fixture.mjs';
test('real contract+store preparation only calls read-only snapshot; confirmation calls atomic submit',async()=>{
  const calls=[];
  const client={rpc(name,args){calls.push({name,args}); return {async abortSignal(){
    if(name==='openclaw_leave_v3_snapshot')return {data:{complete:true,rows:[employee()],fingerprint:'a'.repeat(64),receipt:null,submitted:null}};
    assert.equal(name,'openclaw_leave_v3_submit'); assert.equal(args.p_person_id,employee().personId);
    assert.equal(args.p_packet.payload.replyToMessageId,null); assert.equal(args.p_draft.consentVersion,3);
    return {data:{code:'submitted',status:'Pending',requestId:'30000000-0000-4000-8000-000000000001'}};
  }};}};
  const store=load('src/lib/openclaw-leave-store.ts',{'server-only':{},'./supabase/admin':{createAdminClient:()=>client}}).createLeaveBridgeStore();
  const f=fixture(store); await f.call(f.packet('prepare',{})); const {confirm}=await f.ready();
  assert.deepEqual(calls.map(c=>c.name),['openclaw_leave_v3_snapshot','openclaw_leave_v3_snapshot']);
  assert.equal((await f.call(confirm,now+1)).body.code,'submitted');
  assert.deepEqual(calls.map(c=>c.name).slice(2),['openclaw_leave_v3_snapshot','openclaw_leave_v3_submit']);
});
test('database errors or malformed snapshots cannot produce success',async()=>{
  for(const response of [{error:{message:'private SQL error'}},{data:{complete:false,rows:[]}}]){
    const store=load('src/lib/openclaw-leave-store.ts',{'server-only':{},'./supabase/admin':{createAdminClient:()=>({rpc:()=>({abortSignal:async()=>response})})}}).createLeaveBridgeStore();
    const f=fixture(store); assert.deepEqual(await f.call(f.packet('prepare',input())),{status:503,body:{code:'unavailable'}});
  }
});
