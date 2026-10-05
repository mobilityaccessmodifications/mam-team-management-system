import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = fs.readFileSync('src/components/leave-demo.tsx', 'utf8')
  + fs.readFileSync('src/components/leave-attachment-list.tsx', 'utf8');
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
function textContent(node) { if (node == null || typeof node === 'boolean') return ''; if (typeof node !== 'object') return String(node); if (Array.isArray(node)) return node.map(textContent).join(''); return textContent(node.props?.children); }
test('Leave navigation defaults to Pending register while explicit approvals remain reachable', () => {
  const calls = [];
  const navigate = load('navigate', { canViewActiveWorkspaceCalendar: true, setActiveView: v => calls.push(v), scrollPageToTop() {}, changeLeaveStatusFilter: f => calls.push(f), chooseLeaveSection: s => calls.push(s) });
  navigate('leave'); assert.deepEqual(calls, ['Pending', 'requests', 'leave']);
  calls.length = 0; navigate('leave', 'approvals'); assert.deepEqual(calls, ['approvals', 'leave']);
});
test('unauthorised approval and balance deep links resolve to the requests register', () => {
  const resolveSection = load('resolveAuthorisedLeaveSection', {});
  assert.equal(resolveSection('approvals', false, false), 'requests');
  assert.equal(resolveSection('approvals', true, false), 'approvals');
  assert.equal(resolveSection('balance', true, false), 'requests');
  assert.equal(resolveSection('balance', false, true), 'balance');
  assert.equal(resolveSection('requests', false, false), 'requests');
});
test('the selected leave tab scrolls into view and respects reduced motion', () => {
  const reveal = load('revealSelectedLeaveTab', {});
  let options;
  const originalWindow = globalThis.window;
  globalThis.window = {
    requestAnimationFrame(callback) { callback(); },
    matchMedia() { return { matches: true }; },
  };
  try {
    reveal({ isConnected: true, scrollIntoView(next) { options = next; } });
  } finally {
    globalThis.window = originalWindow;
  }
  assert.deepEqual(options, { behavior: 'auto', block: 'nearest', inline: 'nearest' });
});
test('leave links show an honest loading state before their authorised workspace resolves', () => {
  const Boundary = load('LeaveWorkspaceLoadBoundary', { LeaveLoadingState: 'loading-state' });
  assert.equal(Boundary({ loading: true, children: 'leave-workspace' }).type, 'loading-state');
  assert.equal(Boundary({ loading: false, children: 'leave-workspace' }), 'leave-workspace');
  const Loading = load('LeaveLoadingState', { styles: { panel: 'panel', emptyState: 'empty' }, Clock3: 'clock' });
  const status = Loading();
  assert.equal(status.props.role, 'status');
  assert.equal(status.props['aria-live'], 'polite');
  assert.equal(status.props['aria-busy'], 'true');
  assert.equal(status.props.children[1].props.children, 'Loading leave');
  assert.match(source, /<LeaveWorkspaceLoadBoundary loading=\{leaveDataLoading\}>/);
});
test('payroll import preview is target-capability scoped while reminders stay in the signed-in workspace', () => {
  assert.match(
    source,
    /canAccessBalance = Boolean\(activeCapabilities\?\.can_import_payroll_balances && canImportPayrollBalances\)[\s\S]*?Boolean\(activeCapabilities\?\.can_manage_leave_balances && leavePriority\?\.canManageBalances === true\)/,
  );
  assert.match(
    source,
    /section === "balance" && canAccessBalance \? <div className=\{styles\.balanceWorkspace\}>\{balanceContent\}<\/div>/,
  );
  assert.match(
    source,
    /canViewPayrollBalanceReminderForActiveProfile = canViewPayrollBalanceReminderCalendar\s*&& !isPreviewingEmployeeAccess;/,
  );
  assert.match(
    source,
    /calendarPayrollBalanceReminders = isPreviewingEmployeeAccess \? \[\] : payrollBalanceReminderEntries;/,
  );
  assert.match(
    source,
    /showPayrollBalanceReminders=\{canViewPayrollBalanceReminderForActiveProfile\}/,
  );
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
  const LeaveView = load('LeaveView', { styles: {}, RequestsView: 'records', ApprovalsView: 'approvals', revealSelectedLeaveTab() {} });
  const tree = LeaveView({section:'requests', allRequests:[], pending:[], canReview:true, onSelect:(...args)=>calls.push(args)});
  assert.deepEqual(buttons(tree).map(b=>b.props.children[0].props.children), ['Leave register','Approvals']);
  const records = tree.props.children.find(c=>c?.type==='records');
  records.props.onViewMore('second'); assert.deepEqual(calls, [['second','approvals']]);
});
test('Balance is a sibling tab only when the server-issued capability is present', () => {
  const LeaveView = load('LeaveView', { styles: { balanceWorkspace: 'balance-workspace' }, RequestsView: 'records', ApprovalsView: 'approvals', revealSelectedLeaveTab() {} });
  const allowed = LeaveView({ section: 'balance', allRequests: [], pending: [], canReview: false, canAccessBalance: true, balanceContent: 'balance-tools' });
  assert.deepEqual(buttons(allowed).map(button => {
    const firstChild = Array.isArray(button.props.children) ? button.props.children[0] : button.props.children;
    return firstChild.props.children;
  }), ['Leave register', 'Balance']);
  assert.equal(allowed.props.children.find(child => child?.props?.className === 'balance-workspace').props.children, 'balance-tools');

  const denied = LeaveView({ section: 'requests', allRequests: [], pending: [], canReview: false, canAccessBalance: false, balanceContent: 'balance-tools' });
  assert.equal(buttons(denied).length, 0);
  assert.equal(denied.props.children.some(child => child?.props?.className === 'balance-workspace'), false);
});
test('Apply for leave stays in the shared header for register, approvals and balance', () => {
  const LeaveView = load('LeaveView', { styles: { leaveHeader: 'leave-header', primaryButton: 'primary', applyForLeaveButton: 'apply' }, RequestsView: 'records', ApprovalsView: 'approvals', Plus: 'plus', revealSelectedLeaveTab() {} });
  for (const section of ['requests', 'approvals', 'balance']) {
    const tree = LeaveView({ section, allRequests: [], pending: [], canReview: true, canAccessBalance: true, balanceContent: 'balance-tools', canApplyForLeave: true, busy: false });
    const header = tree.props.children[0];
    const action = buttons(header).find((button) => button.props['aria-label'] === 'Apply for leave');
    assert.equal(header.props.className, 'leave-header');
    assert.equal(action.props.className, 'primary apply');
    assert.equal(header.props.children[1], action);
    if (section === 'requests') {
      const records = tree.props.children.find((child) => child?.type === 'records');
      assert.equal(Object.hasOwn(records.props, 'action'), false);
    }
  }
});
test('only an uploader-owned attachment offers a confirmed destructive action', async () => {
  let confirming = null;
  const deleted = [];
  const AttachmentList = load('AttachmentList', {
    useState: () => [confirming, value => { confirming = value; }],
    styles: {},
    Paperclip: 'paperclip',
    FileText: 'file',
    ArrowUpRight: 'arrow',
    Trash2: 'trash',
    formatFileSize: () => '1 KB',
  });
  const owned = { id: 'owned', fileName: 'proof.pdf', sizeBytes: 1024, canDelete: true };
  const reviewerOnly = { id: 'reviewer', fileName: 'other.pdf', sizeBytes: 1024, canDelete: false };

  let tree = AttachmentList({ attachments: [owned, reviewerOnly], onDelete: async id => { deleted.push(id); } });
  const trigger = buttons(tree).find(button => button.props['aria-label'] === 'Delete proof.pdf');
  assert.ok(trigger);
  assert.equal(buttons(tree).some(button => button.props['aria-label'] === 'Delete other.pdf'), false);
  trigger.props.onClick();

  tree = AttachmentList({ attachments: [owned, reviewerOnly], onDelete: async id => { deleted.push(id); } });
  const confirm = buttons(tree).find(button => button.props.children?.[1] === 'Delete');
  assert.ok(confirm);
  await confirm.props.onClick();
  assert.deepEqual(deleted, ['owned']);
});
test('View more is available only for an authorised approvable request and opens that record', () => {
  const Detail = load('RequestDetail', { useId:()=> 'detail', styles:{}, StatusPill:'status', formatDurationWithTime:()=> '2 days', formatSubmissionDate:()=> '', AttachmentList:()=>null, SickEvidenceNotice:()=>null, ChevronRight:'icon' });
  for (const [canReview, canDecide, count] of [[true,true,1],[true,false,0],[false,true,0]]) {
    const calls = [];
    const tree = Detail({profile:{id:'self'}, request:{id:'second',personId:'self',canDecide,status:'Pending'}, attachments:[],canReview,hidePrivateDetails:true,onViewMore:id=>calls.push(id)});
    const actions = buttons(tree); assert.equal(actions.length,count);
    if(count) { actions[0].props.onClick(); assert.deepEqual(calls,['second']); }
  }
});

test('read-only all-staff viewer sees employee and evidence without an approval path', () => {
  const LeaveView = load('LeaveView', { styles: {}, RequestsView: 'records', ApprovalsView: 'approvals', revealSelectedLeaveTab() {} });
  const tree = LeaveView({ section: 'requests', allRequests: [{ id: 'pending' }], pending: [], canReview: false, canViewAllLeave: true, canAccessBalance: false });
  assert.equal(buttons(tree).some(button => textContent(button).includes('Approvals')), false);
  const records = tree.props.children.find(child => child?.type === 'records');
  assert.equal(records.props.canViewAllLeave, true);

  const Detail = load('RequestDetail', { useId: () => 'detail', styles: {}, StatusPill: 'status', formatDurationWithTime: () => '2 days', formatSubmissionDate: () => '', AttachmentList: 'attachments', SickEvidenceNotice: () => null, ChevronRight: 'icon' });
  const detail = Detail({ profile: { id: 'viewer' }, request: { id: 'pending', personId: 'owner', employee: 'Synthetic Owner', initials: 'SO', leaveType: 'Unpaid leave', status: 'Pending', canDecide: false, canAttach: false, canCancel: false }, attachments: [{ id: 'evidence', fileName: 'fixture.pdf' }], canReview: false, canViewAllLeave: true, hidePrivateDetails: false });
  assert.match(textContent(detail), /Synthetic Owner/);
  assert.equal(detail.props.children.some(child => child?.type === 'attachments'), true);
  assert.equal(buttons(detail).some(button => textContent(button).includes('View more') || textContent(button).includes('Cancel leave')), false);
  assert.match(fs.readFileSync('src/app/leave/actions.ts', 'utf8'), /rpc\("can_view_all_leave_requests"\)/);
});
test('Leave register searches and sorts only visible fields before paging', () => {
  const page = load('getLeaveRegisterPage', {});
  const rows = Array.from({ length: 45 }, (_, index) => ({
    id: `row-${index}`, employee: index === 30 ? 'Synthetic Target' : `Person ${index}`,
    leaveType: index === 30 ? 'Sick leave' : 'Annual leave',
    startDate: `2026-10-${String(index % 28 + 1).padStart(2, '0')}`,
    endDate: '2026-11-01', dateLabel: 'October 2026', status: 'Approved',
    team: 'MAM', employeeNote: index === 30 ? 'private-only-needle' : undefined,
  }));
  assert.equal(page(rows, '', 'default', 1, 20).rows.length, 20);
  assert.deepEqual(page(rows, '', 'default', 2, 20).rows.map(row => row.id), rows.slice(20, 40).map(row => row.id));
  assert.equal(page(rows, '', 'default', 99, 20).page, 3);
  assert.equal(page(rows, '', 'default', 99, 20).rows.length, 5);
  assert.deepEqual(page(rows, 'synthetic target', 'default', 2, 20).rows.map(row => row.id), ['row-30']);
  assert.deepEqual(page(rows, 'sick leave', 'default', 1, 20).rows.map(row => row.id), ['row-30']);
  assert.equal(page(rows, 'private-only-needle', 'default', 1, 20).total, 0);
  assert.equal(page(rows, '', 'oldest', 1, 20).rows[0].startDate, '2026-10-01');
  assert.equal(page(rows, '', 'employee', 1, 20).rows[0].employee, 'Person 0');
  assert.equal(page([], '', 'default', 1, 20).totalPages, 1);
});
test('Leave register locates an externally selected request after the tab has mounted', () => {
  const selectionPage = load('getLeaveRegisterSelectionPage', { getLeaveRegisterPage: load('getLeaveRegisterPage', {}) });
  const rows = Array.from({ length: 45 }, (_, index) => ({ id: `row-${index}`, employee: `Person ${index}`, leaveType: 'Annual leave', startDate: '2026-10-01' }));
  assert.equal(selectionPage(rows, 'row-32', '', 'default', 20), 2);
  assert.equal(selectionPage(rows, 'row-32', 'person 32', 'default', 20), 1);
  assert.equal(selectionPage(rows, 'row-32', 'not a match', 'default', 20), null);
  assert.equal(selectionPage(rows, 'missing', '', 'default', 20), null);
});
test('admin Change Profile uses the selected employee read capability without approving', () => {
  const actions = fs.readFileSync('src/app/leave/actions.ts', 'utf8');
  assert.match(actions, /canViewAllLeave: payload\.can_view_all_leave/);
  assert.match(source, /canViewAllLeave=\{canViewAllLeave\}/);
  assert.match(source, /canReview=\{canReviewLeave\}/);
});
test('request details show the submission date in Melbourne time', () => {
  const format = load('formatSubmissionDate', {});
  assert.equal(format('2026-09-22T23:30:00Z'), '23 Sept 2026');
  assert.equal(format(''), '');
  assert.equal(format('invalid'), '');

  const Detail = load('RequestDetail', { useId:()=> 'detail', styles:{}, StatusPill:'status', formatDurationWithTime:()=> '5 days', formatSubmissionDate:format, AttachmentList:()=>null, SickEvidenceNotice:()=>null, ChevronRight:'icon' });
  const tree = Detail({
    profile:{id:'reviewer'},
    request:{id:'request',personId:'employee',employee:'Synthetic Employee',initials:'SE',leaveType:'Unpaid leave',dateLabel:'13–19 Nov 2026',approvalRequired:true,assignedReviewerLabel:'Synthetic Reviewer',submittedAt:'2026-09-22T23:30:00Z',canDecide:false,status:'Pending'},
    attachments:[],canReview:true,hidePrivateDetails:true,
  });
  assert.match(textContent(tree), /Submission date23 Sept 2026Leave typeUnpaid leave/);
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
    const tree=View({selected,pending:[selected],leavePriority:{people:[{personId:'person',canViewBalance:true,hours:balance}],requests:[{id:'request',pendingBalance:status===conditional,balanceSufficient:balance!=null&&balance>=15}]},attachmentsByRequestId:new Map(),busy:false,readOnly:false,onDecision:d=>calls.push(d)});
    const actions=buttons(tree); assert.equal(actions.length,2);
    const approve=actions.find(b=>b.props.className==='approve');
    assert.equal(approve.props.children[2],label); assert.equal(Boolean(approve.props.disabled),disabled);
    if(!disabled){approve.props.onClick();assert.deepEqual(calls,[decision]);}
  }
});

test('approval selection reset keys are unique and scoped to the selected request', () => {
  const lib = {exports:{}};
  const compiled = ts.transpileModule(fs.readFileSync('src/lib/leave-priority.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  new Function('exports',compiled)(lib.exports);
  const View = load('ApprovalsView', { ...lib.exports, styles:{}, StatusPill:'status', CalendarDays:'icon', Clock3:'icon', ClipboardList:'icon', CheckCircle2:'icon', XCircle:'icon', ApprovalBalancePill:'pill', ApprovalLeaveBalances:'balances', AttachmentList:()=>null, SickEvidenceNotice:()=>null, ApprovalCalendar:'calendar', formatDuration:()=> '2 days', formatTimeRange:()=> '' });
  const resetKeys = (id) => {
    const selected = {id,personId:'person',employee:'Employee',initials:'E',leaveType:'Annual leave',dateLabel:'12–13 Oct',days:2,status:'Pending'};
    const tree = View({selected,pending:[selected],leavePriority:{people:[{personId:'person',canViewBalance:true,hours:15}],requests:[]},attachmentsByRequestId:new Map(),calendarRequests:[],calendarCheckIns:[],busy:false,readOnly:false,note:'',onBalancesSaved:async()=>{},onNote:()=>{},onSelect:()=>{},onDecision:()=>{}});
    const record = tree.props.children.find((child) => child?.type === 'section');
    return record.props.children
      .filter((child) => child?.type === 'balances' || child?.type === 'calendar')
      .map((child) => child.key);
  };

  assert.deepEqual(resetKeys('request-one'), ['balances:request-one', 'calendar:request-one']);
  assert.deepEqual(resetKeys('request-two'), ['balances:request-two', 'calendar:request-two']);
});

test('approval calendar shows complete request weeks without six weeks of padding', () => {
  const daysFor = load('getApprovalCalendarDays', { toIsoDate:d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` });
  for(const [startDate,endDate,first,last,length] of [
    ['2027-01-22','2027-01-25','2027-01-18','2027-01-31',14],
    ['2026-09-11','2026-09-11','2026-09-07','2026-09-13',7],
    ['2026-09-28','2026-10-09','2026-09-28','2026-10-11',14],
  ]) { const days=daysFor({startDate,endDate}); assert.equal(days.length,length); assert.equal(days[0].iso,first); assert.equal(days.at(-1).iso,last); assert(days.some(d=>d.iso===startDate)); assert(days.some(d=>d.iso===endDate)); }
});

test('expanded approval calendar includes three weeks either side across year and leap-day boundaries', () => {
  const daysFor = load('getApprovalCalendarDays', { toIsoDate:d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` });
  for (const [startDate,endDate,first,last] of [
    ['2027-01-22','2027-01-25','2026-12-28','2027-02-21'],
    ['2028-02-29','2028-02-29','2028-02-07','2028-03-26'],
  ]) {
    const compact = daysFor({startDate,endDate});
    const expanded = daysFor({startDate,endDate}, true);
    assert.equal(expanded.length, compact.length + 42);
    assert.equal(expanded[0].iso, first);
    assert.equal(expanded.at(-1).iso, last);
    assert.deepEqual(expanded.slice(21,-21), compact);
  }
});

test('calendar toggle expands and collapses the same calendar even without overlapping events', () => {
  let expanded = false;
  const Calendar = load('ApprovalCalendar', {
    useState: () => [expanded, value => { expanded = value; }], useId: () => 'calendar',
    styles: {}, getApprovalCalendarDays: (_, value) => value ? [{iso:'2026-12-28'}, {iso:'2027-02-21'}] : [{iso:'2027-01-18'}, {iso:'2027-01-31'}],
    formatDateRange: (start,end) => `${start}–${end}`, formatTimeRange: () => '', checkInMilestoneLabel: () => '',
    approvalCalendarTeamLeave: load('approvalCalendarTeamLeave', {}),
  });
  const props = {selected:{id:'request',startDate:'2027-01-22',endDate:'2027-01-25'},requests:[],checkIns:[]};
  for (const [label, expected] of [['Expand calendar',false],['Collapse calendar',true],['Expand calendar',false]]) {
    const tree = Calendar(props);
    const action = buttons(tree)[0];
    assert.equal(action.props.children,label);
    assert.equal(action.props['aria-expanded'],expected);
    assert.equal(action.props['aria-controls'],'calendar');
    const viewport = tree.props.children.find(child => child?.props?.id === 'calendar');
    assert.match(viewport.props.children.props['aria-label'], expected ? /2026-12-28–2027-02-21/ : /2027-01-18–2027-01-31/);
    action.props.onClick();
  }
});

test('approval calendar shows the applicant team’s leave from team-labelled calendar entries', () => {
  const teamLeave = load('approvalCalendarTeamLeave', {});
  const entry = (id, personId, team, status = 'Approved', startDate = '2027-01-20', endDate = '2027-01-22') => ({ id, personId, team, status, startDate, endDate });
  const selected = { id: 'request', personId: 'applicant', team: 'MAM', startDate: '2027-01-20', endDate: '2027-01-21' };
  const calendar = [
    entry('request', 'applicant', 'MAM · Trades', 'Pending'),
    entry('teammate', 'teammate', 'MAM · Trades'),
    entry('teammate-pending', 'pending-teammate', 'MAM · Trades', 'Pending'),
    entry('declined', 'declined-teammate', 'MAM · Trades', 'Declined'),
    entry('other-team', 'scheduler', 'MAM · Scheduling'),
    entry('other-company', 'equipsy', 'Equipsy · Trades'),
    entry('outside-range', 'later', 'MAM · Trades', 'Approved', '2027-03-01', '2027-03-02'),
  ];
  assert.deepEqual(teamLeave(selected, calendar, '2027-01-18', '2027-01-31').map((request) => request.id), ['teammate', 'teammate-pending']);
  // Without a visible applicant entry, fall back to the applicant's company.
  assert.deepEqual(teamLeave(selected, calendar.slice(1), '2027-01-18', '2027-01-31').map((request) => request.id), ['teammate', 'teammate-pending', 'other-team']);
});
