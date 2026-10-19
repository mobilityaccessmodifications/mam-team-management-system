import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {buildMailWorkflow} from './helpers/performance-review-http-producer.mjs';
import {payload} from './performance-review-n8n-fixtures.mjs';
import {fixture,loadMailHarness,ack} from './helpers/performance-review-mail-harness.mjs';
import {unzipSync,strFromU8} from 'fflate';

const source=buildMailWorkflow().nodes.find(node=>node.name==='Validate Payload').parameters.jsCode;
function savedValidator(wire) {
 return new Function('$json','$input','require',source)({body:wire},{all:()=>[{json:{body:wire}}]},name=>{assert.equal(name,'crypto');return {createHash};})[0].json;
}
for(const code of [0xfffe,0xffff]) test('composition rejects XML noncharacter '+code+' at both mail consumers',async()=>{
 const bad='LEFT'+String.fromCodePoint(code)+'RIGHT',observed=[];
 for(const key of ['managerNote','employeeName','managerName']) {
  const p=payload();p[key]=bad;
  let rejected=false;try{loadMailHarness().mail.validatePerformanceReviewMailPayload(p);}catch(error){assert.match(error.message,/invalid_payload/);rejected=true;}
  observed.push({key,mailRejected:rejected,validatorRejected:savedValidator(p).valid===false});
 }
 const row=fixture();row.payload.managerNote=bad;
 const h=loadMailHarness({rpc:name=>({data:name==='claim_performance_review_mail'?[row]:true,error:null}),fetch:(_,init)=>ack(JSON.parse(init.body))});
 const result=await h.mail.dispatchPerformanceReviewMailOutbox();
 assert.deepEqual(observed,['managerNote','employeeName','managerName'].map(key=>({key,mailRejected:true,validatorRejected:true})));
 assert.equal(result.held,1);assert.equal(h.requests.length,0);assert.equal(h.calls.length,1);
});

for(const company of ['MAM','Equipsy']) for(const [label,value]of [
 ['ordinary8000','x'.repeat(8000)],
 ['multiline8000','R\n'.repeat(3998)+'END!'],
 ['unicode','合法 🦽 𐀀 e\u0301\tLF\nCR\rCRLF\r\n&<>"\' \u0080\u0085\u009f\ue000\ufffd\u{10ffff}'],
]) test('composition storage Word worker saved-validator '+company+' '+label,async()=>{
 const row=fixture(),d=row.payload.document;d.employee.company=company;
 d.employee.name='𠮷'.repeat(120);d.manager.name='🦽'.repeat(120);
 d.selfAnswers[0]=value;d.managerAnswers[0]=value;d.summary=value;d.meeting.notes=value;
 row.payload.managerNote='PRIVATE-NOTE-SENTINEL\t\r\n'+value.slice(0,7975);
 const h=loadMailHarness({rpc:name=>({data:name==='claim_performance_review_mail'?[row]:true,error:null}),fetch:(_,init)=>{
  const wire=JSON.parse(init.body),validated=savedValidator(wire);assert.equal(validated.valid,true);
  assert.equal(wire.employeeName,d.employee.name);assert.equal(wire.managerName,d.manager.name);
  assert.equal(wire.managerNote,row.payload.managerNote);
  const download=h.load('src/lib/performance-review-document.ts').buildPerformanceReviewDownload(d);
  assert.deepEqual(Buffer.from(wire.attachment.contentBase64,'base64'),Buffer.from(download.bytes));
  for(const [part,bytes]of Object.entries(unzipSync(download.bytes)))if(/\.(?:xml|rels)$/.test(part))assert.ok(!strFromU8(bytes).includes('PRIVATE-NOTE-SENTINEL'),part);
  assert.equal(validated.graphBody.message.toRecipients[0].emailAddress.address,'careers@mobilityaccess.com.au');
  return ack(wire);
 }});
 const rules=h.load('src/lib/performance-review-rules.ts');
 const mutation=(command,input)=>({operationId:'60000000-0000-4000-8000-000000000001',reviewId:row.review_id,expectedRevision:command==='save_self'?'self:0':'manager:1:0',command,input});
 for(const input of [mutation('save_self',{answers:d.selfAnswers}),mutation('save_manager',{answers:d.managerAnswers,ratings:d.ratings,summary:d.summary,overallRating:d.overallRating,managerNote:row.payload.managerNote}),mutation('save_meeting',d.meeting)])assert.deepEqual(rules.parseMutationInput(input),input);
 assert.deepEqual(rules.parseDocument(d),d);
 const employee={audience:'employee',code:d.code,cycle:d.cycle,employee:d.employee,manager:d.manager,selfAnswers:d.selfAnswers};
 assert.deepEqual(rules.parseDocument(employee),employee);assert.ok(!Object.hasOwn(employee,'managerNote'));
 const result=await h.mail.dispatchPerformanceReviewMailOutbox();assert.equal(result.providerAccepted,1);assert.equal(h.requests.length,1);
});

test('composition common negative domain rejects before storage Word and wire',async()=>{
 const bad=[...Array.from({length:32},(_,i)=>i).filter(i=>![9,10,13].includes(i)),127,0xfffe,0xffff].map(i=>String.fromCodePoint(i)).concat(['\ud800','\udfff']);
 for(const value of bad)for(const placement of ['answer','note','employeeName','managerName']) {
  const row=fixture(),d=row.payload.document,text='LEFT'+value+'RIGHT';
  if(placement==='answer')d.selfAnswers[0]=text;
  if(placement==='note')row.payload.managerNote=text;
  if(placement==='employeeName')d.employee.name=text;
  if(placement==='managerName')d.manager.name=text;
  const h=loadMailHarness({rpc:()=>({data:[row],error:null}),fetch:()=>{throw Error('Invalid text must not dispatch');}}),rules=h.load('src/lib/performance-review-rules.ts');
  if(placement==='note')assert.throws(()=>rules.parseMutationInput({operationId:'60000000-0000-4000-8000-000000000001',reviewId:row.review_id,expectedRevision:'manager:1:0',command:'save_manager',input:{answers:d.managerAnswers,ratings:d.ratings,summary:d.summary,overallRating:d.overallRating,managerNote:text}}));
  else assert.throws(()=>rules.parseDocument(d));
  const result=await h.mail.dispatchPerformanceReviewMailOutbox();assert.equal(result.held,1);assert.equal(h.requests.length,0);
  for(const key of ['managerNote','employeeName','managerName']){const p=payload();p[key]=text;assert.throws(()=>h.mail.validatePerformanceReviewMailPayload(p));assert.equal(savedValidator(p).valid,false);}
 }
});
