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

test('annual approval has one balance-aware action and preserves conditional decisions', () => {
  const lib = {exports:{}};
  const compiled = ts.transpileModule(fs.readFileSync('src/lib/leave-priority.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  new Function('exports',compiled)(lib.exports);
  const conditional = lib.exports.BALANCE_PENDING_STATUS;
  const View = load('ApprovalsView', { ...lib.exports, styles:{approveButton:'approve'}, StatusPill:'status', CalendarDays:'icon', Clock3:'icon', ClipboardList:'icon', CheckCircle2:'icon', XCircle:'icon', ApprovalBalancePill:'pill', ApprovalLeaveBalances:'balances', AttachmentList:'attachments', SickEvidenceNotice:'evidence', ApprovalCalendar:'calendar', formatDuration:()=> '2 days', formatTimeRange:()=> '' });
  for(const [balance,status,label,disabled,decision] of [
    [15,'Pending','Approve',false,'Approved'],
    [14.9999,'Pending','Approve pending balance',false,conditional],
    [10,conditional,'Waiting for balance',true,null],
    [15,conditional,'Approve',false,'Approved'],
    [null,'Pending','Check balance',true,null],
  ]) {
    const calls=[];
    const selected={id:'request',personId:'person',leaveType:'Annual leave',days:2,status};
    const tree=View({selected,pending:[selected],leavePriority:{people:[{personId:'person',canViewBalance:true,hours:balance}]},attachmentsByRequestId:new Map(),busy:false,readOnly:false,onDecision:d=>calls.push(d)});
    const actions=buttons(tree); assert.equal(actions.length,2);
    const approve=actions.find(b=>b.props.className==='approve');
    assert.equal(approve.props.children[2],label); assert.equal(Boolean(approve.props.disabled),disabled);
    if(!disabled){approve.props.onClick();assert.deepEqual(calls,[decision]);}
  }
});

test('approval calendar shows complete request weeks without six weeks of padding', () => {
  const daysFor = load('getApprovalCalendarDays', { toIsoDate:d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` });
  for(const [startDate,endDate,first,last,length] of [
    ['2027-01-22','2027-01-25','2027-01-18','2027-01-31',14],
    ['2026-09-11','2026-09-11','2026-09-07','2026-09-13',7],
    ['2026-09-28','2026-10-09','2026-09-28','2026-10-11',14],
  ]) { const days=daysFor({startDate,endDate}); assert.equal(days.length,length); assert.equal(days[0].iso,first); assert.equal(days.at(-1).iso,last); assert(days.some(d=>d.iso===startDate)); assert(days.some(d=>d.iso===endDate)); }
});
