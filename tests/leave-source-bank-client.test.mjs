import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
function load(file) {
  const exports = {};
  new Function('exports', ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(exports);
  return exports;
}
const { requestedLeaveHours, annualLeaveLimitGuidance } = load('src/lib/leave-request-balance.ts');
const { approvalBalanceCoverage } = load('src/lib/leave-priority.ts');
const ordinary = { weeklyHours: 38, weekdays: [1, 2, 3, 4, 5], calendarKey: 'none' };
const victoria = { ...ordinary, calendarKey: 'victoria', publicHolidayDates: new Set(['2026-09-25']) };
const weekend = { weeklyHours: 12, weekdays: [6, 7], calendarKey: 'none' };
const person = { personId: 'synthetic', name: 'Synthetic', paidLeave: true, canSubmit: true, canViewBalance: true,
  canViewSickBalance: true, hours: 20, sickHours: 10, asOf: '2026-10-01', isExample: false };

test('policy quantity uses saved weekly hours and ordinary weekdays, including weekends', () => {
  assert.equal(requestedLeaveHours('2026-09-26', '2026-09-27', '', '', 7.5, weekend), 12);
  assert.equal(requestedLeaveHours('2026-09-28', '2026-09-28', '', '', 7.5, weekend), null);
  assert.equal(requestedLeaveHours('2026-10-05', '2026-10-05', '', '', 7.5, ordinary), 7.6);
  const partTime = { weeklyHours: 19, weekdays: [1, 2], calendarKey: 'none' };
  assert.equal(requestedLeaveHours('2026-10-05', '2026-10-06', '', '', 7.5, partTime), 19);
});

test('confirmed Victoria holiday is excluded from annual quantity and unknown calendar stays unknown', () => {
  assert.equal(requestedLeaveHours('2026-09-11', '2026-10-02', '', '', 7.6, victoria), 114);
  assert.equal(requestedLeaveHours('2026-09-25', '2026-09-25', '', '', 7.6, victoria), null);
  assert.equal(requestedLeaveHours('2026-09-25', '2026-09-25', '', '', 7.6, { ...victoria, calendarKey: 'none' }), 7.6);
  assert.equal(requestedLeaveHours('2026-09-25', '2026-09-25', '', '', 7.6, { ...victoria, calendarKey: null }), null);
  assert.equal(requestedLeaveHours('2026-09-24', '2026-09-24', '', '', 7.6, { ...victoria, calendarKey: null }), 7.6);
  assert.equal(requestedLeaveHours('2026-09-24', '2026-09-24', '', '', 7.6, { ...ordinary, calendarKey: 'victoria' }), null);
});

test('single-day partial quantity preserves actual selected hours without guessing a break or a multiday schedule', () => {
  assert.equal(requestedLeaveHours('2026-10-05', '2026-10-05', '09:00', '14:00', 7.6, ordinary), 5);
  assert.equal(requestedLeaveHours('2026-10-05', '2026-10-05', '09:00', '17:00', 7.6, ordinary), 8);
  assert.equal(requestedLeaveHours('2026-10-05', '2026-10-06', '09:00', '14:00', 7.6, ordinary), null);
  assert.equal(annualLeaveLimitGuidance('2026-10-05', '2026-10-06', '09:00', '14:00', 7.6, 5, ordinary), null);
});

test('policy quantity rejects invalid dates, times and unconfirmed ordinary policy inputs', () => {
  for (const policy of [{ ...ordinary, weekdays: [] }, { ...ordinary, weekdays: [1, 1] },
    { ...ordinary, weekdays: [0] }, { ...ordinary, weeklyHours: NaN }, { ...ordinary, weeklyHours: 0 },
    { ...ordinary, weeklyHours: 39 }]) {
    assert.equal(requestedLeaveHours('2026-10-05', '2026-10-06', '', '', 7.6, policy), null);
  }
  assert.equal(requestedLeaveHours('2026-02-30', '2026-03-02', '', '', 7.6, ordinary), null);
  assert.equal(requestedLeaveHours('2026-10-05', '2026-10-05', '24:00', '25:00', 7.6, ordinary), null);
  assert.equal(requestedLeaveHours('2026-10-05', '2026-10-05', '09:00', '', 7.6, ordinary), null);
});

test('guidance follows the same saved days and holiday quantity without rounding up coverage', () => {
  assert.match(annualLeaveLimitGuidance('2026-09-24', '2026-09-29', '', '', 7.6, 15.2, victoria), /up to 28 Sept 2026/);
  assert.match(annualLeaveLimitGuidance('2026-09-26', '2026-10-04', '', '', 7.5, 12, weekend), /up to 27 Sept 2026/);
  const thirds = { weeklyHours: 38, weekdays: [1, 2, 3], calendarKey: 'none' };
  assert.match(annualLeaveLimitGuidance('2026-10-05', '2026-10-06', '', '', 7.6, 38 / 3 - 0.00001, thirds), /Not enough balance for one full working day/);
  assert.equal(annualLeaveLimitGuidance('2026-10-05', '2026-10-05', '09:00', '14:00', 7.6, 5, ordinary), null);
});

test('per-entitlement review status does not inherit a different entitlement hold', () => {
  const separate = { ...person, accrualStatus: 'needs_review', annualAccrualStatus: 'current', sickAccrualStatus: 'needs_review' };
  assert.equal(approvalBalanceCoverage(separate, 'Annual leave', 7.6), 'Enough balance');
  assert.equal(approvalBalanceCoverage(separate, 'Sick leave', 5), 'Check balance');
  assert.equal(approvalBalanceCoverage({ ...separate, annualAccrualStatus: 'needs_review', annualAvailableHours: 100 }, 'Annual leave', 7.6), 'Check balance');
  assert.equal(approvalBalanceCoverage({ ...separate, annualAccrualStatus: 'needs_review', annualEligibilityStatus: 'current', annualAvailableHours: 12 }, 'Annual leave', 7.6), 'Enough balance');
  assert.equal(approvalBalanceCoverage({ ...separate, annualEligibilityStatus: 'current', annualAvailableHours: null }, 'Annual leave', 7.6), 'Check balance');
  assert.equal(approvalBalanceCoverage({ ...separate, sickAccrualStatus: 'current' }, "Carer's leave", 5), 'Enough balance');
});

test('unknown service coverage permits only authoritative banked availability and never infers it from fallback hours', () => {
  const unknown = { ...person, annualAccrualStatus: 'coverage_unconfirmed' };
  assert.equal(approvalBalanceCoverage(unknown, 'Annual leave', 7.6), 'Check balance');
  assert.equal(approvalBalanceCoverage({ ...unknown, annualAvailableHours: 12 }, 'Annual leave', 7.6), 'Enough balance');
  assert.equal(approvalBalanceCoverage({ ...unknown, annualAvailableHours: 7.59999 }, 'Annual leave', 7.6), 'Not enough balance');
  assert.equal(approvalBalanceCoverage({ ...unknown, annualAvailableHours: 12 }, 'Annual leave', NaN), 'Check balance');
});

test('legacy payload contracts retain existing duration and server banked availability behavior', () => {
  assert.equal(requestedLeaveHours('2026-10-12', '2026-10-13', '', '', 7.6), 15.2);
  assert.equal(requestedLeaveHours('2026-10-12', '2026-10-13', '12:00', '16:00', 7.6), 16);
  assert.equal(approvalBalanceCoverage({ ...person, accrualStatus: 'needs_review', annualAvailableHours: 12 }, 'Annual leave', 7.6), 'Enough balance');
});
