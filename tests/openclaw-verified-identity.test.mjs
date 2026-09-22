import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,input,employee,now} from './openclaw-v3-fixture.mjs';

for (const changed of [{phoneIdentityVersion:undefined},{phoneIdentityVersion:'unverified'},{phone:'0400000001'}]) {
  test(`contact-only or unversioned snapshots cannot authenticate: ${JSON.stringify(changed)}`,async()=>{
    const f=fixture(); f.setRows([{...employee(),...changed}]);
    assert.equal((await f.call(f.packet('prepare',input()))).body.code,'not_available');
    assert.equal(f.writes(),0);
  });
}
for (const replay of [false,true]) test(`re-enrolling the same phone invalidates ${replay?'receipt replay':'pending confirmation'}`,async()=>{
  const f=fixture(),{confirm}=await f.ready();
  if(replay) assert.equal((await f.call(confirm,now+1)).body.status,'Pending');
  const before=f.writes();
  f.setRows([{...employee(),phoneIdentityVersion:'30000000-0000-4000-8000-000000000002'}]);
  assert.equal((await f.call(confirm,now+2)).body.code,'not_available');
  assert.equal(f.writes(),before);
});
test('revocation removes identity even when a successful receipt remains',async()=>{
  const f=fixture(),{confirm}=await f.ready();
  assert.equal((await f.call(confirm,now+1)).body.status,'Pending');
  f.setRows([]);
  assert.equal((await f.call(confirm,now+2)).body.code,'not_available');
  assert.equal(f.writes(),1);
});
