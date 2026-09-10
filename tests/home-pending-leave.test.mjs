import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const require = createRequire(import.meta.url);
const ts = require('typescript');
// Compile the actual Home view and its small rendering helpers without loading
// unrelated application services or introducing test-only component exports.
const source = fs.readFileSync('src/components/leave-demo.tsx', 'utf8');
const ast = ts.createSourceFile('home.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node)
  && ['HomeView', 'PanelHeader', 'StatusPill'].includes(node.name?.text)).map((node) => node.getText(ast)).join('\n');
const compiled = ts.transpileModule(functions + '\nmodule.exports = { HomeView };', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const m = { exports: {} };
const icons = require('lucide-react');
const conditional = 'Approved – pending leave balance';
new Function('require', 'module', 'exports', 'styles', 'BALANCE_PENDING_STATUS', 'formatDurationWithTime',
  'ChevronRight', 'CalendarDays', 'CheckCircle2', 'ShieldCheck', compiled)(require, m, m.exports, {}, conditional,
  (r) => `${r.days} days`, icons.ChevronRight, icons.CalendarDays, icons.CheckCircle2, icons.ShieldCheck);
const { HomeView } = m.exports;
const request = (id, status = 'Pending') => ({ id, status, personId: 'self', leaveType: 'Annual leave', dateLabel: `Dates for ${id}`, days: 2 });
function props(canReview, myRequests, onSelect = () => {}) {
  return { profile: { id: 'self' }, requests: [], myRequests, pending: [], canReview, onNavigate() {}, onSelect };
}
function buttons(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(buttons);
  return [...(node.type === 'button' ? [node] : []), ...buttons(node.props?.children)];
}
for (const canReview of [false, true]) {
  test(`${canReview ? 'manager' : 'employee'} Home shows every pending request and opens the selected record`, () => {
    const selected = [];
    const p = props(canReview, [request('approved', 'Approved'), request('first'), request('second'), request('balance', conditional), request('cancelled', 'Cancelled')],
      (...args) => selected.push(args));
    const html = renderToStaticMarkup(createElement(HomeView, p));
    for (const id of ['first', 'second', 'balance']) assert(html.includes(`Dates for ${id}`));
    for (const id of ['approved', 'cancelled']) assert(!html.includes(`Dates for ${id}`));
    const rows = buttons(HomeView(p));
    assert.equal(rows.length, 3);
    rows.forEach((row) => row.props.onClick());
    assert.deepEqual(selected, [['first', 'requests'], ['second', 'requests'], ['balance', 'requests']]);
  });
  test(`${canReview ? 'manager' : 'employee'} Home removes an approved request from the pending summary`, () => {
    const html = renderToStaticMarkup(createElement(HomeView, props(canReview, [request('first', 'Approved'), request('second')])));
    assert(!html.includes('Dates for first'));
    assert(html.includes('Dates for second'));
  });
}
test('Home retains the existing latest non-cancelled fallback when none are pending', () => {
  const html = renderToStaticMarkup(createElement(HomeView, props(false, [request('cancelled', 'Cancelled'), request('latest', 'Approved'), request('older', 'Approved')])));
  assert(html.includes('Dates for latest'));
  assert(!html.includes('Dates for older'));
  assert(!html.includes('Dates for cancelled'));
});
test('Home handles an empty or cancelled-only request list', () => {
  for (const items of [[], [request('cancelled', 'Cancelled')]]) {
    const html = renderToStaticMarkup(createElement(HomeView, props(true, items)));
    assert(html.includes('No leave requests yet'));
  }
});
