import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { loadModule, hooksHarness, nodes, text, flush, deferred } from './helpers/unified-role-harness.mjs';

const id='33000000-0000-4000-8000-000000000001';
const row={subscription_id:id,service_name:'Synthetic review service',next_review_on:'2026-10-13',subscription_status:'active',version:4};
test('subscription review parser exposes only safe task fields and uses the Melbourne due date',()=>{
  const {parseSubscriptionReviewTasks}=loadModule('src/lib/subscription-review-tasks.ts');
  assert.equal(typeof parseSubscriptionReviewTasks,'function','subscription review tasks need a safe parser');
  const [task]=parseSubscriptionReviewTasks([{...row,password:'synthetic-not-a-credential',credit_card_holder:'synthetic card'}],new Date('2026-10-12T13:30:00Z'));
  assert.deepEqual(task,{subscriptionId:id,serviceName:row.service_name,nextReviewOn:row.next_review_on,status:'active',version:4,canComplete:true});
  assert.equal(parseSubscriptionReviewTasks([row],new Date('2026-10-12T12:30:00Z'))[0].canComplete,false);
});

function actionHarness({error=null,session=true,revalidateError=false,data={...row,next_review_on:'2027-01-04',version:5}}={}){
  const calls=[], revalidated=[];
  const client={auth:{getUser:async()=>({data:{user:session?{id}:null},error:null})},rpc:async(name,args)=>{calls.push({name,args});return {data,error};}};
  const actions=loadModule('src/app/subscriptions/review-task-actions.ts',{
    '@/lib/supabase/server':{createClient:async()=>client},
    'next/cache':{revalidatePath(path){revalidated.push(path);if(revalidateError)throw new Error('synthetic cache failure');}},
  });
  assert.equal(typeof actions.completeMySubscriptionReviewTask,'function','subscription review tasks need a real Server Action');
  return {action:actions.completeMySubscriptionReviewTask,calls,revalidated};
}

test('responsible-person Done sends exact optimistic version and returns a safe task',async()=>{
  const h=actionHarness();
  const result=await h.action({subscriptionId:id,version:4});
  assert.equal(result.ok,true);
  assert.equal(result.task.version,5);
  assert.deepEqual(h.calls,[{name:'complete_my_subscription_review_task',args:{p_subscription_id:id,p_expected_version:4}}]);
  assert.deepEqual(h.revalidated,['/']);
});

test('People Tasks enables scoped subscription reviews independently and keeps Change Profile read-only',()=>{
  for(const previewPersonId of [undefined,id]) for(const enabled of [true,false]){
    const hooks=hooksHarness(React), calls=[];
    const {CheckInTasks}=loadModule('src/components/check-in-tasks.tsx',{
      react:hooks.react,
      '@/components/subscription-password-tasks':{useSubscriptionPasswordTasks:()=>({tasks:[],loading:false,error:'',notice:'',pendingId:'',load:async()=>{},complete:()=>{}})},
      '@/components/subscription-review-tasks':{useSubscriptionReviewTasks:options=>{
        calls.push(options);
        return {tasks:[],loading:false,error:'',notice:'',pendingId:'',load:async()=>{},complete:async()=>{}};
      }},
      '@/components/ui/use-media-query':{useMediaQuery:()=>false},
      '@/components/ui/use-dialog-focus':{useDialogFocus:()=>{}},
      '@/lib/supabase/client':{createClient:()=>({})},
    });
    hooks.begin();
    CheckInTasks({previewPersonId,readOnly:false,showCheckInTasks:false,showSubscriptionReviewTasks:enabled});
    assert.equal(calls.length,1,'the actual People Tasks renderer must use the scoped subscription hook');
    assert.equal(calls[0].previewPersonId,previewPersonId);
    assert.equal(calls[0].readOnly,Boolean(previewPersonId));
    assert.equal(calls[0].enabled,enabled);
  }
});

for(const change of [{version:0},{version:1.5},{version:Number.MAX_SAFE_INTEGER+1},{subscription_status:'cancelled'},{next_review_on:'2026-02-30'},{subscription_id:'invalid'}]) test('subscription task parser rejects malformed '+JSON.stringify(change),()=>{
  const {parseSubscriptionReviewTasks}=loadModule('src/lib/subscription-review-tasks.ts');
  assert.throws(()=>parseSubscriptionReviewTasks([{...row,...change}]),/could not be loaded/);
});
for(const input of [{subscriptionId:'invalid',version:1},{subscriptionId:id,version:0},{subscriptionId:id,version:4,previewPersonId:id}]) test('Done rejects unsafe input before any database write '+JSON.stringify(input),async()=>{
  const h=actionHarness();assert.equal((await h.action(input)).ok,false);assert.deepEqual(h.calls,[]);
});
for(const code of ['40001','42501','22023','XX000']) test('Done returns safe serializable '+code+' rejection',async()=>{
  const h=actionHarness({error:{code,message:'synthetic-private-provider-detail'}});
  const result=await h.action({subscriptionId:id,version:4});
  assert.equal(result.ok,false);assert.doesNotMatch(JSON.stringify(result),/synthetic-private/);
  if(code==='40001')assert.match(result.error,/has changed/);
  assert.deepEqual(h.revalidated,[]);
});
test('Done requires authenticated session',async()=>{
  const h=actionHarness({session:false});assert.equal((await h.action({subscriptionId:id,version:4})).ok,false);assert.deepEqual(h.calls,[]);
});
for(const options of [{revalidateError:true},{data:null},{data:{...row,version:90}}]) test('acknowledged review remains committed after follow-up failure '+JSON.stringify(options),async()=>{
  const h=actionHarness(options);const result=await h.action({subscriptionId:id,version:4});assert.equal(result.ok,true);assert.match(result.warning,/was recorded/);assert.equal(h.calls.length,1);
});
function taskUI({previewPersonId,completion,rows=[{...row,next_review_on:'2000-01-01'},{...row,subscription_id:id.replace(/1$/,'2'),service_name:'Synthetic future service',next_review_on:'2500-01-01'}]}={}){
  const hooks=hooksHarness(React), timers=new Map(), calls=[];let timerId=0, response={data:rows,error:null};
  globalThis.window={setTimeout(fn){const id=++timerId;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);}};
  const {SubscriptionReviewTasks}=loadModule('src/components/subscription-review-tasks.tsx',{
    react:hooks.react,
    '@/lib/supabase/client':{createClient:()=>({rpc:async(name,args)=>{calls.push(['read',name,args]);return response;}})},
    '@/app/subscriptions/review-task-actions':{completeMySubscriptionReviewTask:async input=>{calls.push(['write',input]);return completion?await completion.promise:{ok:true,task:{subscriptionId:id,serviceName:row.service_name,nextReviewOn:'2500-01-01',status:'active',version:5,canComplete:false}};}},
  });
  const render=()=>{hooks.begin();const tree=SubscriptionReviewTasks({previewPersonId});hooks.effects();return tree;};
  return {calls,render,setResponse(value){response=value;},async settle(){for(let i=0;i<3;i++){render();for(const [id,fn]of [...timers]){timers.delete(id);fn();}await flush();}return render();}};
}
test('actual task component disables future reviews, sends version once and updates the next due date',async()=>{
  const completion=deferred(),ui=taskUI({completion});let tree=await ui.settle();
  const buttons=nodes(tree).filter(n=>n.type==='button'&&String(n.props['aria-label']).startsWith('Mark '));
  assert.equal(buttons[0].props.disabled,false);assert.equal(buttons[1].props.disabled,true);
  buttons[0].props.onClick();buttons[0].props.onClick();tree=ui.render();
  assert.ok(nodes(tree).filter(n=>n.type==='button'&&String(n.props['aria-label']).startsWith('Mark ')).every(n=>n.props.disabled));
  assert.deepEqual(ui.calls.filter(c=>c[0]==='write'),[['write',{subscriptionId:id,version:4}]]);
  completion.resolve({ok:true,task:{subscriptionId:id,serviceName:row.service_name,nextReviewOn:'2500-01-01',status:'active',version:5,canComplete:false}});
  tree=await ui.settle();assert.match(text(tree),/review is complete/);
  assert.ok(nodes(tree).filter(n=>n.type==='button'&&String(n.props['aria-label']).startsWith('Mark ')).every(n=>n.props.disabled));
});
test('actual preview component uses only the selected read RPC and exposes no Done control',async()=>{
  const ui=taskUI({previewPersonId:id});const tree=await ui.settle();
  assert.deepEqual(ui.calls,[['read','list_subscription_review_tasks_for_preview',{p_person_id:id}]]);
  assert.equal(nodes(tree).filter(n=>n.type==='button'&&String(n.props['aria-label']).startsWith('Mark ')).length,0);
  assert.match(text(tree),/Synthetic review service/);
});
test('denied task refresh clears all cached tasks and completion feedback',async()=>{
  const ui=taskUI();let tree=await ui.settle();nodes(tree).find(n=>n.type==='button'&&String(n.props['aria-label']).startsWith('Mark ')).props.onClick();tree=await ui.settle();
  assert.match(text(tree),/review is complete/);
  ui.setResponse({data:null,error:{code:'42501'}});
  nodes(tree).find(n=>n.type==='button'&&n.props['aria-label']==='Refresh subscription review tasks').props.onClick();
  tree=await ui.settle();assert.doesNotMatch(text(tree),/Synthetic review service|review is complete/);assert.match(text(tree),/could not be loaded/);
});

test('subscription review due labels stay on the Melbourne civil date in another browser timezone',async()=>{
  const previous=process.env.TZ;process.env.TZ='Pacific/Auckland';
  try {const tree=await taskUI().settle();assert.match(text(tree),/Due 1 Jan 2500/);}
  finally {if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});
