// Offline evaluator of the EXACT graph/code emitted by the deployment helper.
// Only native HTTP and Outlook I/O are synthetic. This contract model is NOT
// evidence for PostgreSQL locking/ACLs; those have separate real-DB tests.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

export const canonical = value => [...new Set(value.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean))].sort().join(',');
export const callback = 'https://mam-team-management-system-ten.vercel.app/api/internal/integrations/notifications/receipts';
const edge = (...targets) => ({main:targets.map(node=>[{node,type:'main',index:0}])});
const condition = (outcome,id) => ({conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},conditions:[{id,leftValue:`={{ $json.outcome === '${outcome}' }}`,rightValue:'',operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}});
export function baselineFixture() {
  const code = name => ({id:name,name,type:'n8n-nodes-base.code',typeVersion:2,position:[0,0],parameters:{jsCode:'// synthetic pinned old source'}});
  return {id:'D6UG5ACZGILCpsOk',name:'MAM People System - Leave Email Delivery',versionId:'synthetic-reviewed-version',activeVersionId:null,active:false,
    nodes:[
      {id:'webhook',name:'Receive Leave Notification',type:'n8n-nodes-base.webhook',typeVersion:2.1,position:[0,0],parameters:{httpMethod:'POST',path:'mam-people-system-leave-hr-v1',authentication:'headerAuth',responseMode:'lastNode',options:{}},credentials:{httpHeaderAuth:{id:'synthetic-header',name:'Synthetic only'}}},
      code('Validate and Reserve Leave Notification'),
      {id:'send-if',name:'Send Leave Notification?',type:'n8n-nodes-base.if',typeVersion:2.2,position:[0,0],parameters:condition('send','leave-send-condition')},
      {id:'sender',name:'Send Leave Notification to HR',type:'n8n-nodes-base.microsoftOutlook',typeVersion:2,position:[0,0],credentials:{microsoftOutlookOAuth2Api:{id:'synthetic-outlook',name:'Synthetic only'}},parameters:{resource:'message',operation:'send',toRecipients:'={{ $json.deliveryRecipient }}',subject:'={{ $json.emailSubject }}',bodyContent:'={{ $json.emailHtml }}',additionalFields:{bodyContentType:'html',saveToSentItems:true,ccRecipients:"={{ ($json.ccRecipients || '').split(',').map(email => email.trim()).filter(Boolean) }}"}}},
      code('Confirm Leave HR Delivery'),
      {id:'duplicate-if',name:'Already Delivered?',type:'n8n-nodes-base.if',typeVersion:2.2,position:[0,0],parameters:condition('duplicate','leave-duplicate-condition')},
      code('Return Leave HR Duplicate'),code('Return Leave HR Rejection')],
    connections:{'Receive Leave Notification':edge('Validate and Reserve Leave Notification'),'Validate and Reserve Leave Notification':edge('Send Leave Notification?'),
      'Send Leave Notification?':edge('Send Leave Notification to HR','Already Delivered?'),'Send Leave Notification to HR':edge('Confirm Leave HR Delivery'),
      'Already Delivered?':edge('Return Leave HR Duplicate','Return Leave HR Rejection')},
    settings:{errorWorkflow:'UoQAe53Yu0fJ3ncq',executionOrder:'v1',executionTimeout:30,saveDataErrorExecution:'none',saveDataSuccessExecution:'none',saveExecutionProgress:false,timezone:'Australia/Melbourne'},
    staticData:{global:{leaveNotificationEvents:{}}}};
}
export const workflow = JSON.parse(execFileSync('python3',['-c',`import json,sys,runpy
m=runpy.run_path('scripts/deploy-notification-review.py')
w=json.load(sys.stdin)
print(json.dumps(m['patch'](w,m['fingerprint'](w))))`],{input:JSON.stringify(baselineFixture()),encoding:'utf8'}));

export class ReceiptApiModel {
  constructor(legacy={}) { this.rows=new Map(Object.entries(structuredClone(legacy))); this.requests=[]; this.ready=true; }
  request(body) {
    this.requests.push(structuredClone(body));
    const {eventKey}=body;
    const reject=(rejectionCode,extra={})=>({outcome:'rejected',ok:false,sent:false,alreadySent:false,eventKey,rejectionCode,reconciliationRequired:rejectionCode!=='delivery-in-flight',...extra});
    if(!this.ready) throw new Error('HTTP 503');
    const recipient=canonical(body.recipient),cc=canonical(body.cc);
    const evidence=row=>row.actualRecipient?{actualRecipient:row.actualRecipient,actualCcRecipients:row.actualCcRecipients,providerReceipt:row.providerReceipt}:{};
    if(body.action==='reserve') {
      const own=this.rows.get(eventKey),legacy=body.legacyEventKey&&this.rows.get(body.legacyEventKey),row=own||legacy;
      if(row) {
        const receiptEventKey=own?eventKey:body.legacyEventKey;
        if(row.state==='processing')return reject(Date.now()-row.at<20*60*1000?'delivery-in-flight':'receipt-delivery-unknown',{receiptEventKey});
        if(!row.actualRecipient||!row.providerReceipt)return reject('receipt-evidence-unavailable',{receiptEventKey});
        if(legacy&&!own)return reject('legacy-receipt-reconciliation',{receiptEventKey,...evidence(row)});
        if(recipient!==row.actualRecipient||cc!==row.actualCcRecipients)return reject('receipt-recipient-mismatch',{receiptEventKey,...evidence(row)});
        return {outcome:'duplicate',ok:true,sent:false,alreadySent:true,eventKey,...evidence(row)};
      }
      const deliveryToken=randomUUID();
      this.rows.set(eventKey,{state:'processing',at:Date.now(),recipient,cc,deliveryToken});
      return {outcome:'send',eventKey,deliveryToken};
    }
    assert.equal(body.action,'confirm');
    const row=this.rows.get(eventKey);
    if(!row||row.deliveryToken!==body.deliveryToken||row.recipient!==recipient||row.cc!==cc)throw new Error('HTTP 409');
    Object.assign(row,{state:'sent',actualRecipient:recipient,actualCcRecipients:cc,providerReceipt:body.providerReceipt});
    return {ok:true,sent:true,alreadySent:false,eventKey,...evidence(row)};
  }
}

export class Receiver {
  constructor({api=new ReceiptApiModel(),provider=()=>({statusCode:202}),graph=workflow}={}) {
    this.api=api;this.provider=provider;this.graph=graph;this.sends=[];this.calls=[];
  }
  expression(source,json) {
    assert(source.startsWith('={{')&&source.endsWith('}}'));
    return new Function('$json',`return (${source.slice(3,-2)});`)(json);
  }
  code(name,input,outputs={}) {
    const node=this.graph.nodes.find(n=>n.name===name);
    return new Function('$input','$','$json','$getWorkflowStaticData','fetch',node.parameters.jsCode)(
      {all:()=>input,first:()=>input[0]},name=>({all:()=>outputs[name]||[],first:()=>outputs[name]?.[0]}),input[0]?.json,
      ()=>{throw new Error('Static data must remain frozen');},()=>{throw new Error('Code network forbidden');});
  }
  walk(name,input,outputs={},stopAtSender=false) {
    while(name) {
      const node=this.graph.nodes.find(n=>n.name===name);assert(node,`Missing node ${name}`);
      this.calls.push(name);let port=0;
      if(node.type==='n8n-nodes-base.microsoftOutlook'&&stopAtSender)return {grant:input[0].json,outputs};
      if(stopAtSender&&['Return Leave HR Duplicate','Return Leave HR Rejection'].includes(name))return {preview:input[0].json,outputs};
      if(node.type==='n8n-nodes-base.code')input=this.code(name,input,outputs);
      else if(node.type==='n8n-nodes-base.if')port=this.expression(node.parameters.conditions.conditions[0].leftValue,input[0].json)?0:1;
      else if(node.type==='n8n-nodes-base.httpRequest') {
        assert.equal(node.parameters.url,callback);assert.equal(node.parameters.authentication,'genericCredentialType');
        assert.equal(node.parameters.genericAuthType,'httpHeaderAuth');assert.equal(node.retryOnFail,false);
        assert.equal(node.parameters.options.redirect.redirect.followRedirects,false);assert.equal(node.parameters.options.response.response.neverError,false);
        const body=this.expression(node.parameters.jsonBody,input[0].json);
        input=[{json:this.api.request(body)}];
      } else if(node.type==='n8n-nodes-base.microsoftOutlook') {
        assert.equal(node.retryOnFail,false);assert.equal(node.onError,'stopWorkflow');
        this.sends.push(structuredClone(input[0].json));
        const result=this.provider(input[0].json);input=Array.isArray(result)?result:[{json:result}];
      } else assert.equal(node.type,'n8n-nodes-base.webhook');
      outputs[name]=input;
      const next=this.graph.connections[name]?.main?.[port]||[];
      assert(next.length<=1,'No parallel/bypass sender paths');
      name=next[0]?.node;
    }
    return {result:input[0]?.json,outputs};
  }
  start(body,{stopAtSender=false,headers={'content-type':'application/json'}}={}) {
    return this.walk('Receive Leave Notification',[{json:{headers,body}}],{},stopAtSender);
  }
  run(body) {return this.start(body).result;}
}

const sessions=new WeakMap(),grants=new WeakMap();
export function receiverFor(state) {
  if(!sessions.has(state))sessions.set(state,new Receiver({api:new ReceiptApiModel(state.leaveNotificationEvents)}));
  return sessions.get(state);
}
export function prepare(body,state={}) {
  const receiver=receiverFor(state),paused=receiver.start(body,{stopAtSender:true});
  const output=paused.grant||paused.preview||paused.result;
  if(paused.grant)grants.set(output,{receiver,outputs:paused.outputs});
  return output;
}
export function confirmDelivery(grant,sent=[{json:{}}],state={}) {
  const session=grants.get(grant)||{receiver:receiverFor(state),outputs:{'Gate Durable Leave Reservation':[{json:grant}]}};
  return session.receiver.walk('Confirm Leave HR Delivery',sent,session.outputs).result;
}
