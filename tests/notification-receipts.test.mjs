import test from 'node:test';
import assert from 'node:assert/strict';
import {Receiver,ReceiptApiModel,workflow,canonical} from './notification-workflow-harness.mjs';
const id='10000000-0000-4000-8000-000000000001';
const provider={statusCode:202,id:'synthetic-provider-id',headers:{'request-id':'synthetic-request-id'},privateBody:'DO NOT STORE'};
const proof={accepted:true,messageId:provider.id,requestId:provider.headers['request-id'],statusCode:202};
function leave(event,company='mam',extra={}) {
  return {version:1,event,eventKey:`leave:${id}:${event}:${'a'.repeat(24)}`,requestId:id,
    employeeName:'Synthetic Employee',employeeEmail:'employee@example.test',company,leaveType:'Annual leave',
    startDate:'2026-10-01',endDate:'2026-10-02',startTime:null,endTime:null,days:2,hours:null,
    status:'Pending',employeeNote:'PRIVATE HR NOTE',managerNote:null,managerEmail:'manager@example.test',
    ...(event==='leave-submitted'?{audience:'reviewers'}:{}),...extra};
}
const branches=[];
for(const company of ['mam','equipsy'])for(const event of ['leave-submitted','leave-approved','leave-declined','leave-conditionally-approved','leave-cancelled','leave-reminder','team-birthday']) {
  branches.push([`${company} ${event}`,leave(event,company)]);
  if(event==='leave-submitted')branches.push([`${company} employee submission`,leave(event,company,{audience:'employee'})]);
}
branches.push(['payroll balance',{version:1,event:'payroll-balance-reminder',eventKey:`payroll-balance:${id}:2026-10`,requestId:id,recipientName:'Synthetic Payroll',recipientEmail:'payroll@example.test',reminderMonth:'2026-10-01',missingCompanies:['mam','equipsy']}]);
branches.push(['comparison',{version:1,event:'payroll-comparison-alert',eventKey:`payroll-comparison:${id}`,batchId:id,differenceCount:2}]);

for(const [name,body] of branches) {
  test(`${name}: exact deployed graph grants once, confirms original evidence, replays without sending`,()=>{
    const r=new Receiver({provider:()=>provider});
    const first=r.run(body),replay=r.run(body);
    assert.equal(r.sends.length,1);assert.equal(first.sent,true);assert.equal(replay.alreadySent,true);
    assert.equal(first.actualRecipient,canonical(r.sends[0].deliveryRecipient));
    assert.equal(first.actualCcRecipients,canonical(r.sends[0].ccRecipients));
    assert.deepEqual(first.providerReceipt,proof);assert.deepEqual(replay.providerReceipt,proof);
    assert.equal(replay.actualRecipient,first.actualRecipient);
    assert.deepEqual(r.api.requests.map(b=>b.action),['reserve','confirm','reserve']);
    for(const request of r.api.requests) {
      assert.deepEqual(Object.keys(request).sort(),(request.action==='reserve'?['action','eventKey','recipient','cc','legacyEventKey']:['action','eventKey','recipient','cc','deliveryToken','providerReceipt']).sort());
      assert(!JSON.stringify(request).includes('PRIVATE HR NOTE'));assert(!JSON.stringify(request).includes('Synthetic Employee'));
    }
    assert(!JSON.stringify(first).includes('deliveryToken'));assert(!JSON.stringify(first).includes('DO NOT STORE'));
  });
  for(const field of ['actualRecipient','actualCcRecipients'])test(`${name}: original ${field} mismatch is not relabelled as current recipients`,()=>{
    const r=new Receiver({provider:()=>provider});r.run(body);
    r.api.rows.get(body.eventKey)[field]='original@example.test';
    const replay=r.run(body);
    assert.equal(r.sends.length,1);assert.equal(replay.sent,false);assert.equal(replay.alreadySent,false);
    assert.equal(replay.rejectionCode,'receipt-recipient-mismatch');assert.equal(replay[field],'original@example.test');
    assert.deepEqual(replay.providerReceipt,proof);
  });
  for(const state of ['sent','processing'])for(const old of [false,true])test(`${name}: ${old?'expired':'fresh'} ${state} without evidence never resends`,()=>{
    const api=new ReceiptApiModel({[body.eventKey]:{state,at:Date.now()-(old?91*86400000:0)}}),r=new Receiver({api});
    const replay=r.run(body);
    assert.equal(r.sends.length,0);assert.equal(replay.alreadySent,false);assert.equal(replay.actualRecipient,undefined);
    assert.equal(replay.rejectionCode,state==='sent'?'receipt-evidence-unavailable':old?'receipt-delivery-unknown':'delivery-in-flight');
  });
}

test('changed inbound To on retry yields only the original confirmed recipient',()=>{
  const r=new Receiver({provider:()=>provider}),body=leave('leave-declined');r.run(body);
  const reply=r.run({...body,employeeEmail:'changed@example.test'});
  assert.equal(reply.rejectionCode,'receipt-recipient-mismatch');assert.equal(reply.actualRecipient,'employee@example.test');assert.equal(r.sends.length,1);
});
test('canonical reorder and duplicate addresses replay with original sorted proof',()=>{
  const r=new Receiver(),body=leave('leave-reminder','mam',{managerEmail:'b@example.test,a@example.test'});r.run(body);
  const replay=r.run({...body,managerEmail:'A@example.test,b@example.test,a@example.test'});
  assert.equal(replay.alreadySent,true);assert.equal(replay.actualRecipient,'a@example.test,b@example.test');assert.equal(r.sends.length,1);
});
test('both split copies are blocked by a legacy shared sent receipt with unknown recipients',()=>{
  const legacyEventKey=`leave:${id}:leave-submitted:${'b'.repeat(24)}`;
  const api=new ReceiptApiModel({[legacyEventKey]:{state:'sent',at:Date.now()}});
  for(const audience of ['employee','reviewers']) {
    const r=new Receiver({api}),out=r.run(leave('leave-submitted','mam',{audience,legacyEventKey}));
    assert.equal(out.rejectionCode,'receipt-evidence-unavailable');assert.equal(out.actualRecipient,undefined);assert.equal(r.sends.length,0);
  }
});
for(const count of [5000,5001])test(`exact receiver has no static capacity eviction at ${count}; DB contract model remains authoritative`,()=>{
  const legacy=Object.fromEntries(Array.from({length:count},(_,i)=>[`synthetic-${i}`,{state:i%2?'sent':'processing',at:Date.now()-91*86400000}]));
  const api=new ReceiptApiModel(legacy),r=new Receiver({api}),body=leave('leave-approved');
  assert.equal(r.run(body).sent,true);assert.equal(api.rows.size,count+1);
  for(const key of Object.keys(legacy))assert.deepEqual(api.rows.get(key),legacy[key]);
  assert.equal(r.run(body).alreadySent,true);assert.equal(r.sends.length,1);
});
test('independent execution state cannot bypass a shared atomic reserve (API contract model)',()=>{
  const api=new ReceiptApiModel(),first=new Receiver({api}),second=new Receiver({api}),body=leave('leave-approved');
  const pending=first.start(body,{stopAtSender:true});
  assert.equal(second.run(body).rejectionCode,'delivery-in-flight');assert.equal(second.sends.length,0);
  assert.equal(first.walk('Send Leave Notification to HR',[{json:pending.grant}],pending.outputs).result.sent,true);
  assert.equal(second.run(body).alreadySent,true);assert.equal(first.sends.length+second.sends.length,1);
});
test('a lost reserve response never reaches sender and retry never re-grants',()=>{
  const api=new ReceiptApiModel(),normal=api.request.bind(api);let lost=true;
  api.request=body=>{const result=normal(body);if(lost){lost=false;throw new Error('HTTP timeout after commit');}return result;};
  const r=new Receiver({api}),body=leave('leave-approved');
  assert.throws(()=>r.run(body),/timeout/);assert.equal(r.sends.length,0);
  assert.equal(r.run(body).rejectionCode,'delivery-in-flight');assert.equal(r.sends.length,0);
});
for(const committed of [false,true])test(`lost confirm ${committed?'after':'before'} commit is never permission to resend`,()=>{
  const api=new ReceiptApiModel(),normal=api.request.bind(api);let lost=true;
  api.request=body=>{if(lost&&body.action==='confirm'){lost=false;if(committed)normal(body);throw new Error('HTTP timeout');}return normal(body);};
  const r=new Receiver({api}),body=leave('leave-approved');
  assert.throws(()=>r.run(body),/timeout/);const replay=r.run(body);
  assert.equal(r.sends.length,1);assert.equal(replay.alreadySent,committed);
  if(!committed)assert.equal(replay.rejectionCode,'delivery-in-flight');
});
for(const response of [{error:'private error'}, {success:false}, {ok:false}, {accepted:false}, {statusCode:199}, {statusCode:300}, {statusCode:500}, {statusCode:202,status:500}])test(`provider explicit failure ${JSON.stringify(response)} cannot call durable confirm`,()=>{
  const r=new Receiver({provider:()=>response}),body=leave('leave-approved');
  assert.throws(()=>r.run(body),/provider explicitly rejected/);
  assert.deepEqual(r.api.requests.map(b=>b.action),['reserve']);assert.equal(r.api.rows.get(body.eventKey).state,'processing');
});
for(const status of [undefined,null,200,202,299])test(`provider minimal successful receipt status ${status}`,()=>{
  const r=new Receiver({provider:()=>({statusCode:status,id:'bad\r\nid',messageId:'fallback',headers:{'request-id':'x'.repeat(1025)}})});
  assert.deepEqual(r.run(leave('leave-approved')).providerReceipt,{accepted:true,messageId:'fallback',requestId:null,statusCode:status??null});
});
test('transient HTTP errors and disabled store fail closed with no sender or static-data fallback',()=>{
  for(const error of ['HTTP 503','HTTP 401','HTTP redirect','network timeout']) {
    const r=new Receiver({api:{request(){throw new Error(error);}}});
    assert.throws(()=>r.run(leave('leave-approved')));assert.equal(r.sends.length,0);
  }
});
test('malformed reserve grants cannot reach a sender',()=>{
  const body=leave('leave-approved'),valid={outcome:'send',eventKey:body.eventKey,deliveryToken:id};
  for(const invalid of [{...valid,eventKey:'wrong'},{...valid,deliveryToken:null},{...valid,ok:true},{...valid,outcome:'duplicate'},[],{outcome:'send'}]) {
    const r=new Receiver({api:{request:()=>invalid}});
    assert.throws(()=>r.run(body),/contract mismatch/);assert.equal(r.sends.length,0);
  }
});
test('malformed confirmation proof cannot acknowledge delivery',()=>{
  for(const mutate of [x=>({...x,actualRecipient:'other@example.test'}),x=>({...x,sent:false}),x=>({...x,providerReceipt:{...x.providerReceipt,raw:'private'}}),x=>({...x,providerReceipt:{...x.providerReceipt,statusCode:500}}),x=>({...x,providerReceipt:{...x.providerReceipt,messageId:'\u007f'}})]) {
    const api=new ReceiptApiModel(),normal=api.request.bind(api);
    api.request=body=>{const reply=normal(body);return body.action==='confirm'?mutate(reply):reply;};
    assert.throws(()=>new Receiver({api}).run(leave('leave-approved')),/contract mismatch/);
  }
});
test('native callback requests exclude inbound secret and attacker callback URL; no reserve for invalid body',()=>{
  const r=new Receiver(),body=leave('leave-approved','mam',{callbackUrl:'https://attacker.example.test',secret:'DO_NOT_FORWARD'});
  r.start(body,{headers:{'content-type':'application/json','x-mam-notification-secret':'DO_NOT_FORWARD'}});
  assert(!JSON.stringify(r.api.requests).includes('DO_NOT_FORWARD'));assert(!JSON.stringify(r.api.requests).includes('attacker'));
  const bad=new Receiver();assert.equal(bad.run({}).ok,false);assert.equal(bad.api.requests.length,0);
});
test('all paths to sole sender pass native reserve and strict gate; error/retry bypass absent',()=>{
  const sender=workflow.nodes.filter(n=>n.type==='n8n-nodes-base.microsoftOutlook');assert.equal(sender.length,1);
  const paths=[];
  function walk(name,path=[]) {assert(!path.includes(name),'no cycle/retry');const next=[...path,name];if(name===sender[0].name)paths.push(next);for(const output of workflow.connections[name]?.main||[])for(const edge of output)walk(edge.node,next);}
  walk('Receive Leave Notification');assert.equal(paths.length,1);
  assert(paths[0].includes('Reserve Durable Leave Delivery'));assert(paths[0].includes('Gate Durable Leave Reservation'));
  for(const n of workflow.nodes.filter(n=>n.type==='n8n-nodes-base.httpRequest'||n.type==='n8n-nodes-base.microsoftOutlook')) {
    assert.equal(n.retryOnFail,false);assert.equal(n.onError,'stopWorkflow');
  }
});
