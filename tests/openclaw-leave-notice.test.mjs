import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, employee } from './openclaw-v3-fixture.mjs';

for (const employmentType of ['full_time', 'part_time', 'casual']) {
  for (const leaveType of employmentType === 'casual' ? ['Unpaid leave'] : ['Annual leave', 'Unpaid leave']) {
    test(`${employmentType} ${leaveType}: requests with under 14 days notice may be prepared`, async () => {
      const f = fixture();
      f.setRows([{ ...employee(), employmentType }]);
      for (const startDate of ['2026-09-21', '2026-09-24', '2026-10-04', '2026-10-05']) {
        const r = await f.call(f.packet('prepare', { leaveType, startDate, endDate: startDate, employeeNote: 'Synthetic employee note' }));
        assert.equal(r.status, 200);
        assert.equal(r.body.code, 'prepared');
      }
      assert.equal(f.writes(), 0);
    });
  }
}

test('casual unpaid, ABN unpaid, sick and carer remain available', async () => {
 const f=fixture(), dates={startDate:'2026-09-24', endDate:'2026-09-24', employeeNote:'Synthetic employee note'};
 f.setRows([{...employee(),employmentType:'casual'}]);
 assert.equal((await f.call(f.packet('prepare',dates))).body.code,'prepared');
 f.setRows([{...employee(),employmentType:'abn'}]);
 assert.equal((await f.call(f.packet('prepare',dates))).body.code,'prepared');
 for(const employmentType of ['full_time','part_time']){
  f.setRows([{...employee(),employmentType}]);
  for(const leaveType of ['Sick leave',"Carer's leave"])assert.equal((await f.call(f.packet('prepare',{...dates,leaveType}))).body.code,'prepared');
 }
 assert.equal(f.writes(),0);
});

test('identity and employment type cannot be forged to bypass existing policy',async()=>{
 const f=fixture(),dates={startDate:'2026-09-24',endDate:'2026-09-24',employeeNote:'Synthetic employee note'};
 const missing=await f.call(f.packet('prepare',dates));
 assert.deepEqual(missing.body.missing,['leaveType']);
 for(const extra of [{employmentType:'abn'},{onBehalfOf:true},{managerApproved:true}]){
  assert.equal((await f.call(f.packet('prepare',{...dates,leaveType:'Annual leave',...extra}))).status,400);
 }
 f.setRows([employee(),{...employee(),userId:null,employmentType:'abn'}]);
 assert.equal((await f.call(f.packet('prepare',{...dates,leaveType:'Annual leave'}))).body.code,'not_available');
 assert.equal(f.writes(),0);
});

test('short-notice requests are accepted at Melbourne midnight and across DST',async()=>{
 const f=fixture();
 for(const [instant,startDate] of [
  ['2026-09-21T13:59:59Z','2026-10-05'],
  ['2026-09-21T14:00:00Z','2026-10-05'],
  ['2026-10-04T13:00:00Z','2026-10-19'],
  ['2026-10-04T13:00:00Z','2026-10-16'],
 ]){
  const r=await f.call(f.packet('prepare',{leaveType:'Annual leave',startDate,endDate:startDate,employeeNote:'Synthetic employee note'}),Date.parse(instant));
  assert.equal(r.body.code,'prepared',instant);
 }
});
