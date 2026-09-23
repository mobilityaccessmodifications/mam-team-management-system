import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const mod = {};
new Function('exports', ts.transpileModule(fs.readFileSync('src/lib/leave-request-balance.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(mod);
const guidance = mod.annualLeaveLimitGuidance;

test('full-day limit uses 7.6 hours and skips weekends without accruing during absence', () => {
  assert.match(guidance('2026-10-09', '2026-10-20', '', '', 7.6, 15.2), /up to 12 Oct 2026 for full working days/);
  assert.match(guidance('2026-12-24', '2027-04-16', '', '', 7.6, 89.95), /up to 7 Jan 2027/);
  assert.match(guidance('2026-10-12', '2026-10-20', '', '', 7.5, 15), /up to 13 Oct 2026/);
});
test('unavailable, sufficient and invalid requests do not invent a limit', () => {
  for (const balance of [null, undefined, NaN, Infinity, 7.6, 100]) assert.equal(guidance('2026-10-12', '2026-10-12', '', '', 7.6, balance), null);
  assert.equal(guidance('2026-10-12', '2026-10-11', '', '', 7.6, 0), null);
  assert.equal(guidance('2026-10-12', '2026-10-13', '12:00', '', 7.6, 0), null);
});
test('zero, negative and sub-day balances offer partial or unpaid leave, not a date', () => {
  for (const balance of [-10, 0, 7.59]) {
    const text = guidance('2026-10-12', '2026-10-20', '', '', 7.6, balance);
    assert.match(text, /Not enough balance for one full working day/);
    assert.doesNotMatch(text, /up to/);
  }
});
test('timed limit respects selected boundary times instead of full-day hours', () => {
  assert.match(guidance('2026-10-12', '2026-10-20', '12:00', '16:00', 7.6, 16), /up to 13 Oct 2026 with the selected start\/end times/);
  assert.match(guidance('2026-10-12', '2026-10-20', '12:00', '16:00', 7.6, 3.99), /Not enough balance for the selected hours/);
});
test('limit matches existing duration calculation across weekdays, weekends and timed ranges', () => {
  for (const start of ['2026-10-09', '2026-10-10', '2026-10-12']) {
    for (const [begins, ends] of [['', ''], ['06:00', '18:00'], ['12:00', '16:00'], ['16:00', '12:00']]) {
      for (const balance of [0, 4, 7.6, 15.2, 28, 50]) {
        let expected = null;
        for (let day = Date.parse(`${start}T12:00:00Z`); day <= Date.parse('2026-10-23T12:00:00Z'); day += 86400000) {
          if ([0, 6].includes(new Date(day).getUTCDay())) continue;
          const cost = mod.requestedLeaveHours(start, new Date(day).toISOString().slice(0, 10), begins, ends, 7.6);
          if (cost != null && cost <= balance) expected = day;
        }
        const result = guidance(start, '2026-10-23', begins, ends, 7.6, balance);
        if (expected == null) assert.match(result, /Not enough balance/);
        else assert.ok(result.includes(new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(expected)));
      }
    }
  }
});
test('both balance surfaces render bold guidance and subscription count lives in the panel', () => {
  const dialog = fs.readFileSync('src/components/leave-request-dialog.tsx', 'utf8');
  const controls = fs.readFileSync('src/components/leave-priority-controls.tsx', 'utf8');
  const subscriptions = fs.readFileSync('src/components/subscription-register.tsx', 'utf8');
  assert.match(dialog, /<strong className=\{styles.leaveLimitGuidance\}>\{limitGuidance\}<\/strong>/);
  assert.match(controls, /<strong>\{limitGuidance\}<\/strong>/);
  assert.doesNotMatch(dialog, /employees can record Unpaid leave only/);
  assert.match(subscriptions, /filterPanelFooter\}><span aria-live="polite">\{subscriptionCountLabel/);
  assert.doesNotMatch(subscriptions.split('ref={filterButtonRef}')[1].split('</button>')[0], /subscriptionCountLabel/);
});
