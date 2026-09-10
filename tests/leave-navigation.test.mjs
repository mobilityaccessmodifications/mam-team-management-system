import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = fs.readFileSync('src/components/leave-demo.tsx', 'utf8');
const ast = ts.createSourceFile('leave.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function load(name, bindings) {
  let found;
  function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node; ts.forEachChild(node, visit); }
  visit(ast);
  assert(found, name);
  const code = ts.transpileModule(found.getText(ast), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  return new Function('require', 'exports', ...Object.keys(bindings), code + `\nreturn ${name};`)(require, {}, ...Object.values(bindings));
}
function buttons(node) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(buttons); return [...(node.type === 'button' ? [node] : []), ...buttons(node.props?.children)]; }
test('Leave navigation defaults to Pending register while explicit approvals remain reachable', () => {
  const calls = [];
  const navigate = load('navigate', { canViewActiveWorkspaceCalendar: true, setActiveView: v => calls.push(v), scrollPageToTop() {}, changeLeaveStatusFilter: f => calls.push(f), chooseLeaveSection: s => calls.push(s) });
  navigate('leave'); assert.deepEqual(calls, ['Pending', 'requests', 'leave']);
  calls.length = 0; navigate('leave', 'approvals'); assert.deepEqual(calls, ['approvals', 'leave']);
});
test('record selection preserves the current filter, but opens out-of-filter deep links', () => {
  for (const [id, expected] of [['pending', []], ['approved', ['All']]]) {
    const filters = [], selections = [];
    const select = load('selectRequest', { filteredRequests: [{id:'pending'}], setStatusFilter: f => filters.push(f), setSelectedRequestId: i => selections.push(i), setMobileRequestDetailOpen() {}, setManagerNote() {}, setCancellationRequestId() {}, setCancellationFocusRequestId() {}, setCancellationError() {}, setCancelledRequestId() {}, chooseLeaveSection: (...args) => selections.push(args), setActiveView() {}, scrollPageToTop() {} });
    select(id); assert.deepEqual(filters, expected); assert.deepEqual(selections, [id, ['requests', id]]);
  }
});
test('register comes first and View more forwards the exact request to approvals', () => {
  const calls = [];
  const LeaveView = load('LeaveView', { styles: {}, RequestsView: 'records', ApprovalsView: 'approvals' });
  const tree = LeaveView({section:'requests', allRequests:[], pending:[], canReview:true, onSelect:(...args)=>calls.push(args)});
  assert.deepEqual(buttons(tree).map(b=>b.props.children[0].props.children), ['Leave register','Approvals']);
  const records = tree.props.children.find(c=>c?.type==='records');
  records.props.onViewMore('second'); assert.deepEqual(calls, [['second','approvals']]);
});
test('View more is available only for an authorised approvable request and opens that record', () => {
  const Detail = load('RequestDetail', { useId:()=> 'detail', styles:{}, StatusPill:'status', formatDurationWithTime:()=> '2 days', AttachmentList:()=>null, SickEvidenceNotice:()=>null, ChevronRight:'icon' });
  for (const [canReview, canDecide, count] of [[true,true,1],[true,false,0],[false,true,0]]) {
    const calls = [];
    const tree = Detail({profile:{id:'self'}, request:{id:'second',personId:'self',canDecide,status:'Pending'}, attachments:[],canReview,hidePrivateDetails:true,onViewMore:id=>calls.push(id)});
    const actions = buttons(tree); assert.equal(actions.length,count);
    if(count) { actions[0].props.onClick(); assert.deepEqual(calls,['second']); }
  }
});
