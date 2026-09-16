import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const loaded = { exports: {} };
const code = ts.transpileModule(fs.readFileSync('src/components/leave-priority-controls.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
function resolveImport(id) {
  if (id === '@/app/leave/actions') return {};
  if (id === '@/lib/leave-priority') {
    const lib = { exports: {} };
    const js = ts.transpileModule(fs.readFileSync('src/lib/leave-priority.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    new Function('require', 'module', 'exports', js)(resolveImport, lib, lib.exports);
    return lib.exports;
  }
  if (id === '@/components/leave-accrual-controls') {
    const component = { exports: {} };
    const js = ts.transpileModule(fs.readFileSync('src/components/leave-accrual-controls.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    new Function('require', 'module', 'exports', js)(resolveImport, component, component.exports);
    return component.exports;
  }
  if (id.endsWith('.module.css')) return { default: {} };
  return require(id);
}
new Function('require', 'module', 'exports', code)(resolveImport, loaded, loaded.exports);
const person = { personId: 'employee', name: 'Test Employee', canSubmit: false, paidLeave: true, canViewBalance: true, hours: 60, asOf: '2026-09-10', isExample: false };
const workspace = (people, requests = []) => ({ people, requests, canManageBalances: false, pendingBalanceCalendarIds: [] });

test('balance management section is hidden from staff, reviewers and employee previews', () => {
  for (const [canManageBalances, previewPersonId] of [[false, undefined], [false, 'reviewer'], [true, 'reviewer']]) {
    const html = renderToStaticMarkup(createElement(loaded.exports.LeavePriorityControls, {
      workspace: {...workspace([{...person, canSubmit:true, canViewSickBalance:true, sickHours:25}]), canManageBalances},
      previewPersonId, busy:false, onRequest() {}, async onSaved() {},
    }));
    assert.equal(html, '');
  }
});

test('approval panel shows Xero, approved and post-deduction balances', () => {
  const html = renderToStaticMarkup(createElement(loaded.exports.ApprovalLeaveBalances, {
    workspace: workspace([{ ...person,
      annualPayrollHours: 60, annualPayrollDate: '2026-09-10', annualApprovedHours: 15.2, annualAvailableHours: 44.8,
      canViewSickBalance: true, sickPayrollHours: 25.1234, sickPayrollDate: '2026-09-10', sickApprovedHours: 7.6, sickAvailableHours: 17.5234,
    }], [{ id: 'request', pendingBalance: true, requiredHours: null }]),
    personId: 'employee', requestId: 'request', busy: false, async onSaved() {},
  }));
  assert.match(html, /Annual leave/);
  assert.match(html, /<strong>60 <span>hours<\/span><\/strong>/);
  assert.match(html, /Current Xero balance/);
  assert.match(html, /Approved leave in People Hub/);
  assert.match(html, /Available after approved leave/);
  assert.match(html, /15\.2/);
  assert.match(html, /44\.8/);
  assert.match(html, /Sick leave/);
  assert.match(html, /25\.12/);
  assert.match(html, /17\.52/);
  assert.match(html, /<svg/);
  assert.match(html, /Xero as at 10 Sept 2026/);
  assert.doesNotMatch(html, /25.1234/);
  assert.match(html, /Waiting for enough leave/);
  assert.match(html, /Confirm the paid hours/);
});

test('missing sick snapshot is not displayed as a zero balance', () => {
  const html = renderToStaticMarkup(createElement(loaded.exports.ApprovalLeaveBalances, {
    workspace: workspace([{ ...person, canViewSickBalance: true, sickHours: null }]),
    personId: 'employee', requestId: 'request', busy: false, async onSaved() {},
  }));
  assert.match(html, /Sick leave/);
  assert.match(html, /Unavailable/);
  assert.doesNotMatch(html, /<strong>0<\/strong>/);
});

test('administrator can review payroll rows that have no employee match', () => {
  const html = renderToStaticMarkup(createElement(loaded.exports.LeavePriorityControls, {
    workspace: { ...workspace([]), canManageBalances: true, payrollImports: [{ id: 'import', employeeName: 'Unmatched Test Employee', company: 'mam', annualHours: 10, sickHours: 20, asOf: '2026-09-10', status: 'unmatched', linkedName: null, sourceFile: 'synthetic.xlsx' }] },
    busy: false, onRequest() {}, async onSaved() {},
  }));
  assert.match(html, /Payroll records · 1/);
  assert.match(html, /Employee match required/);
  assert.match(html, /Annual: 10 hours · Sick: 20 hours/);
});


test('actual administrator gets policy and audited day reconciliation controls', () => {
  const p = { ...person, accrualStatus: 'current', accrualPolicy: { weeklyHours: 38, annualWeeks: 4, personalWeeks: 2, enabled: true, shiftworker: false, note: 'Synthetic policy note' } };
  const html = renderToStaticMarkup(createElement(loaded.exports.LeavePriorityControls, {
    workspace: { ...workspace([p]), canManageBalances: true }, busy: false, onRequest() {}, async onSaved() {},
  }));
  assert.match(html, /38 ordinary hours\/week/);
  assert.match(html, /name="note"[^>]*value="Synthetic policy note"/);
  assert.match(html, /Save confirmed hours/);
  assert.match(html, /Changes apply from today/);
});

test('approval keeps sick balances private and does not round tiny debt to zero', () => {
  const html = renderToStaticMarkup(createElement(loaded.exports.ApprovalLeaveBalances, {
    workspace: workspace([{ ...person, hours: -0.004, sickHours: 99, canViewSickBalance: false, accrualStatus: 'current', annualPayrollDate: '2026-09-10' }]),
    personId: 'employee', requestId: 'request', busy: false, async onSaved() {},
  }));
  assert.match(html, /−&lt;0.01/);
  assert.doesNotMatch(html, /Sick leave|99|2026-09-10|automatic accrual/);
});

const { approvalRequestHours, approvalBalanceCoverage } = resolveImport('@/lib/leave-priority');
test('approval hours use the full-time 7.6-hour snapshot and retain recorded hourly requests', () => {
  assert.equal(approvalRequestHours({ days: 2, fullDayHours: 7.6 }), 15.2);
  assert.equal(approvalRequestHours({ days: 2, fullDayHours: 7.6, hours: 3.25 }), 3.25);
  assert.equal(approvalRequestHours({ days: 2 }), 15, 'payloads without duration metadata retain the staged fallback');
  assert.equal(approvalRequestHours({ days: 0 }), null);
  assert.equal(approvalRequestHours({ days: 2, hours: NaN }), null);
});
test('coverage compares full precision, respects visibility and review holds', () => {
  assert.equal(approvalBalanceCoverage({ ...person, hours: 15 }, 'Annual leave', 15), 'Enough balance');
  assert.equal(approvalBalanceCoverage({ ...person, hours: 30, annualAvailableHours: 14.9999 }, 'Annual leave', 15), 'Not enough balance');
  assert.equal(approvalBalanceCoverage({ ...person, hours: 30, annualAvailableHours: null }, 'Annual leave', 15), 'Check balance');
  assert.equal(approvalBalanceCoverage({ ...person, hours: 14.9999 }, 'Annual leave', 15), 'Not enough balance');
  assert.equal(approvalBalanceCoverage({ ...person, canViewSickBalance: true, sickHours: 30, sickAvailableHours: null }, 'Sick leave', 15), 'Check balance');
  assert.equal(approvalBalanceCoverage({ ...person, accrualStatus: 'needs_review' }, 'Annual leave', 15), 'Check balance');
  assert.equal(approvalBalanceCoverage({ ...person, hours: null }, 'Annual leave', 15), 'Check balance');
  assert.equal(approvalBalanceCoverage(person, 'Sick leave', 15), null);
  assert.equal(approvalBalanceCoverage(person, 'Unpaid leave', 15), null);
});
test('duration pill reports the requested balance, including sick leave', () => {
  for (const [leaveType, sickHours, expected] of [['Annual leave', 0, 'Enough balance'], ['Sick leave', 14, 'Not enough balance'], ['Sick leave', 15, 'Enough balance']]) {
    const html = renderToStaticMarkup(createElement(loaded.exports.ApprovalBalancePill, {
      workspace: workspace([{ ...person, canViewSickBalance: true, sickHours }]),
      personId: 'employee', requestId: 'request', leaveType, requiredHours: 15, busy: false, async onSaved() {},
    }));
    assert.equal((html.match(/data-sufficient=/g) ?? []).length, 1);
    assert.ok(html.includes(expected));
    assert.ok(html.includes(`data-sufficient="${expected === 'Enough balance'}"`));
  }
});

test('annual balance appears in the request context for the authorised target only', () => {
  const props = {workspace:{...workspace([{...person,accrualStatus:'needs_review'}]),canManageBalances:true},personId:'employee'};
  const html=renderToStaticMarkup(createElement(loaded.exports.LeaveRequestBalance,{workspace:props.workspace,personId:'employee',self:true}));
  assert.match(html,/My annual leave/);
  assert.match(html,/<strong>60<\/strong>/);
  assert.match(html,/Balance needs checking/);
  assert.doesNotMatch(html,/Edit annual|Edit sick|Accrual settings/);
  assert.equal(renderToStaticMarkup(createElement(loaded.exports.LeaveRequestBalance,{workspace:props.workspace,personId:'different',self:true})), '');
});

test('annual request context names an unavailable balance instead of hiding or inventing zero', () => {
  const html = renderToStaticMarkup(createElement(loaded.exports.LeaveRequestBalance, {
    workspace: workspace([{ ...person, hours: null, accrualStatus: 'needs_review' }]),
    personId: 'employee',
    self: true,
  }));
  assert.match(html, /My annual leave/);
  assert.match(html, /Unavailable/);
  assert.match(html, /Balance needs checking/);
  assert.doesNotMatch(html, /<strong>0<\/strong>/);
});
