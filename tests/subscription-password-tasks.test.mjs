import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { loadModule, hooksHarness, nodes, text, flush, deferred } from './helpers/unified-role-harness.mjs';

const id='34000000-0000-4000-8000-000000000001';
const subscriptionId='33000000-0000-4000-8000-000000000001';
const row={task_id:id,subscription_id:subscriptionId,service_name:'Synthetic password service',due_on:'2000-01-01',version:1};
const task={taskId:id,subscriptionId,serviceName:row.service_name,dueOn:row.due_on,version:1};

test('password task parser strips credentials, departed identity and exit details',()=>{
  const {parseSubscriptionPasswordTasks}=loadModule('src/lib/subscription-password-tasks.ts');
  assert.deepEqual(parseSubscriptionPasswordTasks([{...row,departed_person_id:id,archive_reason:'synthetic-private',password:'synthetic-private'}]),[task]);
  for(const change of [{task_id:'invalid'},{subscription_id:'invalid'},{due_on:'2026-02-30'},{version:0},{version:1.5},{service_name:''}])assert.throws(()=>parseSubscriptionPasswordTasks([{...row,...change}]),/could not be loaded/);
  assert.throws(()=>parseSubscriptionPasswordTasks([row,row]),/could not be loaded/);
});

function actionHarness({error=null,data={task_id:id,version:2,completed:true},session=true,revalidateError=false}={}){
  const calls=[];
  const {completeMySubscriptionPasswordTask}=loadModule('src/app/subscriptions/password-task-actions.ts',{
    '@/lib/supabase/server':{createClient:async()=>({auth:{getUser:async()=>({data:{user:session?{id}:null},error:null})},rpc:async(name,args)=>{calls.push({name,args});return {data,error};}})},
    'next/cache':{revalidatePath(){if(revalidateError)throw Error('synthetic-private-cache');}},
  });
  return {action:completeMySubscriptionPasswordTask,calls};
}
test('Password changed confirms the manual action with exact CAS and real session',async()=>{
  const h=actionHarness();assert.deepEqual(await h.action({taskId:id,version:1,passwordChanged:true}),{ok:true});
  assert.deepEqual(h.calls,[{name:'complete_my_subscription_password_task',args:{p_task_id:id,p_expected_version:1,p_password_changed:true}}]);
});
test('password task rejects absent confirmation, preview, invalid identifiers and sessions before RPC',async()=>{
  for(const input of [{taskId:id,version:1,passwordChanged:false},{taskId:id,version:1,passwordChanged:true,previewPersonId:id},{taskId:'invalid',version:1,passwordChanged:true},{taskId:id,version:0,passwordChanged:true}]){
    const h=actionHarness();assert.equal((await h.action(input)).ok,false);assert.deepEqual(h.calls,[]);
  }
  const h=actionHarness({session:false});assert.equal((await h.action({taskId:id,version:1,passwordChanged:true})).ok,false);assert.deepEqual(h.calls,[]);
});
test('password task failures sanitize provider detail; committed follow-up failures stay committed',async()=>{
  for(const code of ['40001','42501','XX000']){
    const h=actionHarness({error:{code,message:'synthetic-private'}});const result=await h.action({taskId:id,version:1,passwordChanged:true});
    assert.equal(result.ok,false);assert.doesNotMatch(JSON.stringify(result),/synthetic-private/);
  }
  for(const options of [{data:null},{revalidateError:true}]){
    const h=actionHarness(options);const result=await h.action({taskId:id,version:1,passwordChanged:true});assert.equal(result.ok,true);assert.match(result.warning,/was recorded/);assert.equal(h.calls.length,1);
  }
});

function hookUI({previewPersonId,completion}={}){
  const hooks=hooksHarness(React),timers=new Map(),calls=[];let response={data:[row],error:null},timerId=0;
  globalThis.window={setTimeout(fn){const id=++timerId;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);}};
  const {useSubscriptionPasswordTasks}=loadModule('src/components/subscription-password-tasks.tsx',{
    react:hooks.react,
    '@/lib/supabase/client':{createClient:()=>({rpc:async(name,args)=>{calls.push(['read',name,args]);return response;}})},
    '@/app/subscriptions/password-task-actions':{completeMySubscriptionPasswordTask:async input=>{calls.push(['write',input]);return completion?await completion.promise:{ok:true};}},
  });
  const Render=()=>{hooks.begin();const result=useSubscriptionPasswordTasks({previewPersonId});hooks.effects();return result;};
  return {calls,render:Render,setResponse(value){response=value;},async settle(){for(let i=0;i<3;i++){Render();for(const[id,fn]of [...timers]){timers.delete(id);fn();}await flush();}return Render();}};
}
test('password hook prevents duplicate completion and removes the shared completed task',async()=>{
  const completion=deferred(),ui=hookUI({completion});let result=await ui.settle();
  result.complete(result.tasks[0]);result.complete(result.tasks[0]);assert.equal(ui.calls.filter(call=>call[0]==='write').length,1);assert.equal(ui.render().pendingId,id);
  completion.resolve({ok:true});result=await ui.settle();assert.deepEqual(result.tasks,[]);assert.match(result.notice,/password change is recorded/);
});
test('password preview is read-only and denied refresh clears cached tasks',async()=>{
  const preview=hookUI({previewPersonId:id});let result=await preview.settle();result.complete(result.tasks[0]);
  assert.deepEqual(preview.calls,[['read','list_subscription_password_tasks_for_preview',{p_person_id:id}]]);
  const ui=hookUI();result=await ui.settle();ui.setResponse({data:null,error:{code:'42501'}});await result.load();result=ui.render();assert.deepEqual(result.tasks,[]);assert.equal(result.notice,'');assert.match(result.error,/could not be loaded/);
});
test('unified Tasks has password filter and explicit completion without private notes',()=>{
  const hooks=hooksHarness(React),calls=[];
  const {CheckInTasks}=loadModule('src/components/check-in-tasks.tsx',{
    react:hooks.react,
    '@/components/subscription-review-tasks':{useSubscriptionReviewTasks:()=>({tasks:[],loading:false,error:'',notice:'',pendingId:'',load:async()=>{}})},
    '@/components/subscription-password-tasks':{useSubscriptionPasswordTasks:()=>({tasks:[task],loading:false,error:'',notice:'',pendingId:'',load:async()=>{},complete:t=>calls.push(t)})},
    '@/components/ui/use-media-query':{useMediaQuery:()=>false},'@/components/ui/use-dialog-focus':{useDialogFocus:()=>{}},
    '@/lib/supabase/client':{createClient:()=>({})},
  });
  const render=()=>{hooks.begin();return CheckInTasks({showCheckInTasks:false});};
  let tree=render();assert.match(text(tree),/Subscription passwords/);
  nodes(tree).find(node=>node.type==='button'&&String(node.props['aria-label']).startsWith('Open Synthetic password')).props.onClick();tree=render();
  assert.equal(nodes(tree).some(node=>node.props?.target?.kind==='subscription_password'),false,'Password tasks must not mount the notes editor');
  const button=nodes(tree).find(node=>node.type==='button'&&String(node.props['aria-label']).startsWith('Confirm Synthetic password'));
  assert.equal(button.props.disabled,false);assert.match(text(button),/Password changed/);button.props.onClick();assert.deepEqual(calls,[task]);
});
