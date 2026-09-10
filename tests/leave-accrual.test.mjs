import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const loaded = { exports: {} };
const code = ts.transpileModule(fs.readFileSync('src/lib/leave-accrual.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
}).outputText;
new Function('module', 'exports', code)(loaded, loaded.exports);
const { calculateLeaveAccrual: calculate } = loaded.exports;
const policy = {
  employment: 'full_time', nationalSystemCoverageConfirmed: true,
  nesShiftworker: false, annualWeeksPerYear: 4, personalWeeksPerYear: 2,
};
const ordinary = (hours) => ({ annual: hours, personal: hours });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('38 ordinary hours over 52 weeks earns 152 annual and 76 shared personal hours', () => {
  assert.deepEqual(calculate(policy, ordinary(38 * 52)), { annualHours: 152, personalHours: 76 });
});
test('part-time entitlement follows hours without a fixed number of days', () => {
  assert.deepEqual(calculate({ ...policy, employment: 'part_time' }, ordinary(19 * 52)),
    { annualHours: 76, personalHours: 38 });
});
test('qualifying shiftworker earns five weeks, and higher contract benefits are retained', () => {
  assert.deepEqual(calculate({ ...policy, nesShiftworker: true, annualWeeksPerYear: 5 }, ordinary(38 * 52)),
    { annualHours: 190, personalHours: 76 });
  assert.deepEqual(calculate({ ...policy, annualWeeksPerYear: 6, personalWeeksPerYear: 3 }, ordinary(38 * 52)),
    { annualHours: 228, personalHours: 114 });
});
test('does not round away small increments or depend on pay-period batching', () => {
  const daily = calculate(policy, ordinary(7.6));
  const annual = calculate(policy, ordinary(7.6 * 260));
  close(daily.annualHours * 260, annual.annualHours);
  close(daily.personalHours * 260, annual.personalHours);
  close(calculate(policy, ordinary(0.25)).personalHours, 0.25 / 26);
});
test('zero eligible hours earns zero and entitlement-specific absence treatment is preserved', () => {
  assert.deepEqual(calculate(policy, ordinary(0)), { annualHours: 0, personalHours: 0 });
  const result = calculate(policy, { annual: 38, personal: 19 });
  close(result.annualHours, 38 / 13);
  close(result.personalHours, 19 / 26);
});
test('confirmed casual and contractor classifications do not earn NES paid leave', () => {
  for (const employment of ['casual', 'contractor']) {
    assert.deepEqual(calculate({ ...policy, employment }, ordinary(38)),
      { annualHours: 0, personalHours: 0 });
  }
});
test('missing coverage/classification and below-minimum benefits fail closed', () => {
  for (const override of [
    { nationalSystemCoverageConfirmed: false }, { employment: null }, { employment: 'abn' },
    { annualWeeksPerYear: 3 }, { personalWeeksPerYear: 1 }, { nesShiftworker: true },
  ]) assert.throws(() => calculate({ ...policy, ...override }, ordinary(38)));
});
test('rejects invalid hours, benefits and numerical overflow', () => {
  for (const value of [-1, NaN, Infinity]) {
    assert.throws(() => calculate(policy, { annual: value, personal: 38 }));
    assert.throws(() => calculate(policy, { annual: 38, personal: value }));
    assert.throws(() => calculate({ ...policy, annualWeeksPerYear: value }, ordinary(38)));
    assert.throws(() => calculate({ ...policy, personalWeeksPerYear: value }, ordinary(38)));
  }
  assert.throws(() => calculate({ ...policy, annualWeeksPerYear: Number.MAX_VALUE }, ordinary(100)));
});
