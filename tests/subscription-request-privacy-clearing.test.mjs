import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { nodes, text } from './helpers/contact-lifetime-harness.mjs';
import { actionHarness, actionNames, actionArgs, componentHarness, denialScenarios, initialPayload, installFileReader, bytes, payload, requestId, evidence, workspace, row } from './helpers/subscription-request-privacy-fixture.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
const output=process.env.MAM_REQUESTS_TEST_OUTPUT ?? mkdtempSync(path.join(os.tmpdir(),'mam-requests-privacy-'));
mkdirSync(output,{recursive:true});
const require=createRequire(import.meta.url);
const registered=[];
const check=(name,fn)=>{registered.push(name);test(name,fn);};
const generic='The request could not be confirmed. Reload before retrying.';
const deniedMessage='You do not have permission for this request.';
installFileReader();
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('Unexpected outbound fetch in synthetic regression');};
let blobCalls=0, linkCalls=0;
URL.createObjectURL=()=>{blobCalls++;return 'blob:synthetic';};
globalThis.document={createElement(){linkCalls++;return {click(){linkCalls++;}};}};

for(const name of actionNames) {
  for(const scenario of denialScenarios) check('action definitive denial '+name+' '+scenario,async()=>{
    const h=actionHarness(scenario);const result=await h.actions[name](...actionArgs[name]);
    assert.deepEqual(result,{ok:false,message:deniedMessage,uncertain:false,denied:true});
    assert.equal(h.authCalls.length,1);assert.equal(h.calls.length,scenario==='sql-42501'?1:0);
    assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PRIVATE|SYNTHETIC_PROVIDER|AuthSessionMissing|bad_jwt|user_banned|42501/);
  });
  for(const scenario of ['retryable-0','retryable-503','retryable-thrown','auth-500','auth-unknown-400','auth-unknown','auth-error-with-user','transport-thrown','untrusted-message']) check('action unresolved authentication '+name+' '+scenario,async()=>{
    const h=actionHarness(scenario);const result=await h.actions[name](...actionArgs[name]);
    assert.deepEqual(result,{ok:false,message:generic,uncertain:false,denied:false});
    assert.equal(h.authCalls.length,1);assert.equal(h.calls.length,0);
    assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PRIVATE|SYNTHETIC_PROVIDER|503|AuthRetryable/);
  });
  for(const scenario of ['PT409','22023','55000','XX000','rpc-thrown','malformed']) check('action nonauthoritative RPC failure '+name+' '+scenario,async()=>{
    const h=actionHarness(scenario);const result=await h.actions[name](...actionArgs[name]);
    assert.equal(result.ok,false);assert.equal(result.denied,false);
    assert.equal(result.uncertain,['mutateSubscriptionRequest','activateSubscriptionRequest'].includes(name)&&['XX000','rpc-thrown','malformed'].includes(scenario));
    assert.equal(h.authCalls.length,1);assert.equal(h.calls.length,1);
    assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PROVIDER|SYNTHETIC_PRIVATE/);
    if(scenario==='PT409')assert.equal(result.message,'Request changed. Reload before retrying.');
    if(scenario==='22023')assert.equal(result.message,'Check the request fields and decision reason.');
  });
}

check('actual mutation preserves exact existing CAS and evidence argument body',async()=>{
  const h=actionHarness();const input={id:requestId,version:3,operation:'save',payload,reason:'Synthetic reason',evidence:[{name:evidence.name,mime:evidence.mime,base64:bytes.toString('base64')}]};
  const result=await h.actions.mutateSubscriptionRequest(input);
  assert.equal(result.ok,true);assert.equal(result.committed,true);
  assert.deepEqual(h.calls,[{name:'sr_mutate',args:{p_id:requestId,p_version:3,p_operation:'save',p_payload:payload,p_reason:'Synthetic reason',p_evidence:input.evidence}}]);
});
check('actual mutation validates draft without discarding or dispatching provider RPC',async()=>{
  const h=actionHarness();const r=await h.actions.mutateSubscriptionRequest({id:requestId,version:3,operation:'save',payload:{...payload,unexpected:'synthetic'}});
  assert.deepEqual(r,{ok:false,message:'Check the request fields and decision reason.',uncertain:false,denied:false});assert.equal(h.calls.length,0);
});
check('activation preserves canonical CAS and rejects invalid dates before RPC',async()=>{
  const h=actionHarness();const input=actionArgs.activateSubscriptionRequest[0];
  const result=await h.actions.activateSubscriptionRequest(input);assert.equal(result.ok,true);
  assert.deepEqual(h.calls,[{name:'sr_activate',args:{p_request_id:input.id,p_expected_request_version:3,p_seat_count:1,p_billing_anchor_date:'2026-10-14',p_renewal_date:'2027-10-14',p_responsible_person_id:input.responsiblePersonId,p_member_person_ids:input.memberPersonIds}}]);
  for(const extra of [{billingAnchorDate:'2026-02-30'},{renewalDate:'2025-10-14'},{seatCount:0},{memberPersonIds:[input.responsiblePersonId,input.responsiblePersonId]}]){
    const invalid=actionHarness();const result=await invalid.actions.activateSubscriptionRequest({...input,...extra});assert.equal(result.ok,false);assert.equal(result.uncertain,false);assert.equal(invalid.calls.length,0);
  }
});

for(const action of ['LOAD','MUTATE','DOWNLOAD']) for(const scenario of denialScenarios) check('component clears every private cache and retires captured handlers '+action+' '+scenario,async()=>{
  const h=componentHarness({scenario});h.change('Decision reason','SYNTHETIC_PRIVATE_DECISION');const file=h.chooseFile();
  const oldReload=h.button('Reload').props.onClick,oldSave=h.button('Save draft').props.onClick,oldApprove=h.button('Approve').props.onClick;
  const oldDownload=h.button('Download '+evidence.name).props.onClick,oldCreate=h.button('New request').props.onClick;
  const oldChoose=nodes(h.tree()).find(n=>n.type==='button'&&text(n.props.children).startsWith('SYNTHETIC_PRIVATE_LIST_SIBLING')).props.onClick;
  const oldForm=h.form().props.onSubmit;
  assert.equal(h.state()[4][0],file);assert.equal(h.state()[5],'SYNTHETIC_PRIVATE_DECISION');
  const oldBlob=blobCalls,oldLink=linkCalls;
  await h.click(action==='LOAD'?'Reload':action==='MUTATE'?'Save draft':'Download '+evidence.name);
  assert.deepEqual(h.state()[0],{enabled:false,canApply:false,requests:[],people:[]},'Authoritative refusal must retire workspace/list/people/capabilities');
  assert.equal(h.state()[1],null,'selected request/history/evidence');assert.equal(h.state()[2],null,'new request id');
  assert.deepEqual(h.state()[3],initialPayload,'private payload');assert.equal(h.state()[4],null,'selected File references');assert.equal(h.state()[5],'','decision reason');
  assert.doesNotMatch(JSON.stringify(h.state()),/SYNTHETIC_PRIVATE/);
  assert.equal(h.form(),undefined);assert.equal(nodes(h.tree()).filter(n=>n.type==='section'&&n.props['aria-label']==='Request history').length,0);
  assert.equal(nodes(h.tree()).filter(n=>n.type==='button'&&/Save draft|Submit|Resubmit|Approve|Reject|Return|Withdraw|Download|New request|SYNTHETIC_PRIVATE/.test(text(n.props.children))).length,0);
  assert.equal(h.button('Reload').props.disabled,true,'Unauthorized retry must stop until a new authorized mount');
  const calls=h.calls.length,auth=h.authCalls.length;
  oldReload();oldSave();oldApprove();oldDownload();oldCreate();oldChoose();oldForm({preventDefault(){}});await h.settle();
  assert.equal(h.calls.length,calls);assert.equal(h.authCalls.length,auth);assert.equal(h.form(),undefined);
  assert.equal(blobCalls,oldBlob);assert.equal(linkCalls,oldLink);
  assert.equal(h.results.at(-1).result.denied,true);
});

for(const scenario of ['retryable-503','transport-thrown','PT409','22023','XX000','rpc-thrown']) for(const action of ['LOAD','MUTATE','DOWNLOAD']) check('component preserves permitted private draft on '+action+' '+scenario,async()=>{
  const h=componentHarness({scenario});h.change('Service','SYNTHETIC_PRIVATE_EDITED_DRAFT');h.change('Decision reason','SYNTHETIC_PRIVATE_DECISION');const file=h.chooseFile();const before=structuredClone(h.state().slice(0,4));
  await h.click(action==='LOAD'?'Reload':action==='MUTATE'?'Save draft':'Download '+evidence.name);
  assert.deepEqual(h.state().slice(0,4),before);assert.equal(h.state()[4][0],file);assert.equal(h.state()[5],'SYNTHETIC_PRIVATE_DECISION');
  assert.ok(h.form());assert.equal(h.control('Service').props.value,'SYNTHETIC_PRIVATE_EDITED_DRAFT');
  assert.match(h.currentText(),/SYNTHETIC_PRIVATE_HISTORY\.pdf/);assert.match(h.currentText(),/SYNTHETIC_PRIVATE_PERSON/);
  const uncertain=action==='MUTATE'&&['XX000','rpc-thrown'].includes(scenario);
  assert.equal(h.button('Save draft').props.disabled,uncertain);
  assert.equal(h.results.at(-1).result.denied,false);assert.equal(h.button('Reload').props.disabled,false);
  assert.equal(h.results.length,1,'No implicit redispatch');
});

check('client validation failure retains genuinely new unsaved input and selected File without action dispatch',async()=>{
  const h=componentHarness({newDraft:true});const file=h.chooseFile();
  h.form().props.onSubmit({preventDefault(){}});await h.settle();
  assert.equal(h.control('Service').props.value,'SYNTHETIC_PRIVATE_UNSAVED_DRAFT');assert.equal(h.state()[4][0],file);
  assert.equal(h.results.length,0);assert.equal(h.authCalls.length,0);assert.equal(h.calls.length,0);assert.equal(h.button('Save draft').props.disabled,false);
  assert.match(h.currentText(),/Complete the required request fields/);
});
check('uncertain write requires explicit canonical reload and exact updated CAS before retry',async()=>{
  const h=componentHarness({scenario:'XX000'});h.change('Service','SYNTHETIC_PRIVATE_UNCERTAIN_EDIT');const file=h.chooseFile();
  const staleSubmit=h.form().props.onSubmit;
  await h.click('Save draft');assert.equal(h.calls.length,1);assert.equal(h.button('Save draft').props.disabled,true);assert.equal(h.state()[4][0],file);
  h.form().props.onSubmit({preventDefault(){}});await h.click('Save draft');assert.equal(h.calls.length,1);
  h.setScenario('success');await h.click('Reload');assert.equal(h.calls.length,2);assert.equal(h.button('Save draft').props.disabled,false);
  assert.equal(h.control('Service').props.value,payload.service);assert.equal(h.state()[4],null);assert.equal(h.state()[1].version,3);
  await h.click('Save draft');assert.equal(h.calls.length,3);assert.equal(h.calls[2].args.p_version,3);assert.equal(h.calls[2].args.p_payload.service,payload.service);
  void staleSubmit;
});
check('successful canonical own-history read retains readable metadata without retaining edit or decision scope',async()=>{
  const h=componentHarness();
  const own={...structuredClone(row),canEdit:false,canDecide:false,canWithdraw:false};
  const actual=actionHarness();
  const actions=actual.actions;
  const expected={...structuredClone(workspace),canApply:false,people:[],requests:[own]};
  const resultModule=(await import('./helpers/contact-lifetime-harness.mjs')).loadModule('src/app/subscription-requests/actions.ts',{'next/server':{after:()=>{}},'@/lib/subscription-request-mail':{dispatchSubscriptionRequestMail:async()=>({ok:true})},'@/lib/supabase/server':{createClient:async()=>({auth:{getUser:async()=>({data:{user:{id:row.applicant}},error:null})},rpc:async()=>({data:expected,error:null})})}});
  const result=await resultModule.loadSubscriptionRequests();assert.equal(result.ok,true);
  const hooks=(await import('./helpers/contact-lifetime-harness.mjs')).hooksHarness((await import('react')).default);
  const {SubscriptionRequests}=(await import('./helpers/contact-lifetime-harness.mjs')).loadModule('src/components/subscription-requests.tsx',{'react':hooks.react,'./subscription-request-activation':{SubscriptionRequestActivation:()=>null,SubscriptionRequestCredentials:()=>null},'@/app/subscription-requests/actions':{...actions,loadSubscriptionRequests:async()=>result}});
  let tree;const render=()=>{hooks.begin();tree=SubscriptionRequests({initial:workspace,selectedId:requestId});hooks.effects();};
  render();nodes(tree).find(n=>n.type==='button'&&text(n.props.children)==='Reload').props.onClick();for(let i=0;i<4;i++)await new Promise(r=>setImmediate(r));render();
  assert.match(text(tree),/SYNTHETIC_PRIVATE_HISTORY_PAYLOAD/);assert.match(text(tree),/Download SYNTHETIC_PRIVATE_HISTORY.pdf/);
  assert.equal(nodes(tree).filter(n=>n.type==='button'&&['Approve','Save draft','New request','Withdraw'].includes(text(n.props.children))).length,0);
  assert.ok(nodes(tree).find(n=>n.type==='section'&&n.props['aria-label']==='Request history'));
  void h;
});
check('successful canonical read preserves a genuinely new allowed draft and File with no implicit save',async()=>{
  const h=componentHarness({newDraft:true});const file=h.chooseFile();await h.click('Reload');
  assert.equal(h.control('Service').props.value,'SYNTHETIC_PRIVATE_UNSAVED_DRAFT');assert.equal(h.state()[4][0],file);assert.notEqual(h.state()[2],null);
  assert.equal(h.button('Save draft').props.disabled,false);assert.deepEqual(h.calls.map(c=>c.name),['sr_workspace']);
});
check('authoritative denial clears a genuinely new draft and never rebinds its old File or id',async()=>{
  const h=componentHarness({newDraft:true,scenario:'no-user'});const id=h.state()[2];h.chooseFile();await h.click('Save draft');
  assert.equal(h.state()[2],null);assert.equal(h.state()[4],null);assert.doesNotMatch(JSON.stringify(h.state()),new RegExp(id));assert.equal(h.form(),undefined);assert.equal(h.calls.length,0);
});

check('production Flight round trips actual action-result promises as exact safe typed data',async()=>{
  const scenarios=['sdk-session-missing','sdk-session-missing-thrown','auth-401','sql-42501','retryable-503','transport-thrown','PT409','XX000','22023'];
  const js=`import{createRequire}from'node:module';import{actionHarness,actionNames,actionArgs}from${JSON.stringify(path.join(root,'tests/helpers/subscription-request-privacy-fixture.mjs'))};const require=createRequire(${JSON.stringify(import.meta.url)});const model={};for(const scenario of ${JSON.stringify(scenarios)})for(const name of actionNames){const h=actionHarness(scenario);model[scenario+':'+name]=h.actions[name](...actionArgs[name]);}require('next/dist/compiled/react-server-dom-webpack/server.node').renderToPipeableStream(model,{}, {onError:()=> 'UNEXPECTED_FLIGHT_DIGEST'}).pipe(process.stdout);`;
  const wire=spawnSync(process.execPath,['--conditions=react-server','--input-type=module','-e',js],{encoding:'utf8',timeout:30000,env:{...process.env,NODE_ENV:'production',TMPDIR:'/Users/nixon/.hermes/profiles/mam/cache/scratch'}});
  writeFileSync(path.join(output,'actual-action-results.flight'),wire.stdout);writeFileSync(path.join(output,'actual-action-results.stderr'),wire.stderr);
  assert.equal(wire.status,0,wire.stderr);assert.doesNotMatch(wire.stdout,/:E\{|UNEXPECTED_FLIGHT_DIGEST|SYNTHETIC_PROVIDER|SYNTHETIC_PRIVATE/);
  const decoded=await require('next/dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-client.node.production.js').createFromNodeStream(Readable.from([wire.stdout]),{moduleMap:{},serverModuleMap:{},moduleLoading:null});
  for(const scenario of scenarios)for(const name of actionNames){const h=actionHarness(scenario);const expected=await h.actions[name](...actionArgs[name]);const actual=await decoded[scenario+':'+name];assert.deepEqual(actual,expected);assert.equal(typeof actual.denied,'boolean');assert.equal(actual.denied,['sdk-session-missing','sdk-session-missing-thrown','auth-401','sql-42501'].includes(scenario));}
});
writeFileSync(path.join(output,'registered-cases.json'),JSON.stringify(registered,null,2)+'\n');
void originalFetch;
