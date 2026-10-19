import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { loadModule } from './helpers/contact-lifetime-harness.mjs';
import { productionActionHarness } from './performance-review-production-ui-fixture.mjs';
import {actorId,personId,managerId,reviewId,operationId,review,document,start,mutation} from './performance-review-backend-fixtures.mjs';
const {ROLE_CAPABILITY_FIELDS}=loadModule('src/lib/portal-role-capabilities.ts');
function harness({data=null,error=null,throws=false,signedIn=true,role='employee',authThrows=false,status=200}={}) {
 assert.ok(existsSync('src/app/performance-reviews/actions.ts'),'Native performance Server Actions are missing');
 const calls=[];let authCalls=0;
 const actions=productionActionHarness({client:{auth:{getUser:async()=>{authCalls++;if(authThrows) throw Error('PRIVATE AUTH');return {data:{user:signedIn?{id:actorId}:null},error:null};}},rpc:async(name,args)=>{calls.push({name,args});if(name==='get_portal_role_capabilities')return {data:[{app_role:role,person_id:role==='manager'?managerId:personId,account_status:'active',...Object.fromEntries(ROLE_CAPABILITY_FIELDS.map(k=>[k,false]))}],error:null};if(throws)throw Error('PRIVATE PROVIDER');return {data,error,status};}}}).actions;
 return {actions,calls,authCalls:()=>authCalls,business:()=>calls.filter(c=>c.name!=='get_portal_role_capabilities')};
}
test('all five actions reject a nontrue enable flag before every auth or RPC',async()=>{
 for(const flag of [undefined,'false','TRUE','1','']) {
  if(flag===undefined)delete process.env.MAM_PERFORMANCE_REVIEW_ENABLED;else process.env.MAM_PERFORMANCE_REVIEW_ENABLED=flag;
  const h=harness();
  for(const result of [await h.actions.loadPerformanceReviews(),await h.actions.startPerformanceReview(start()),await h.actions.mutatePerformanceReview(mutation()),await h.actions.reconcilePerformanceReviewOperation({operationId,reviewId}),await h.actions.getPerformanceReviewDocument(reviewId)]) {assert.equal(result.ok,false);assert.equal(result.uncertain,false);}
  assert.equal(h.authCalls(),0);assert.equal(h.calls.length,0);
 }
});
test('workspace uses native actor and accepts only exact role-specific projections',async()=>{
 process.env.MAM_PERFORMANCE_REVIEW_ENABLED='true';
 for(const [role,audience] of [['employee','employee'],['account','employee'],['manager','manager'],['admin','admin'],['system_admin','admin']]) {
  const data={viewerContext:{actorUserId:actorId,personId:role==='manager'?managerId:personId,role,displayName:'Synthetic viewer'},reviews:[review(audience)],startablePeople:role==='manager'?[review().employee]:[]};
  const h=harness({data,role});assert.deepEqual(await h.actions.loadPerformanceReviews(),{ok:true,data});assert.equal(h.authCalls(),1);assert.deepEqual(h.calls.map(c=>c.name),['get_portal_role_capabilities','performance_review_workspace']);
 }
 for(const transform of [v=>({...v,private:'x'}),v=>({...v,reviews:[{...review(),managerNote:'LEAK'}]}),v=>({...v,reviews:[{...review(),selfAnswers:[]}]}),v=>({...v,reviews:[{...review(),capabilities:{saveSelf:true}}]}),v=>({...v,viewerContext:{...v.viewerContext,actorUserId:operationId}})]) {
  const data=transform({viewerContext:{actorUserId:actorId,personId,role:'employee',displayName:'Synthetic'},reviews:[review()],startablePeople:[]});const h=harness({data});assert.equal((await h.actions.loadPerformanceReviews()).ok,false);
 }
 const no=harness({signedIn:false});assert.equal((await no.actions.loadPerformanceReviews()).ok,false);assert.equal(no.business().length,0);
});
test('start action dispatches once and requires a matching committed receipt',async()=>{
 process.env.MAM_PERFORMANCE_REVIEW_ENABLED='true';
 const data={committed:true,operationId,review:review('manager'),existing:false};
 const h=harness({data,role:'manager'});assert.deepEqual(await h.actions.startPerformanceReview(start()),{ok:true,...data});assert.deepEqual(h.business(),[{name:'start_performance_review',args:{p_operation_id:operationId,p_employee_person_id:personId,p_cycle:'2026',p_due_date:'2026-12-31'}}]);
 for(const bad of [null,{...data,operationId:actorId},{...data,committed:false},{...data,existing:'true'},{...data,private:'LEAK'},{...data,review:{...data.review,id:'bad'}}]) {const b=harness({data:bad,role:'manager'});const r=await b.actions.startPerformanceReview(start());assert.equal(r.code,'uncertain');assert.equal(r.uncertain,true);assert.equal(b.business().length,1);assert.doesNotMatch(JSON.stringify(r),/LEAK/);}
 const no=harness();assert.equal((await no.actions.startPerformanceReview({...start(),actorUserId:actorId})).code,'invalid');assert.equal(no.authCalls(),0);
});
test('mutation action validates every command and never retries errors or bad receipts',async()=>{
 process.env.MAM_PERFORMANCE_REVIEW_ENABLED='true';const input=mutation();const data={committed:true,operationId,review:review()};
 const h=harness({data});assert.deepEqual(await h.actions.mutatePerformanceReview(input),{ok:true,...data});assert.deepEqual(h.business(),[{name:'mutate_performance_review',args:{p_operation_id:operationId,p_review_id:reviewId,p_expected_revision:'self:0',p_command:'save_self',p_input:input.input}}]);
 for(const [code,expected] of [['PT409','conflict'],['42501','forbidden'],['22023','invalid'],['40001','uncertain'],['XX000','uncertain'],['PGRST000','uncertain']]) {const b=harness({error:{code,message:'PRIVATE'}});const r=await b.actions.mutatePerformanceReview(input);assert.equal(r.code,expected);assert.equal(r.uncertain,expected==='uncertain');assert.equal(b.business().length,1);assert.doesNotMatch(JSON.stringify(r),/PRIVATE/);}
 for(const options of [{throws:true},{data:null},{data:{...data,operationId:actorId}},{data:{...data,review:{...review(),managerNote:'LEAK'}}}]) {const b=harness(options);assert.equal((await b.actions.mutatePerformanceReview(input)).uncertain,true);assert.equal(b.business().length,1);}
 const bad=harness();assert.equal((await bad.actions.mutatePerformanceReview({...input,input:{answers:[]}})).code,'invalid');assert.equal(bad.authCalls(),0);
});
test('explicit reconciliation reports committed or not_found without any write',async()=>{
 process.env.MAM_PERFORMANCE_REVIEW_ENABLED='true';
 for(const data of [{status:'committed',review:review()},{status:'not_found',review:null}]) {const h=harness({data});assert.deepEqual(await h.actions.reconcilePerformanceReviewOperation({operationId,reviewId}),{ok:true,data});assert.deepEqual(h.business(),[{name:'get_performance_review_operation',args:{p_operation_id:operationId,p_review_id:reviewId}}]);}
 for(const data of [{status:'committed',review:null},{status:'not_found',review:review()},{status:'retry',review:null},{status:'not_found',review:null,retry:true}]) {const h=harness({data});assert.equal((await h.actions.reconcilePerformanceReviewOperation({operationId,reviewId})).ok,false);assert.equal(h.business().length,1);}
});
test('document action accepts the direct closed audience DTO and never managerNote',async()=>{
 process.env.MAM_PERFORMANCE_REVIEW_ENABLED='true';
 for(const [role,audience] of [['employee','employee'],['manager','manager'],['admin','admin']]) {const data=document(audience);const h=harness({data,role});assert.deepEqual(await h.actions.getPerformanceReviewDocument(reviewId),{ok:true,document:data});assert.deepEqual(h.business(),[{name:'get_performance_review_document',args:{p_review_id:reviewId}}]);}
 for(const data of [{document:document()},{...document(),managerNote:'LEAK'},{...document(),meeting:null},{...document(),selfAnswers:[]},document('manager')]) {const h=harness({data});assert.equal((await h.actions.getPerformanceReviewDocument(reviewId)).ok,false);assert.equal(h.business().length,1);}
});
test('read errors distinguish definitive SQL denials from transient provider errors',async()=>{
 process.env.MAM_PERFORMANCE_REVIEW_ENABLED='true';
 for(const [error,expected] of [[{code:'42501',message:'PRIVATE'},'forbidden'],[{code:'PT409',message:'PRIVATE'},'conflict'],[{code:'XX000',message:'PRIVATE'},'unavailable']]) {
  const h=harness({error});const result=await h.actions.loadPerformanceReviews();assert.equal(result.code,expected);assert.equal(result.uncertain,false);assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);assert.equal(h.business().length,1);
 }
 const h=harness({authThrows:true});assert.equal((await h.actions.loadPerformanceReviews()).code,'unavailable');assert.equal(h.business().length,0);
});
test('500 or transport uncertainty dominates a misleading provider code without retry',async()=>{
 process.env.MAM_PERFORMANCE_REVIEW_ENABLED='true';
 for(const options of [{error:{code:'PT409',message:'PRIVATE'},status:500},{throws:true}]) {
  const h=harness({...options,role:'manager'});assert.equal((await h.actions.startPerformanceReview(start())).code,'uncertain');assert.equal(h.business().length,1);
  const b=harness(options);assert.equal((await b.actions.mutatePerformanceReview(mutation())).code,'uncertain');assert.equal(b.business().length,1);
  const r=harness(options);assert.equal((await r.actions.loadPerformanceReviews()).code,'unavailable');assert.equal(r.business().length,1);
 }
});
test('manager and HR scopes are checked for each receipt and read projection',async()=>{
 process.env.MAM_PERFORMANCE_REVIEW_ENABLED='true';
 const inputs={answers:Array(12).fill('Evidence'),ratings:Array(12).fill('2 Meets expectations'),summary:'Summary',overallRating:'2 Meets expectations',managerNote:'Private'};
 const m={...mutation(),expectedRevision:'manager:0:0',command:'save_manager',input:inputs};
 const valid=harness({role:'manager',data:{committed:true,operationId,review:review('manager')}});assert.equal((await valid.actions.mutatePerformanceReview(m)).ok,true);
 for(const role of ['admin','system_admin','account','employee']) {const h=harness({role});assert.equal((await h.actions.mutatePerformanceReview(m)).code,'forbidden');assert.equal(h.business().length,0);}
 const wrong=harness({data:{status:'committed',review:review('manager')}});assert.equal((await wrong.actions.reconcilePerformanceReviewOperation({operationId,reviewId})).ok,false);
 const r=review();delete r.selfRevision;const missing=harness({data:{committed:true,operationId,review:r}});assert.equal((await missing.actions.mutatePerformanceReview(mutation())).code,'uncertain');
 let reads=0;const privateGetter=review();Object.defineProperty(privateGetter,'managerNote',{get(){reads++;throw Error('PRIVATE');},enumerable:true});const invalid=harness({data:{committed:true,operationId,review:privateGetter}});assert.equal((await invalid.actions.mutatePerformanceReview(mutation())).uncertain,true);assert.equal(reads,0);
});
test('a 500 response cannot be promoted to success even with a well-shaped payload',async()=>{
 process.env.MAM_PERFORMANCE_REVIEW_ENABLED='true';
 const started=harness({role:'manager',status:500,data:{committed:true,operationId,review:review('manager'),existing:false}});assert.equal((await started.actions.startPerformanceReview(start())).code,'uncertain');
 const mutated=harness({status:500,data:{committed:true,operationId,review:review()}});assert.equal((await mutated.actions.mutatePerformanceReview(mutation())).code,'uncertain');
 const loaded=harness({status:500,data:{viewerContext:{actorUserId:actorId,personId,role:'employee',displayName:'Synthetic'},reviews:[review()],startablePeople:[]}});assert.equal((await loaded.actions.loadPerformanceReviews()).code,'unavailable');
 const reconciled=harness({status:500,data:{status:'not_found',review:null}});assert.equal((await reconciled.actions.reconcilePerformanceReviewOperation({operationId,reviewId})).code,'unavailable');
 const doc=harness({status:500,data:document()});assert.equal((await doc.actions.getPerformanceReviewDocument(reviewId)).code,'unavailable');
});
