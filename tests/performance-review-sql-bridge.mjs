import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {target,postgresEnv} from '../scripts/local-test-postgres.mjs';
import {loadModule} from './helpers/contact-lifetime-harness.mjs';
const q=v=>v===null?'null':"'"+String(v).replaceAll("'","''")+"'";
const user=i=>`a1000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
const person=i=>`b1000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
let sequence=1;
const operation=()=>`e1000000-0000-4000-8000-${String(sequence++).padStart(12,'0')}`;
const meeting={date:'2026-01-02',time:'23:55',duration:10,mode:'teams',location:'https://teams.microsoft.com/l/meetup-join/synthetic',notes:'Synthetic meeting'};
export async function runPerformanceActionSqlBridge(socket,database) {
 process.env.MAM_PERFORMANCE_REVIEW_ENABLED='true';
 const calls=[];let current=2,authCalls=0,dropNextMutation=false,corruptNextMutation=false;
 const rpc=async(name,args={})=>{
  calls.push({name,args,actor:current});
  const rpcArgs={get_portal_role_capabilities:['p_person_id'],performance_review_workspace:[],start_performance_review:['p_operation_id','p_employee_person_id','p_cycle','p_due_date'],mutate_performance_review:['p_operation_id','p_review_id','p_expected_revision','p_command','p_input'],get_performance_review_operation:['p_operation_id','p_review_id'],get_performance_review_document:['p_review_id']};
  assert.ok(Object.hasOwn(rpcArgs,name),'No unapproved SQL or provider dispatch');assert.deepEqual(Object.keys(args).sort(),rpcArgs[name].slice().sort());
  const parameters=rpcArgs[name].map(k=>k==='p_input'?q(JSON.stringify(args[k]))+'::jsonb':q(args[k])).join(',');
  const query=name==='get_portal_role_capabilities'?`select coalesce(jsonb_agg(r),'[]') from public.get_portal_role_capabilities(${parameters}) r;`:`select public.${name}(${parameters});`;
  const result=spawnSync('psql',[...target(socket,database),'-Atq','-v','VERBOSITY=verbose','-f','-'],{env:postgresEnv,input:`begin;set local role authenticated;select set_config('request.jwt.claims',${q(JSON.stringify({sub:user(current),iat:1900000000}))},true);${query}commit;`,encoding:'utf8'});
  if(result.status!==0) {const code=/ERROR:\s+([A-Z0-9]{5}):/.exec(result.stderr)?.[1];console.log('NATIVE_EXPECTED_REJECTION '+JSON.stringify({name,code,actualExitCode:result.status}));return {data:null,error:{code,message:'Synthetic private SQL detail'},status:code==='PT409'?409:code==='42501'?403:code==='22023'?400:500};}
  const data=JSON.parse(result.stdout.trim().split('\n').at(-1));
  if(name==='mutate_performance_review'&&dropNextMutation){dropNextMutation=false;throw Error('Synthetic response loss after actual PostgreSQL commit');}
  if(name==='mutate_performance_review'&&corruptNextMutation){corruptNextMutation=false;return {data:{committed:true},error:null,status:200};}
  return {data,error:null,status:200};
 };
 const actions=loadModule('src/app/performance-reviews/actions.ts',{'@/lib/supabase/server':{createClient:async()=>({auth:{getUser:async()=>{authCalls++;return {data:{user:{id:user(current)}},error:null};}},rpc})}});
 const load=async i=>{current=i;const r=await actions.loadPerformanceReviews();assert.equal(r.ok,true,JSON.stringify(r));return r.data;};
 const start=async(manager,employee)=>{current=manager;const r=await actions.startPerformanceReview({operationId:operation(),employeePersonId:person(employee),cycle:'2026',dueDate:'2026-12-31'});assert.equal(r.ok,true,JSON.stringify(r));return r.review;};
 const mutate=async(i,r,command,input)=>{current=i;const operationId=operation();const request={operationId,reviewId:r.id,expectedRevision:command.endsWith('_self')?r.selfRevision:r.managerRevision,command,input};const count=calls.length;const result=await actions.mutatePerformanceReview(request);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(calls.slice(count).filter(c=>c.name==='mutate_performance_review').length,1);return {review:result.review,request};};
 await load(1);await start(2,1);let self=(await load(1)).reviews[0];self=(await mutate(1,self,'save_self',{answers:Array(12).fill('Draft')})).review;
 const submitted=await mutate(1,self,'submit_self',{answers:Array(12).fill('Native self evidence')});self=submitted.review;const selfBytes=JSON.stringify(self);
 let manager=(await load(2)).reviews.find(r=>r.id===self.id);const assessment={answers:Array(12).fill('Native manager evidence'),ratings:Array(12).fill('2 Meets expectations'),summary:'Native summary',overallRating:'3 Exceeds expectations',managerNote:'Private manager note'};
 for(const command of ['save_manager','complete_manager','save_meeting','save_manager','complete_manager','submit_review']) {const input=command==='save_meeting'?meeting:command==='submit_review'?{...meeting,held:true}:assessment;manager=(await mutate(2,manager,command,input)).review;assert.equal(JSON.stringify((await load(1)).reviews[0]),selfBytes);}
 for(const i of [1,2,4,5]) {current=i;const doc=await actions.getPerformanceReviewDocument(self.id);assert.equal(doc.ok,true,JSON.stringify(doc));assert.equal(Object.hasOwn(doc.document,'managerNote'),false);if(i===1) assert.equal(Object.hasOwn(doc.document,'meeting'),false);}
 current=1;assert.equal((await actions.reconcilePerformanceReviewOperation({operationId:submitted.request.operationId,reviewId:self.id})).data.status,'committed');assert.equal((await actions.reconcilePerformanceReviewOperation({operationId:operation(),reviewId:self.id})).data.status,'not_found');
 const collision=await actions.mutatePerformanceReview({...submitted.request,input:{answers:Array(12).fill('Different body')}});assert.equal(collision.code,'conflict');
 await start(2,6);const account=(await load(6)).reviews[0];await mutate(6,account,'save_self',{answers:Array(12).fill('Account self')});
 current=6;
 for(const fault of ['lost','malformed']) {
  const authoritative=(await load(6)).reviews[0];current=6;
  const request={operationId:operation(),reviewId:authoritative.id,expectedRevision:authoritative.selfRevision,command:'save_self',input:{answers:Array(12).fill('Native commit with '+fault+' receipt')}};
  if(fault==='lost')dropNextMutation=true;else corruptNextMutation=true;
  const writesBefore=calls.filter(c=>c.name==='mutate_performance_review').length;
  const result=await actions.mutatePerformanceReview(request);assert.equal(result.code,'uncertain');assert.equal(result.uncertain,true);
  assert.equal(calls.filter(c=>c.name==='mutate_performance_review').length,writesBefore+1);
  const reconciled=await actions.reconcilePerformanceReviewOperation({operationId:request.operationId,reviewId:request.reviewId});assert.equal(reconciled.ok,true);assert.equal(reconciled.data.status,'committed');assert.equal(reconciled.data.review.selfAnswers[0],'Native commit with '+fault+' receipt');
  assert.equal(calls.filter(c=>c.name==='mutate_performance_review').length,writesBefore+1);
  console.log('PASS: actual native commit with '+fault+' response stays uncertain until explicit read-only receipt reconciliation, with one write');
 }
 await start(9,2);const own=(await load(2)).reviews.find(r=>r.employee.id===person(2));assert.equal(own.audience,'employee');await mutate(2,own,'save_self',{answers:Array(12).fill('Manager self')});
 current=2;assert.equal((await actions.mutatePerformanceReview({operationId:operation(),reviewId:own.id,expectedRevision:'manager:0:0',command:'save_manager',input:assessment})).code,'forbidden');
 await start(8,7);const equipsy=(await load(7)).reviews[0];assert.equal(equipsy.employee.company,'Equipsy');await mutate(7,equipsy,'submit_self',{answers:Array(12).fill('Equipsy self')});
 current=7;const doc=await actions.getPerformanceReviewDocument(equipsy.id);assert.equal(doc.ok,true);assert.equal(doc.document.employee.company,'Equipsy');
 for(const i of [4,5]){const workspace=await load(i);assert.ok(workspace.reviews.every(r=>r.audience==='admin'&&r.capabilities.saveManager===false));current=i;assert.equal((await actions.mutatePerformanceReview({operationId:operation(),reviewId:self.id,expectedRevision:'manager:2:6',command:'save_manager',input:assessment})).code,'forbidden');}
 console.log('PASS: actual five Actions + existing native role policy + authenticated PostgreSQL RPCs with synthetic getUser for all audiences and six commands');
 console.log('BRIDGE_COUNTS '+JSON.stringify({authBoundary:'synthetic getUser; NOT GoTrue',authCalls,rpcCalls:calls.length,businessRpcCalls:calls.filter(c=>c.name!=='get_portal_role_capabilities').length,providerOperations:0}));
}
