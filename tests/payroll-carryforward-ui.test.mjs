import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const require = createRequire(import.meta.url);
function load(filename, imports = {}) {
  const exports = {};
  new Function('exports', 'require', ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText)(exports, id => imports[id] ?? require(id));
  return exports;
}
const priority = load('src/lib/leave-priority.ts');
const controls = load('src/components/leave-priority-controls.tsx', {
  '@/components/leave-accrual-controls': { LeaveAccrualControls: () => null, LeaveAccrualNotice: () => null },
  '@/app/leave/actions': {}, '@/lib/leave-priority': priority, '@/components/leave-demo.module.css': { default: {} },
});
const person = { personId: 'synthetic', name: 'Synthetic Employee', canViewBalance: true, paidLeave: true,
  hours: 140.4321, annualPayrollHours: 140.4321, annualPayrollDate: '2026-09-24', annualApprovedHours: 45.6,
  annualRetainedHours: 38, annualAvailableHours: 94.8321, annualBalanceSource: 'owner_estimate', canViewSickBalance: false };
const workspace = { people: [person], requests: [], canManageBalances: false, pendingBalanceCalendarIds: [] };
test('real balance card distinguishes banked, future and retained commitments without calling an estimate Xero', () => {
  const html = renderToStaticMarkup(React.createElement(controls.ApprovalLeaveBalances, { workspace: { ...workspace, requests: [{ id: 'synthetic-request', pendingBalance: true, requiredHours: 7.6, balanceSufficient: true }] }, personId: 'synthetic', requestId: 'synthetic-request' }));
  assert.match(html, /Banked balance/);
  assert.match(html, /Retained unsettled commitment/);
  assert.match(html, /Owner-approved estimate/);
  assert.match(html, /-38/);
  assert.match(html, /-7.6/);
  assert.doesNotMatch(html, /Xero|Sick leave|accountedHours|receiptId/);
});
test('existing Balance management row shows estimated banked and reserved availability', () => {
  const html = renderToStaticMarkup(React.createElement(controls.LeavePriorityControls, { workspace: { ...workspace, canManageBalances: true }, busy: false, onRequest: () => {}, onSaved: async () => {} }));
  assert.match(html, /Banked annual: 140.43 hours/);
  assert.match(html, /Retained unsettled annual: 38 hours/);
  assert.match(html, /Annual available after approved leave: 94.83 hours/);
  assert.match(html, /Owner-approved estimate/);
});

test('committed or uncertain balance save fences direct repeat submissions until authoritative refresh', async () => {
  for (const result of [{ ok: false, committed: true, message: 'Balance was saved. Refresh before trying again.' }, { ok: false, committed: null, message: 'Balance result could not be confirmed. Refresh before trying again.' }, { ok: true, committed: true }]) {
    const slots = []; let index = 0, calls = 0;
    const mockReact = { useState(initial) { const slot = index++; if (!(slot in slots)) slots[slot] = initial; return [slots[slot], value => { slots[slot] = value; }]; }, useRef(initial) { const slot = index++; if (!(slot in slots)) slots[slot] = { current: initial }; return slots[slot]; } };
    const loadedControls = load('src/components/leave-priority-controls.tsx', { react: mockReact, '@/components/leave-accrual-controls': { LeaveAccrualControls: () => null, LeaveAccrualNotice: () => null }, '@/app/leave/actions': { saveAnnualLeaveBalance: async () => { calls++; return result; } }, '@/lib/leave-priority': priority, '@/components/leave-demo.module.css': { default: {} } });
    const nodes = root => !root || typeof root !== 'object' ? [] : Array.isArray(root) ? root.flatMap(nodes) : [root, ...nodes(root.props?.children)];
    const render = () => { index = 0; return nodes(loadedControls.LeavePriorityControls({ workspace: { ...workspace, canManageBalances: true }, busy: false, onSaved: async () => { throw new Error('private refresh detail'); } })); };
    render().find(node => node.type === 'button' && node.props.children === 'Edit annual').props.onClick();
    let form = render().find(node => node.type === 'form');
    const Original = globalThis.FormData;
    globalThis.FormData = class { get(name) { return name === 'hours' ? '100' : '2026-09-24'; } };
    try {
      await form.props.onSubmit({ preventDefault() {}, currentTarget: {} });
      form = render().find(node => node.type === 'form');
      await form.props.onSubmit({ preventDefault() {}, currentTarget: {} });
      assert.equal(calls, 1, 'A committed or ambiguous balance write cannot repeat');
      assert.equal(render().find(node => node.props?.type === 'submit').props.disabled, true);
    } finally { globalThis.FormData = Original; }
  }
});

test('missing authoritative snapshot never falls back to an example amount', () => {
  const html = renderToStaticMarkup(React.createElement(controls.ApprovalLeaveBalances, { workspace: { ...workspace, people: [{ ...person, annualPayrollHours: null, annualAvailableHours: null, annualApprovedHours: null, annualRetainedHours: null }] }, personId: 'synthetic', requestId: 'synthetic-request' }));
  assert.doesNotMatch(html, /140.43/);
  assert.match(html, /Unavailable/);
});
