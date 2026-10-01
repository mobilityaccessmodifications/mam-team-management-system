import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';
const source='src/lib/confirmed-test-identity-purge.ts';
let run;
if (existsSync(source)) {
  const result=await build({entryPoints:[source],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'server-only-test',setup(b){b.onResolve({filter:/^server-only$/},()=>({path:'server-only',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:''}));}}]});
  run=(await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).runConfirmedTestIdentityPurge;
}
const person='94000000-0000-4000-8000-000000000002';
const actor='94000000-0000-4000-8000-000000000001';
const receiptId='94000000-0000-4000-8000-000000000004';
const input={mode:'apply',personId:person,authUserId:person,companyKey:'mam',fullName:'Confirmed Fake Synthetic',loginName:'fake@example.test',personVersion:1,accountVersion:1,manifestHash:'a'.repeat(64),confirmTestOnly:true,destroyExclusiveHistory:true};
function boundary() {
  const calls=[]; let receipt=null; let authExists=true;
  const session={auth:{getUser:async()=>({data:{user:{id:actor}},error:null})},rpc:async(name,args)=>{
    calls.push([name,args]);
    if(name==='can_change_employee_view') return {data:true,error:null};
    if(name==='get_confirmed_test_identity_purge') return {data:receipt,error:null};
    if(name==='prepare_confirmed_test_identity_purge') {receipt={id:receiptId,person_id:person,auth_user_id:args.p_auth_user_id,manifest_hash:input.manifestHash,phase:args.p_auth_user_id?'business_purged':'complete'};return {data:receiptId,error:null};}
    if(name==='claim_confirmed_test_identity_auth_delete') {const authorized=receipt.phase==='business_purged';receipt.phase='auth_delete_started';return {data:{...receipt,delete_authorized:authorized},error:null};}
    if(name==='complete_confirmed_test_identity_purge') {assert.equal(authExists,false);receipt.phase='complete';return {data:receipt,error:null};}
    throw new Error(name);
  }};
  const admin={auth:{admin:{getUserById:async(id)=>{calls.push(['auth-read',id]);return authExists?{data:{user:{id,banned_until:'2999-01-01T00:00:00Z'}},error:null}:{data:{user:null},error:{code:'user_not_found'}};},deleteUser:async(id,soft)=>{calls.push(['auth-delete',id,soft]);authExists=false;return {data:{user:{id}},error:null};}}}};
  return {calls,session,admin,setReceipt:(r)=>receipt=r,setAuthExists:(b)=>authExists=b};
}
test('mocked Auth boundary: linked purge hard-deletes exact account after durable claim and verifies absence',async()=>{
  assert.equal(typeof run,'function','Missing purge orchestrator');
  const b=boundary(); const result=await run(b.session,b.admin,input);
  assert.equal(result.phase,'complete');
  assert.deepEqual(b.calls.filter(c=>c[0]==='auth-delete'),[['auth-delete',person,false]]);
  assert.ok(b.calls.findIndex(c=>c[0]==='claim_confirmed_test_identity_auth_delete')<b.calls.findIndex(c=>c[0]==='auth-delete'));
});
test('mocked Auth boundary: malformed ban timestamp cannot authorize business destruction',async()=>{
  const b=boundary(); b.admin.auth.admin.getUserById=async(id)=>({data:{user:{id,banned_until:'not-a-timestamp'}},error:null});
  await assert.rejects(run(b.session,b.admin,input),/already be banned/);
  assert.equal(b.calls.some(c=>c[0]==='prepare_confirmed_test_identity_purge'),false);
});
test('mocked Auth boundary: Auth readback timeout retains reconciliation state',async()=>{
  const b=boundary(); const read=b.admin.auth.admin.getUserById; let n=0;
  b.admin.auth.admin.getUserById=async(id)=>{if(++n>1) throw new Error('synthetic timeout'); return read(id);};
  const result=await run(b.session,b.admin,input);
  assert.equal(result.phase,'reconciliation_required');
  assert.equal(b.calls.filter(c=>c[0]==='auth-delete').length,1);
});
test('mocked Auth boundary: directory-only inactive identity completes without any Auth call',async()=>{
 const b=boundary(); const r=await run(b.session,b.admin,{...input,authUserId:null,loginName:null,accountVersion:null});
 assert.equal(r.phase,'complete'); assert.equal(b.calls.some(c=>c[0].startsWith('auth-')),false);
});
test('mocked Auth boundary: lost prepare response reconciles exact durable receipt',async()=>{
 const b=boundary(); const rpc=b.session.rpc;
 b.session.rpc=async(name,args)=>{const result=await rpc(name,args);if(name==='prepare_confirmed_test_identity_purge') throw new Error('lost response');return result;};
 assert.equal((await run(b.session,b.admin,input)).phase,'complete');
 assert.equal(b.calls.filter(c=>c[0]==='prepare_confirmed_test_identity_purge').length,1);
});
test('mocked Auth boundary: lost claim response cannot execute Auth',async()=>{
 const b=boundary(); const rpc=b.session.rpc;
 b.session.rpc=async(name,args)=>{const result=await rpc(name,args);if(name==='claim_confirmed_test_identity_auth_delete') throw new Error('lost claim');return result;};
 assert.equal((await run(b.session,b.admin,input)).phase,'reconciliation_required');
 assert.equal(b.calls.some(c=>c[0]==='auth-delete'),false);
 assert.equal((await run(b.session,b.admin,input)).phase,'reconciliation_required');
 assert.equal(b.calls.some(c=>c[0]==='auth-delete'),false);
});
test('mocked Auth boundary: ambiguous Auth failure never re-executes deletion',async()=>{
 const b=boundary(); b.admin.auth.admin.deleteUser=async(id)=>{b.calls.push(['auth-delete',id]);throw new Error('timeout');};
 assert.equal((await run(b.session,b.admin,input)).phase,'reconciliation_required');
 assert.equal((await run(b.session,b.admin,{mode:'reconcile',personId:person,authUserId:person})).phase,'reconciliation_required');
 assert.equal(b.calls.filter(c=>c[0]==='auth-delete').length,1);
});
test('mocked Auth boundary: timeout after actual deletion reconciles to complete',async()=>{
 const b=boundary(); const del=b.admin.auth.admin.deleteUser;
 b.admin.auth.admin.deleteUser=async(...args)=>{await del(...args);throw new Error('response timeout');};
 assert.equal((await run(b.session,b.admin,input)).phase,'complete');
});
test('mocked Auth boundary: incorrect absence error is not proof of Auth removal',async()=>{
 const b=boundary(); let n=0; const read=b.admin.auth.admin.getUserById;
 b.admin.auth.admin.getUserById=async(id)=>++n===1?read(id):{data:{user:null},error:{code:'unexpected_failure',status:404}};
 assert.equal((await run(b.session,b.admin,input)).phase,'reconciliation_required');
 assert.equal(b.calls.some(c=>c[0]==='complete_confirmed_test_identity_purge'),false);
});
test('mocked Auth boundary: editable metadata never grants administrator capability',async()=>{
 const b=boundary(); const rpc=b.session.rpc;
 b.session.auth.getUser=async()=>({data:{user:{id:actor,user_metadata:{role:'system_admin'}}},error:null});
 b.session.rpc=async(name,args)=>name==='can_change_employee_view'?{data:false,error:null}:rpc(name,args);
 await assert.rejects(run(b.session,b.admin,input),/Active System Admin/);
 assert.equal(b.calls.length,0);
});
test('mocked Auth boundary: never-settling claim is bounded and never deletes',async()=>{
 const b=boundary(); const rpc=b.session.rpc; b.session.rpc=(name,args)=>{if(name==='claim_confirmed_test_identity_auth_delete'){void rpc(name,args);return new Promise(()=>{});}return rpc(name,args);};
 const result=await Promise.race([run(b.session,b.admin,input,{timeoutMs:30}),new Promise(r=>setTimeout(()=>r({phase:'hung'}),150))]);
 assert.equal(result.phase,'reconciliation_required'); assert.equal(b.calls.some(c=>c[0]==='auth-delete'),false);
 assert.equal((await run(b.session,b.admin,input,{timeoutMs:30})).phase,'reconciliation_required'); assert.equal(b.calls.some(c=>c[0]==='auth-delete'),false);
});
test('mocked Auth boundary: never-settling deletion is bounded with no blind retry',async()=>{
 const b=boundary(); b.admin.auth.admin.deleteUser=(id)=>{b.calls.push(['auth-delete',id]);return new Promise(()=>{});};
 const result=await Promise.race([run(b.session,b.admin,input,{timeoutMs:30}),new Promise(r=>setTimeout(()=>r({phase:'hung'}),150))]);
 assert.equal(result.phase,'reconciliation_required');
 assert.equal((await run(b.session,b.admin,{mode:'reconcile',personId:person,authUserId:person},{timeoutMs:30})).phase,'reconciliation_required');
 assert.equal(b.calls.filter(c=>c[0]==='auth-delete').length,1);
});
test('mocked Auth boundary: never-settling session rejects at deadline',async()=>{
 const b=boundary(); b.session.auth.getUser=()=>new Promise(()=>{});
 const result=await Promise.race([run(b.session,b.admin,input,{timeoutMs:30}).then(()=> 'accepted',()=> 'bounded'),new Promise(r=>setTimeout(()=>r('hung'),150))]); assert.equal(result,'bounded');
});
test('mocked Auth boundary: destruction confirmation must be explicit true',async()=>{
 const b=boundary(); await assert.rejects(run(b.session,b.admin,{...input,destroyExclusiveHistory:false}),/confirmations required/);
 assert.equal(b.calls.length,0);
});
