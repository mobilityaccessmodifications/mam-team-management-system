import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = readFileSync('src/components/leave-demo.tsx', 'utf8');
const ast = ts.createSourceFile('leave.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const priority = {};
new Function('exports', ts.transpileModule(readFileSync('src/lib/leave-priority.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText)(priority);
const blank = () => null;
const styles = new Proxy({}, { get: (_, key) => String(key) });
const bindings = {
  ...priority, styles, registerToolbar: styles, useState: React.useState,
  useRef: React.useRef, useEffect: React.useEffect, useDialogFocus: blank,
  Search: blank, ChevronRight: blank, StatusPill: ({ status }) => React.createElement('span', null, status),
  RequestDetail: blank, formatDuration: request => `${request.hours ?? request.days} ${request.hours == null ? 'days' : 'hours'}`,
};
const names = ['RequestsView', 'getLeaveRegisterPage', 'getLeaveRegisterSelectionPage', 'getLeaveRegisterStatus'];
const statements = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
const compiled = ts.transpileModule(statements.map(node => node.getText(ast)).join('\n'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const actual = new Function('require', 'exports', ...Object.keys(bindings), compiled + '\nreturn {' + statements.map(node => node.name.text).join(',') + '};')(require, {}, ...Object.values(bindings));
const nodes = value => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)];

const row = (id, endDate, status = 'Approved', changes = {}) => ({
  id, personId: 'synthetic-person', employee: `Synthetic ${id}`, initials: 'SE', team: 'Synthetic team',
  leaveType: 'Annual leave', startDate: endDate, endDate, dateLabel: endDate, days: 1, status,
  canDecide: false, canCancel: false, canAttach: false, ...changes,
});
function register(rows, options = {}) {
  let tree;
  function Capture() {
    tree = actual.RequestsView({ profile: { id: 'self' }, requests: rows, allRequests: rows,
      filter: 'All', today: '2026-10-08', canReview: true, attachmentsByRequestId: new Map(),
      onFilter: blank, onSelect: blank, ...options });
    return tree;
  }
  const html = renderToStaticMarkup(React.createElement(Capture));
  const group = nodes(tree).find(node => node.props?.['aria-label'] === 'Leave request status');
  return { tree, html, tabs: nodes(group).filter(node => node.type === 'button') };
}

test('Completed follows Cancelled with the existing button, count and selected styling', () => {
  const rows = [row('yesterday', '2026-10-07'), row('today', '2026-10-08')];
  const calls = [];
  const { tabs } = register(rows, { filter: 'Completed', onFilter: value => calls.push(value) });
  assert.deepEqual(tabs.map(button => button.props.children[0]), [
    'All', 'Pending', 'Waiting for balance', 'Approved', 'Declined', 'Cancelled', 'Completed',
  ]);
  const counts = Object.fromEntries(tabs.map(button => [button.props.children[0], button.props.children[1].props.children]));
  assert.equal(counts.All, 2);
  assert.equal(counts.Approved, 1);
  assert.equal(counts.Completed, 1);
  assert.equal(tabs.at(-1).props['aria-pressed'], true);
  assert.equal(tabs.at(-1).props.className, 'filterActive');
  assert.equal(tabs.at(-1).props.type, 'button');
  tabs.at(-1).props.onClick();
  assert.deepEqual(calls, ['Completed']);
  assert.deepEqual(rows.map(request => request.status), ['Approved', 'Approved']);
});

// Run the actual parent expressions as well as the actual register component.
function parentValue(name, supplied) {
  let declaration;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) declaration = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(declaration, name);
  const code = ts.transpileModule(`const ${declaration.getText(ast)};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(...Object.keys(supplied), code + `\nreturn ${name};`)(...Object.values(supplied));
}
function filtered(rows, filter, today = '2026-10-08') {
  return parentValue('filteredRequests', { visibleRequests: rows, statusFilter: filter,
    leaveRegisterToday: today, getLeaveRegisterStatus: actual.getLeaveRegisterStatus });
}

for (const [name, startDate, endDate, changes, expected] of [
  ['single day ended yesterday', '2026-10-07', '2026-10-07', {}, 'Completed'],
  ['multiple days fully ended', '2026-10-01', '2026-10-07', { days: 5 }, 'Completed'],
  ['part day fully ended', '2026-10-07', '2026-10-07', { hours: 3, startTime: '09:00', endTime: '12:00' }, 'Completed'],
  ['today is not fully ended', '2026-10-08', '2026-10-08', {}, 'Approved'],
  ['part day today remains approved', '2026-10-08', '2026-10-08', { hours: 3, endTime: '12:00' }, 'Approved'],
  ['started in the past ends today', '2026-10-01', '2026-10-08', {}, 'Approved'],
  ['spans today', '2026-10-01', '2026-10-09', {}, 'Approved'],
  ['future single day', '2026-10-09', '2026-10-09', {}, 'Approved'],
]) test(`register dates: ${name}`, () => {
  const request = Object.freeze(row(name, endDate, 'Approved', { startDate, ...changes }));
  assert.equal(actual.getLeaveRegisterStatus(request, '2026-10-08'), expected);
  assert.deepEqual(filtered([request], expected), [request]);
  assert.equal(filtered([request], expected === 'Completed' ? 'Approved' : 'Completed').length, 0);
  assert.equal(request.status, 'Approved');
});

for (const status of ['Cancelled', 'Declined', 'Pending', priority.BALANCE_PENDING_STATUS]) test(`past ${status} retains its own classification`, () => {
  const request = Object.freeze(row(status, '2026-10-01', status));
  assert.equal(actual.getLeaveRegisterStatus(request, '2026-10-08'), status);
  assert.deepEqual(filtered([request], status), [request]);
  assert.equal(filtered([request], 'Completed').length, 0);
});

test('the real Melbourne date policy handles UTC midnight, both DST changes and year rollover', () => {
  const policySource = readFileSync('src/lib/leave-priority.ts', 'utf8');
  const code = ts.transpileModule(policySource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  for (const [instant, today] of [
    ['2026-10-03T13:59:59Z', '2026-10-03'], ['2026-10-03T14:00:00Z', '2026-10-04'],
    ['2026-10-03T15:59:59Z', '2026-10-04'], ['2026-10-03T16:00:00Z', '2026-10-04'],
    ['2026-04-04T12:59:59Z', '2026-04-04'], ['2026-04-04T13:00:00Z', '2026-04-05'],
    ['2026-04-04T15:59:59Z', '2026-04-05'], ['2026-04-04T16:00:00Z', '2026-04-05'],
    ['2026-12-31T12:59:59Z', '2026-12-31'], ['2026-12-31T13:00:00Z', '2027-01-01'],
  ]) {
    class Clock extends Date { constructor(...args) { super(...(args.length ? args : [instant])); } }
    const policy = {};
    new Function('exports', 'Date', code)(policy, Clock);
    assert.equal(policy.melbourneToday(), today);
    assert.equal(actual.getLeaveRegisterStatus(row('same-day', today), policy.melbourneToday()), 'Approved');
    const utcDate = instant.slice(0, 10);
    assert.equal(actual.getLeaveRegisterStatus(row('utc-day', utcDate), policy.melbourneToday()), utcDate < today ? 'Completed' : 'Approved');
  }
});

test('all status counts partition only the supplied role scope with unchanged All total', () => {
  const rows = [row('old', '2026-10-07'), row('current', '2026-10-08'),
    ...['Cancelled', 'Declined', 'Pending', priority.BALANCE_PENDING_STATUS].map(status => row(status, '2026-10-01', status))];
  for (const visible of [rows, rows.slice(0, 2), [], rows.slice(2)]) {
    const { tabs } = register(visible);
    const counts = tabs.map(button => button.props.children[1].props.children);
    assert.equal(counts[0], visible.length);
    assert.equal(counts.slice(1).reduce((sum, count) => sum + count, 0), visible.length);
    const partitions = ['Pending', priority.BALANCE_PENDING_STATUS, 'Approved', 'Declined', 'Cancelled', 'Completed'].flatMap(status => filtered(visible, status));
    assert.equal(new Set(partitions.map(request => request.id)).size, visible.length);
    assert.deepEqual(filtered(visible, 'All'), visible);
  }
});

test('Completed composes with existing search sort paging and exact parent selection', () => {
  const rows = Array.from({ length: 25 }, (_, index) => row(`past-${String(index).padStart(2, '0')}`, '2026-10-07', 'Approved', {
    startDate: `2026-10-${String(index % 7 + 1).padStart(2, '0')}`, leaveType: index === 24 ? 'Sick leave' : 'Annual leave',
  }));
  const visible = filtered([...rows, row('future', '2026-10-09')], 'Completed');
  assert.deepEqual(actual.getLeaveRegisterPage(visible, '', 'default', 2, 20).rows.map(request => request.id), rows.slice(20).map(request => request.id));
  assert.equal(actual.getLeaveRegisterPage(visible, '', 'default', 99, 10).page, 3);
  assert.equal(actual.getLeaveRegisterPage(visible, 'sick leave', 'oldest', 2, 20).rows[0].id, 'past-24');
  assert.equal(actual.getLeaveRegisterPage(visible, '', 'oldest', 1, 20).rows[0].startDate, '2026-10-01');
  assert.equal(actual.getLeaveRegisterPage(visible, '', 'employee', 1, 20).rows[0].id, 'past-00');
  assert.equal(actual.getLeaveRegisterPage(visible, 'no-match', 'default', 1, 20).total, 0);
  assert.equal(actual.getLeaveRegisterSelectionPage(visible, 'past-24', '', 'default', 20), 2);
  assert.equal(parentValue('selectedRegisterRequest', { filteredRequests: visible, selectedRequestId: 'future' }), undefined);
  assert.equal(parentValue('selectedRegisterRequest', { filteredRequests: visible, selectedRequestId: 'past-24' }), rows[24]);
  assert.equal(parentValue('selectedRegisterRequest', { filteredRequests: visible, selectedRequestId: '' }), rows[0]);
});
