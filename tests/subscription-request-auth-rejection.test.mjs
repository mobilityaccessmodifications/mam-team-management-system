import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './helpers/contact-lifetime-harness.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
const id='b1000000-0000-4000-8000-000000000101';
const args={loadSubscriptionRequests:[],mutateSubscriptionRequest:[{id,version:3,operation:'approve'}],downloadRequestEvidence:[id,1,0]};
for(const name of Object.keys(args))for(const [label,error] of [['undefined',undefined],['null',null],['false',false]])test('unconfirmed getUser rejection '+name+' '+label,async()=>{
  let authCalls=0,rpcCalls=0;
  const actions=loadModule('src/app/subscription-requests/actions.ts',{'@/lib/supabase/server':{createClient:async()=>({auth:{getUser:async()=>{authCalls++;throw error;}},rpc:async()=>{rpcCalls++;throw new Error('Unexpected RPC');}})}});
  const result=await actions[name](...args[name]);
  assert.deepEqual(result,{ok:false,message:'The request could not be confirmed. Reload before retrying.',denied:false,uncertain:false});
  assert.equal(authCalls,1);assert.equal(rpcCalls,0);
});
