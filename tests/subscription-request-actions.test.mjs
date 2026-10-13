import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { loadModule } from './helpers/contact-lifetime-harness.mjs';
import { payload } from './subscription-requests.test.mjs';
const id='b1000000-0000-4000-8000-000000000001';
function harness({signedIn=true, workspace={enabled:true,canApply:true,requests:[],people:[]}, error=null, throws=false}={}) {
  assert.ok(existsSync('src/app/subscription-requests/actions.ts'),'Request Server Actions are not implemented');
  const calls=[], scheduled=[], delivered=[];
  const actions=loadModule('src/app/subscription-requests/actions.ts',{'next/server':{after:callback=>scheduled.push(callback)},'@/lib/subscription-request-mail':{dispatchSubscriptionRequestMail:async requestId=>{delivered.push(requestId);return {ok:false};}} ,'@/lib/supabase/server':{createClient:async()=>({auth:{getUser:async()=>({data:{user:signedIn?{id}:null},error:null})},rpc:async(name,args)=>{calls.push({name,args}); if(throws) throw new Error('PRIVATE PROVIDER'); return {data:name==='sr_workspace'?workspace:{id,status:'submitted',version:1,revision:1,evidenceVersion:1,applicant:id,payload,evidence:[],events:[],canEdit:false,canDecide:false,canWithdraw:true},error};}})}});
  return {actions,calls,scheduled,delivered};
}
test('request action authenticates before dispatch and preserves literal CAS identity',async()=>{
  const h=harness(); const result=await h.actions.mutateSubscriptionRequest({id,version:0,operation:'submit',payload});
  assert.equal(result.ok,true); assert.equal(result.committed,true);
  assert.equal(h.calls[0].name,'sr_mutate'); assert.equal(h.calls[0].args.p_id,id); assert.equal(h.calls[0].args.p_version,0);
  const no=harness({signedIn:false}); assert.equal((await no.actions.mutateSubscriptionRequest({id,version:0,operation:'submit',payload})).ok,false); assert.equal(no.calls.length,0);
});
test('request action returns safe stale and uncertain failures with no automatic retry',async()=>{
  for(const error of [{code:'PT409',message:'PRIVATE DATABASE'},{code:'XX000',message:'PRIVATE DATABASE'}]) {
    const h=harness({error}); const r=await h.actions.mutateSubscriptionRequest({id,version:1,operation:'approve'});
    assert.equal(r.ok,false); assert.doesNotMatch(JSON.stringify(r),/PRIVATE/); assert.equal(h.calls.length,1);
    assert.equal(r.uncertain,error.code==='XX000');
  }
  const h=harness({throws:true}); const r=await h.actions.mutateSubscriptionRequest({id,version:1,operation:'approve'});
  assert.equal(r.uncertain,true); assert.doesNotMatch(JSON.stringify(r),/PRIVATE/);
});
test('request action rejects unknown fields and malformed projections',async()=>{
  const h=harness(); assert.equal((await h.actions.mutateSubscriptionRequest({id,version:0,operation:'submit',payload:{...payload,password:'not allowed'}})).ok,false); assert.equal(h.calls.length,0);
  const bad=harness({workspace:{enabled:true,canApply:'yes',requests:[],people:[]}}); assert.equal((await bad.actions.loadSubscriptionRequests()).ok,false);
});

test('only a committed submission schedules mail, and mail failure preserves submission success',async()=>{
 const h=harness();const result=await h.actions.mutateSubscriptionRequest({id,version:0,operation:'submit',payload});
 assert.equal(result.committed,true);assert.equal(h.scheduled.length,1);assert.deepEqual(h.delivered,[]);await h.scheduled[0]();assert.deepEqual(h.delivered,[id]);assert.equal(result.ok,true);
 for(const options of [{signedIn:false},{error:{code:'PT409'}},{throws:true}]){const denied=harness(options);await denied.actions.mutateSubscriptionRequest({id,version:0,operation:'submit',payload});assert.equal(denied.scheduled.length,0);}
 const saved=harness();await saved.actions.mutateSubscriptionRequest({id,version:0,operation:'save',payload});assert.equal(saved.scheduled.length,0);
});
