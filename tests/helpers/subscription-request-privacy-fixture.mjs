import assert from 'node:assert/strict';
import React from 'react';
import { File } from 'node:buffer';
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError, AuthUnknownError } from '@supabase/supabase-js';
import { loadModule, hooksHarness, nodes, text, flush } from './contact-lifetime-harness.mjs';

export const requestId = 'b1000000-0000-4000-8000-000000000101';
export const personId = 'a1000000-0000-4000-8000-000000000101';
export const payload = {kind:'new_purchase',service:'SYNTHETIC_PRIVATE_SERVICE',plan:'SYNTHETIC_PRIVATE_PLAN',purpose:'SYNTHETIC_PRIVATE_PURPOSE',company:'mam',payer:'Synthetic MAM',duration:'12 months',billing:'annual',currency:'AUD',tax:'Inclusive',quoteCents:100,audEstimateCents:100,payment:'card',cardLabel:'SYNTHETIC_PRIVATE_CARD_LABEL',cardHolder:'SYNTHETIC_PRIVATE_CARD_HOLDER',responsiblePersonId:personId,intendedUsers:'SYNTHETIC_PRIVATE_USERS'};
export const bytes = Buffer.from('%PDF-1\nSYNTHETIC_PRIVATE_FILE_BYTES\n');
export const evidence = {name:'SYNTHETIC_PRIVATE_HISTORY.pdf',mime:'application/pdf',bytes:bytes.length};
export const row = {id:requestId,applicant:personId,status:'returned',version:3,revision:1,evidenceVersion:1,payload,evidence:[evidence],events:[{version:1,operation:'submit',actor:personId,at:'2026-10-01T00:00:00Z',reason:'SYNTHETIC_PRIVATE_HISTORY_REASON',payload:{...payload,service:'SYNTHETIC_PRIVATE_HISTORY_PAYLOAD'},evidence:[evidence]}],canEdit:true,canDecide:true,canWithdraw:true};
export const workspace = {enabled:true,canApply:true,requests:[row,{...row,id:'b1000000-0000-4000-8000-000000000102',payload:{...payload,service:'SYNTHETIC_PRIVATE_LIST_SIBLING'}}],people:[{id:personId,name:'SYNTHETIC_PRIVATE_PERSON'}]};
export const initialPayload = {kind:'new_purchase',company:'mam',billing:'annual',currency:'AUD',payment:'non_card'};
export const actionNames = ['loadSubscriptionRequests','mutateSubscriptionRequest','downloadRequestEvidence'];
export const actionArgs = {loadSubscriptionRequests:[],mutateSubscriptionRequest:[{id:requestId,version:3,operation:'approve',payload,reason:'SYNTHETIC_PRIVATE_DECISION'}],downloadRequestEvidence:[requestId,1,0]};
export const denialScenarios = ['no-user','sdk-session-missing','sdk-session-missing-thrown','auth-401','auth-403','sql-42501'];

export function actionHarness(scenario='success') {
  const calls = [], authCalls = [], results = [];
  let current = scenario;
  const auth = async () => {
    authCalls.push(current);
    const missing = new AuthSessionMissingError();
    if(current==='no-user') return {data:{user:null},error:null};
    if(current==='sdk-session-missing') return {data:{user:null},error:missing};
    if(current==='sdk-session-missing-thrown') throw missing;
    if(current==='auth-401') return {data:{user:null},error:new AuthApiError('SYNTHETIC_PROVIDER_SECRET',401,'bad_jwt')};
    if(current==='auth-403') return {data:{user:null},error:new AuthApiError('SYNTHETIC_PROVIDER_SECRET',403,'user_banned')};
    if(current==='retryable-0') return {data:{user:null},error:new AuthRetryableFetchError('SYNTHETIC_PROVIDER_SECRET',0)};
    if(current==='retryable-503') return {data:{user:null},error:new AuthRetryableFetchError('SYNTHETIC_PROVIDER_SECRET',503)};
    if(current==='retryable-thrown') throw new AuthRetryableFetchError('SYNTHETIC_PROVIDER_SECRET',503);
    if(current==='auth-500') return {data:{user:null},error:new AuthApiError('SYNTHETIC_PROVIDER_SECRET',500,'unexpected_failure')};
    if(current==='auth-unknown-400') return {data:{user:null},error:new AuthApiError('SYNTHETIC_PROVIDER_SECRET',400,'unexpected_failure')};
    if(current==='auth-unknown') return {data:{user:null},error:new AuthUnknownError('SYNTHETIC_PROVIDER_SECRET',new Error('SYNTHETIC_PROVIDER_SECRET'))};
    if(current==='auth-error-with-user') return {data:{user:{id:personId}},error:new AuthRetryableFetchError('SYNTHETIC_PROVIDER_SECRET',503)};
    if(current==='transport-thrown') throw new Error('SYNTHETIC_PROVIDER_SECRET');
    if(current==='untrusted-message') return {data:{user:null},error:new Error('You do not have permission for this request.')};
    return {data:{user:{id:personId}},error:null};
  };
  const rpc = async (name,args) => {
    calls.push({name,args});
    if(current==='sql-42501') return {data:null,error:{code:'42501',message:'SYNTHETIC_PROVIDER_SECRET',details:'SYNTHETIC_PROVIDER_SECRET'}};
    if(['PT409','22023','55000','XX000'].includes(current)) return {data:null,error:{code:current,message:'SYNTHETIC_PROVIDER_SECRET'}};
    if(current==='rpc-thrown') throw new Error('SYNTHETIC_PROVIDER_SECRET');
    if(current==='malformed') return {data:{malformed:true},error:null};
    if(name==='sr_workspace') return {data:structuredClone(workspace),error:null};
    if(name==='sr_mutate') return {data:{...structuredClone(row),version:4,payload:args.p_payload??structuredClone(payload)},error:null};
    if(name==='sr_download') return {data:{name:evidence.name,mime:evidence.mime,base64:bytes.toString('base64')},error:null};
    throw new Error('Unexpected RPC');
  };
  const actual = loadModule('src/app/subscription-requests/actions.ts', {'@/lib/supabase/server':{createClient:async()=>({auth:{getUser:auth},rpc})}});
  assert.deepEqual(Object.keys(actual).sort(),[...actionNames].sort());
  const actions = Object.fromEntries(actionNames.map(name=>[name,async(...args)=>{ const result=await actual[name](...args); results.push({name,result}); return result; }]));
  return {actions,calls,authCalls,results,setScenario(value){current=value;}};
}

export function componentHarness({scenario='success',newDraft=false}={}) {
  const h = actionHarness(scenario), hook = hooksHarness(React);
  let tree, cursor=0, state=[];
  const trackedReact={...hook.react,useState(initial){const index=cursor++; const answer=hook.react.useState(initial);state[index]=answer[0];return answer;}};
  const {SubscriptionRequests}=loadModule('src/components/subscription-requests.tsx',{'react':trackedReact,'@/app/subscription-requests/actions':h.actions});
  const render=()=>{for(let i=0;i<30;i++){cursor=0;state=[];hook.begin();tree=SubscriptionRequests({initial:structuredClone(workspace),selectedId:newDraft?undefined:requestId});hook.effects();if(!hook.dirty())return tree;}throw new Error('Render did not settle');};
  const find=(type,predicate)=>nodes(tree).find(n=>n.type===type&&predicate(n.props));
  const button=name=>{const n=find('button',p=>text(p.children)===name);assert.ok(n,'Missing button '+name);return n;};
  const control=label=>{const l=find('label',p=>nodes(p.children).some(n=>['input','textarea','select'].includes(n.type))&&text(p.children).startsWith(label));assert.ok(l,'Missing label '+label);return nodes(l.props.children).find(n=>['input','textarea','select'].includes(n.type));};
  const change=(label,value)=>{control(label).props.onChange({target:{value}});render();};
  const click=async name=>{button(name).props.onClick();for(let i=0;i<4;i++)await flush();render();};
  render();
  if(newDraft){button('New request').props.onClick();render();change('Service','SYNTHETIC_PRIVATE_UNSAVED_DRAFT');}
  return {...h,render,button,control,change,click,tree:()=>tree,state:()=>state,async settle(){for(let i=0;i<4;i++)await flush();render();},chooseFile(){const file=new File([bytes],'SYNTHETIC_PRIVATE_SELECTED_FILE.pdf',{type:'application/pdf'});find('input',p=>p.type==='file').props.onChange({target:{files:[file]}});render();return file;},currentText:()=>text(tree),form:()=>find('form',()=>true)};
}

export function installFileReader() {
  globalThis.FileReader=class {
    readAsDataURL(file){file.arrayBuffer().then(buffer=>{this.result='data:'+file.type+';base64,'+Buffer.from(buffer).toString('base64');this.onload();},()=>this.onerror());}
  };
}
