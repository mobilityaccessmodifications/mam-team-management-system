import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, employee, notice } from './openclaw-v3-fixture.mjs';

for (const employmentType of ['full_time', 'part_time', 'casual']) {
  for (const leaveType of employmentType === 'casual' ? ['Unpaid leave'] : ['Annual leave', 'Unpaid leave']) {
    test(`${employmentType} ${leaveType}: short notice stops before draft or persistence`, async () => {
      const f = fixture();
      f.setRows([{ ...employee(), employmentType }]);
      for (const startDate of ['2026-09-21', '2026-09-24', '2026-10-04']) {
        // An end date, optional note and part-day end time need not be collected.
        const r = await f.call(f.packet('prepare', { leaveType, startDate, startTime: '12:00' }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.missing, []);
        assert.equal(r.body.code, 'needs_input');
        assert.ok(r.body.instruction.startsWith(notice.LEAVE_NOTICE_MESSAGE));
        assert.match(r.body.instruction, /do not collect more details/);
        assert.deepEqual(Object.keys(r.body).sort(), ['code', 'instruction', 'missing']);
      }
      const allowed = await f.call(f.packet('prepare', { leaveType, startDate: '2026-10-05', endDate: '2026-10-05' }));
      assert.equal(allowed.body.code, 'prepared');
      assert.equal(f.writes(), 0);
      assert.equal(f.nonces.size, 0);
      assert.equal(f.receipts.size, 0);
    });
  }
}

test('casual default unpaid is checked; ABN unpaid and sick/carer remain available', async () => {
  const f = fixture(), dates = { startDate: '2026-09-24', endDate: '2026-09-24' };
  f.setRows([{ ...employee(), employmentType: 'casual' }]);
  assert.equal((await f.call(f.packet('prepare', dates))).body.code, 'needs_input');
  f.setRows([{ ...employee(), employmentType: 'abn' }]);
  assert.equal((await f.call(f.packet('prepare', dates))).body.code, 'prepared');
  for (const employmentType of ['full_time', 'part_time']) {
    f.setRows([{ ...employee(), employmentType }]);
    for (const leaveType of ['Sick leave', "Carer's leave"]) {
      assert.equal((await f.call(f.packet('prepare', { ...dates, leaveType }))).body.code, 'prepared');
    }
  }
  assert.equal(f.writes(), 0);
});

test('unknown type asks rather than assuming restricted category; identity cannot grant exceptions', async () => {
  const f = fixture(), dates = { startDate: '2026-09-24', endDate: '2026-09-24' };
  const missing = await f.call(f.packet('prepare', dates));
  assert.deepEqual(missing.body.missing, ['leaveType']);
  for (const extra of [{ employmentType: 'abn' }, { onBehalfOf: true }, { managerApproved: true }]) {
    assert.equal((await f.call(f.packet('prepare', { ...dates, leaveType: 'Annual leave', ...extra }))).status, 400);
  }
  f.setRows([employee(), { ...employee(), userId: null, employmentType: 'abn' }]);
  assert.equal((await f.call(f.packet('prepare', { ...dates, leaveType: 'Annual leave' }))).body.code, 'not_available');
  assert.equal(f.writes(), 0);
});

test('Melbourne midnight and DST use calendar days rather than UTC or elapsed hours', async () => {
  const f = fixture();
  for (const [instant, startDate, expected] of [
    ['2026-09-21T13:59:59Z', '2026-10-05', 'prepared'],
    ['2026-09-21T14:00:00Z', '2026-10-05', 'needs_input'],
    ['2026-10-04T13:00:00Z', '2026-10-19', 'prepared'],
    ['2026-10-04T13:00:00Z', '2026-10-16', 'needs_input'],
  ]) {
    const r = await f.call(f.packet('prepare', { leaveType: 'Annual leave', startDate, endDate: startDate }), Date.parse(instant));
    assert.equal(r.body.code, expected, instant);
  }
});
