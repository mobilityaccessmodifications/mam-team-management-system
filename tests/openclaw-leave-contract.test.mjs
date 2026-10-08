import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,input,employee,now,config} from './openclaw-v3-fixture.mjs';

for(const version of [1,2,0,4]) for(const op of ['profile','prepare','shown','confirm']) {
  test(`retired/unknown v${version} ${op} is rejected before any store access`,async()=>{
    const f=fixture(); assert.equal((await f.call(f.packet(op,{}, {version}))).body.code,'restart_required');
    assert.equal(f.reads(),0); assert.equal(f.writes(),0);
  });
}
for(const op of ['profile','shown','revise']) test(`v3 ${op} cannot read or persist`,async()=>{
  const f=fixture(); assert.equal((await f.call(f.packet(op,{}))).status,400); assert.equal(f.reads(),0);
});
test('preparation and needs_input never persist; token is opaque, randomized and summary is authoritative',async()=>{
  const f=fixture(); const missing=await f.call(f.packet('prepare',{}));
  assert.equal(missing.body.code,'needs_input'); assert.equal('profile' in missing.body,false);
  const {prepared}=await f.ready(); const second=await f.call(f.packet('prepare',input()));
  assert.equal(prepared.body.consentVersion,3); assert.match(prepared.body.summary,/Name: Synthetic Employee/);
  assert.match(prepared.body.draftToken,/^v3\./); assert.notEqual(prepared.body.draftToken,second.body.draftToken);
  assert.equal(Buffer.from(prepared.body.draftToken.slice(3),'base64url').includes(Buffer.from('Synthetic Employee')),false);
  assert.equal(f.writes(),0); assert.equal(f.nonces.size,0); assert.equal(f.receipts.size,0);
});
test('standalone and true quote Confirm submit once; exact replay and token retry after expiry return original result',async()=>{
  const f=fixture(),{confirm}=await f.ready(); const first=await f.call(confirm,now+1);
  assert.equal(first.body.status,'Pending');
  assert.deepEqual(await f.call(confirm,now+600001),first);
  const quoted=f.packet('confirm',{...confirm.payload,replyToMessageId:'provider-1',text:' CONFIRM\n'});
  assert.deepEqual(await f.call(quoted,now+600002),first); assert.equal(f.nonces.size,1);
});
test('same inbound event cannot be reassigned to a new token',async()=>{
  const f=fixture(),a=await f.ready(); await f.call(a.confirm,now+1); const b=await f.ready();
  assert.equal((await f.call({...b.confirm,eventId:a.confirm.eventId},now+2)).body.code,'conflict');
  assert.equal(f.nonces.size,1);
});
for(const change of [
  {replyToMessageId:'other-receipt'}, {shownMessageId:''}, {text:'Confirm please'}, {text:'CONFIRM 123'},
  {text:'confirm\u200b'}, {extra:true}, {replyToMessageId:undefined},
]) test(`reject malformed confirmation ${JSON.stringify(change)}`,async()=>{
  const f=fixture(),{confirm}=await f.ready();
  assert.notEqual((await f.call({...confirm,payload:{...confirm.payload,...change}},now+1)).status,200);
  assert.equal(f.writes(),0);
});
test('tampered token and wrong key cannot reach snapshot or submit',async()=>{
  const f=fixture(),{confirm}=await f.ready(); const before=f.reads();
  const bytes=Buffer.from(confirm.payload.draftToken.slice(3),'base64url'); bytes[30]^=1;
  assert.equal((await f.call({...confirm,payload:{...confirm.payload,draftToken:'v3.'+bytes.toString('base64url')}},now+1)).status,400);
  assert.equal((await f.call(confirm,now+1,config.key+'x')).status,401);
  assert.equal(f.reads(),before); assert.equal(f.writes(),0);
});
for(const extra of [{session:'other'},{sender:'+61400000002'},{account:'other'},{channel:'group'}]) test(`cannot transplant token ${JSON.stringify(extra)}`,async()=>{
  const f=fixture(),{confirm}=await f.ready(); assert.notEqual((await f.call({...confirm,...extra},now+1)).status,200); assert.equal(f.writes(),0);
});
test('expiry prevents new persistence, future issuedAt cannot submit',async()=>{
  const f=fixture(),{confirm}=await f.ready();
  assert.equal((await f.call(confirm,now+600000)).body.code,'expired');
  assert.equal((await f.call(confirm,now-1)).body.code,'conflict'); assert.equal(f.writes(),0);
});
for(const changed of [{fullName:'Changed'},{employmentType:'casual'},{active:false},{accountActive:false},{userId:'20000000-0000-4000-8000-000000000002'},{phone:'0400000002'}]) test(`current employee must still match ${JSON.stringify(changed)}`,async()=>{
  const f=fixture(),{confirm}=await f.ready(); f.setRows([{...employee(),...changed}]);
  assert.notEqual((await f.call(confirm,now+1)).status,200); assert.equal(f.writes(),0);
});
test('receipt retrieval after rename rechecks actor and goes through locked submit; disabled account rejected',async()=>{
  const f=fixture(),{confirm}=await f.ready(); const first=await f.call(confirm,now+1);
  f.setRows([{...employee(),fullName:'Renamed'}]); assert.deepEqual(await f.call(confirm,now+600001),first);
  assert.equal(f.writes(),2); f.setRows([{...employee(),accountActive:false}]);
  assert.equal((await f.call(confirm,now+600002)).body.code,'not_available'); assert.equal(f.writes(),2);
});
test('duplicate phone even unlinked is rejected, no identity-selected payload accepted',async()=>{
  const f=fixture(); f.setRows([employee(),{...employee(),userId:null}]);
  assert.equal((await f.call(f.packet('prepare',input()))).body.code,'not_available');
  f.setRows([employee()]); assert.equal((await f.call(f.packet('prepare',{...input(),personId:employee().personId}))).status,400);
});
for(const employmentType of ['casual','abn','overseas']) test(`${employmentType} defaults missing type unpaid but never silently converts explicit paid`,async()=>{
  const f=fixture(); f.setRows([{...employee(),employmentType}]); const fields={...input()}; delete fields.leaveType;
  assert.match((await f.call(f.packet('prepare',fields))).body.summary,/Type: Unpaid leave/);
  assert.equal((await f.call(f.packet('prepare',input()))).body.code,'needs_input'); assert.equal(f.writes(),0);
});
test('unknown employment fails closed and partial-day summary retains times/timezone',async()=>{
  const f=fixture(); f.setRows([{...employee(),employmentType:null}]);
  assert.equal((await f.call(f.packet('prepare',input()))).body.code,'not_available'); f.setRows([employee()]);
  assert.match((await f.call(f.packet('prepare',{...input(),startTime:'12:00',endTime:'16:00'}))).body.summary,/12:00 to 16:00 \(Australia\/Melbourne\)/);
});
for(const invalid of [
 {startDate:'2026-02-30'},{endDate:'2026-10-01'},{endDate:'2028-10-12'},
 {leaveType:'Other'},{startTime:'12:10',endTime:'16:00'},{startTime:'16:00',endTime:'12:00'},
 {leaveType:'Unpaid leave',startDate:'2026-10-11',endDate:'2026-10-11'},{employeeNote:'x'.repeat(2001)},
 {employeeNote:'hidden\u202e'},{employeeNote:'hidden\u0000'},
]) test(`field policy rejects ${Object.keys(invalid).join('/')}`,async()=>{
 const f=fixture();const r=await f.call(f.packet('prepare',{...input(),...invalid}));
 assert.equal(r.status,400);assert.equal(f.writes(),0);
});
test('one missing time asks for its pair; no optional note required',async()=>{
 const f=fixture(); const r=await f.call(f.packet('prepare',{...input(),startTime:'12:00'}));
 assert.deepEqual(r.body,{code:'needs_input',missing:['endTime']});
 const p=await f.call(f.packet('prepare',input()));assert.match(p.body.summary,/Note \(optional\): None/);
});

test('annual weekend reaches authoritative saved-policy validation without changing consent rules',async()=>{
  const f=fixture(); const r=await f.call(f.packet('prepare',{...input(),startDate:'2026-10-11',endDate:'2026-10-11'}));
  assert.equal(r.status,200); assert.equal(r.body.code,'prepared'); assert.equal(f.writes(),0);
  const partial=await f.call(f.packet('prepare',{...input(),startDate:'2026-10-11',endDate:'2026-10-11',startTime:'09:00',endTime:'14:00'}));
  assert.equal(partial.status,200); assert.equal(partial.body.code,'prepared'); assert.equal(f.writes(),0);
  const multi=await f.call(f.packet('prepare',{...input(),endDate:'2026-10-13',startTime:'09:00',endTime:'14:00'}));
  assert.equal(multi.status,400); assert.equal(f.writes(),0);
});
