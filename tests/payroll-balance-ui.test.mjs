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
new Function('require', 'module', 'exports', code)((id) => {
  if (id === '@/app/leave/actions') return {};
  if (id === '@/lib/leave-priority') return { leaveDateLabel: (date) => date, melbourneToday: () => '2026-09-10' };
  if (id.endsWith('.module.css')) return { default: {} };
  return require(id);
}, loaded, loaded.exports);
const person = { personId: 'employee', name: 'Test Employee', canSubmit: false, paidLeave: true, canViewBalance: true, hours: 60, asOf: '2026-09-10', isExample: false };
const workspace = (people, requests = []) => ({ people, requests, canManageBalances: false, pendingBalanceCalendarIds: [] });

test('employee balance section contains annual hours and no sick fields or edit controls', () => {
  const html = renderToStaticMarkup(createElement(loaded.exports.LeavePriorityControls, {
    workspace: workspace([person]), busy: false, onRequest() {}, async onSaved() {},
  }));
  assert.match(html, /Annual: 60 hours/);
  assert.doesNotMatch(html, /Sick:|Edit sick|Edit annual/);
});

test('approval panel includes dated annual and authorised sick balances beside reminder controls', () => {
  const html = renderToStaticMarkup(createElement(loaded.exports.ApprovalLeaveBalances, {
    workspace: workspace([{ ...person, canViewSickBalance: true, sickHours: 25.1234, sickAsOf: '2026-09-10' }], [{ id: 'request', pendingBalance: true, requiredHours: null }]),
    personId: 'employee', requestId: 'request', busy: false, async onSaved() {},
  }));
  assert.match(html, /Annual: 60 hours/);
  assert.match(html, /Sick: 25.1234 hours/);
  assert.match(html, /As of 2026-09-10/);
  assert.match(html, /Routine reminders are paused/);
  assert.match(html, /Confirm the paid hours/);
});

test('missing sick snapshot is not displayed as a zero balance', () => {
  const html = renderToStaticMarkup(createElement(loaded.exports.ApprovalLeaveBalances, {
    workspace: workspace([{ ...person, canViewSickBalance: true, sickHours: null }]),
    personId: 'employee', requestId: 'request', busy: false, async onSaved() {},
  }));
  assert.match(html, /Sick: Not supplied/);
  assert.doesNotMatch(html, /Sick: 0/);
});
