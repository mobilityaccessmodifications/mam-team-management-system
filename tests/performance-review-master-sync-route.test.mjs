import assert from 'node:assert/strict';
import {test} from 'node:test';
import {harness,request,app,secret} from './performance-review-master-sync-harness.mjs';
import {fixture} from './performance-review-master-sync-fixtures.mjs';

test('actual protected handler and exact Next Proxy admit the authorized independent claim',async()=>{
 const f=fixture();const h=harness({rpc:(name,args)=>{assert.equal(name,'claim_performance_review_master_sync');assert.deepEqual(args,{p_target_key:'master-reviews-v1',p_limit:1});return {data:[f.job],error:null};}});
 assert.equal(typeof h.route().POST,'function','independent Master handler must exist');
 const result=await h.handle(request({phase:'claim'}));
 assert.equal(result.status,200);assert.deepEqual(await result.json(),{ok:true,jobs:[f.job]});
 assert.equal(h.counts.claims,0);assert.equal(h.counts.config,0);assert.deepEqual(h.retries,[false]);assert.deepEqual(h.logs,[]);
});

test('sandbox startup rejects the independent Master credential and non-disabled mode',()=>{
 const h=harness();const guard=h.load('src/lib/sandbox-safety.ts');
 const base={MAM_SANDBOX_E2E:'true',NEXT_PUBLIC_SUPABASE_URL:'http://127.0.0.1:1',NEXT_PUBLIC_APP_URL:'http://127.0.0.1:2',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'synthetic',SUPABASE_SECRET_KEY:'synthetic'};
 assert.doesNotThrow(()=>guard.assertSandboxEnvironment({...base,PERFORMANCE_REVIEW_MASTER_SYNC_MODE:'disabled'}));
 assert.throws(()=>guard.assertSandboxEnvironment({...base,MAM_N8N_PERFORMANCE_MASTER_SYNC_SECRET:secret}),/MASTER_SYNC_SECRET/);
 assert.throws(()=>guard.assertSandboxEnvironment({...base,PERFORMANCE_REVIEW_MASTER_SYNC_MODE:'live'}),/MASTER_SYNC_MODE/);
});

for (const [title,body,options,status] of [
 ['wrong independent secret',{phase:'claim'},{key:'wrong'},401],
 ['URL override',{phase:'claim',url:'https://example.invalid'}, {},400],
 ['employee selection',{phase:'claim',employeeId:'10000000-0000-4000-8000-000000000001'}, {},400],
 ['cross origin',{phase:'claim'},{headers:{Origin:'https://example.invalid'}},400],
 ['query',{phase:'claim'},{path:'/api/performance-reviews/master-sync?x=1'},400],
 ['invalid JSON','{"phase":',{raw:true},400],
 ['oversized body',' '.repeat(2*1024*1024+1),{raw:true},400],
 ['cookie does not grant service permission',{phase:'readiness'},{key:'',headers:{Cookie:'synthetic=1'}},401],
])test('handler denies '+title+' before database construction',async()=>{
 const h=harness();const result=await h.route().POST(request(body,options));assert.equal(result.status,status);assert.equal(h.calls.length,0);assert.equal(h.counts.client,0);assert.deepEqual(h.logs,[]);
});

test('default disabled and sealed missing target cannot dispatch or construct a client',async()=>{
 for (const options of [{mode:'disabled'},{target:{enabled:false,singleWriterAdmitted:false,binding:null}},{env:{MAM_SANDBOX_E2E:'true'}}]){
  const h=harness(options);const r=await h.route().POST(request({phase:'claim'}));assert.equal(r.status,503);assert.equal(h.counts.client,0);
  const ready=await h.route().POST(request({phase:'readiness'}));assert.deepEqual(await ready.json(),{ok:true,ready:false});assert.equal(h.calls.length,0);
 }
});

test('exact bypass does not expose sibling paths or remove the handler secret',async()=>{
 const h=harness();const exact=await h.handle(request({phase:'claim'},{key:'wrong'}));assert.equal(exact.status,401);assert.equal(h.counts.claims,0);
 for(const path of ['/api/performance-reviews/master-sync/extra','/api/performance-reviews/master-sync-fake','/performance-reviews']){
  const p=await h.load('src/proxy.ts').proxy(new (await import('next/server.js')).NextRequest(app+path));assert.equal(p.status,307);
 }
 assert.equal(h.counts.claims,3);
});

for(const scalar of [false,null,'true',[true],{allowed:true}])test('strict begin Boolean wire '+JSON.stringify(scalar),async()=>{
 const f=fixture();const h=harness({rpc:()=>({data:scalar,error:null})});
 const r=await h.route().POST(request({phase:'begin',jobId:f.job.jobId,claimToken:f.job.claimToken,revision:1,projectionSha256:f.job.projectionSha256,targetFingerprint:f.job.targetFingerprint}));
 assert.equal(r.status,typeof scalar==='boolean'?200:503);if(typeof scalar==='boolean')assert.deepEqual(await r.json(),{ok:true,allowed:false});assert.deepEqual(h.retries,[false]);
});
