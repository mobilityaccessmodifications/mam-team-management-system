import { syntheticRolePeople, syntheticRoleOrgRows, syntheticRoleDirectoryRecord, syntheticRoleSubscription } from './unified-role-data.mjs';
import { completedFixtureToday, leaveCompletedRequests } from './leave-completed-data.mjs';

const completedMode = new URLSearchParams(location.search).has('leave-completed');
const inlineRequestMode = new URLSearchParams(location.search).get('subscription-inline');
let requestRows = [], registeredSubscriptions = [syntheticRoleSubscription];
const requestApplicant = { id: syntheticRolePeople[0].id, name: 'Synthetic Applicant' };
function requestWorkspace() {
  if (inlineRequestMode === 'denied') return { ok: false, denied: true, message: 'You do not have permission for this request.' };
  return { ok: true, data: {
    enabled: Boolean(inlineRequestMode) && inlineRequestMode !== 'unavailable', canApply: Boolean(inlineRequestMode) && inlineRequestMode !== 'no-apply',
    requestFormVersion: inlineRequestMode === 'legacy' ? 2 : inlineRequestMode === 'unsupported' ? 1 : 3,
    viewerName: requestApplicant.name, viewerPersonId: requestApplicant.id, canManageCredentials: false,
    requests: requestRows, people: syntheticRolePeople.map(person => ({ id: person.id, name: person.name })),
  } };
}

const ordinaryReviewEmployee = new URLSearchParams(location.search).get('subscription-reviews') === 'register-manager';
const combinedTasks = new URLSearchParams(location.search).get('tasks') === 'combined';
const scheduleTasks = combinedTasks && new URLSearchParams(location.search).has('schedule-tasks');
const subscriptionReviewsFail = new URLSearchParams(location.search).has('subscription-review-error');
const reviewOwnerId = syntheticRolePeople[3].id;
let checkInRows = combinedTasks ? [
  { person_id: reviewOwnerId, full_name: 'Synthetic Check-in Employee', position_title: 'Coordinator', company_key: 'mam', reminders: [
    { id: '66000000-0000-4000-8000-000000000001', milestone: '1_month', sequence: 'initial', dueDate: '2000-01-01', status: 'delivered', needsReviewReason: null },
    { id: '66000000-0000-4000-8000-000000000002', milestone: '5_month', sequence: 'initial', dueDate: '2000-01-02', status: 'needs_review', needsReviewReason: 'missing_manager_email' },
  ] },
  { person_id: syntheticRolePeople[2].id, full_name: 'Synthetic Future Employee', position_title: 'Installer', company_key: 'equipsy', reminders: [
    { id: '66000000-0000-4000-8000-000000000003', milestone: '6_month', sequence: 'initial', dueDate: '2500-01-01', status: 'scheduled', needsReviewReason: null },
  ] },
] : [];
if (combinedTasks && new URLSearchParams(location.search).has('paged-tasks')) {
  checkInRows.push(...Array.from({ length: 16 }, (_, index) => ({
    person_id: reviewOwnerId, full_name: `Synthetic Paged Employee ${String(index + 1).padStart(2, '0')}`, position_title: 'Coordinator', company_key: 'mam',
    reminders: [{ id: `66000000-0000-4000-8000-${String(index + 4).padStart(12, '0')}`, milestone: '1_month', sequence: 'initial', dueDate: '2001-01-01', status: 'delivered', needsReviewReason: null }],
  })));
}
let reviewRows = [
  { subscription_id: '33000000-0000-4000-8000-000000000010', service_name: 'Synthetic due review', next_review_on: '2000-01-01', subscription_status: 'active', version: 4 },
  { subscription_id: '33000000-0000-4000-8000-000000000011', service_name: 'Synthetic future review', next_review_on: '2500-01-01', subscription_status: 'paused', version: 1 },
];
let passwordRows = new URLSearchParams(location.search).has('subscription-passwords') ? [
  {task_id:'34000000-0000-4000-8000-000000000001',subscription_id:'33000000-0000-4000-8000-000000000010',service_name:'Synthetic password service',due_on:'2000-01-01',version:1},
] : [];
let scheduleRequest = {
  id: '88000000-0000-4000-8000-000000000001',
  originalWorkingWeekdays: [1, 3, 5], originalWorkingDayTimes: [{ weekday: 1, startTime: '09:00', endTime: '17:00' }],
  requestedWorkingWeekdays: [2, 4], requestedWorkingDayTimes: [{ weekday: 2, startTime: '10:00', endTime: '16:00' }],
  requestReason: 'Synthetic change to support a study timetable', submittedByName: 'Synthetic Employee',
  status: 'submitted', submittedAt: '2026-10-01T00:00:00Z', decidedAt: null, reviewerName: null, decisionReason: null,
};
const notesStorageKey = 'mam-synthetic-task-notes';
const taskNotes = JSON.parse(sessionStorage.getItem(notesStorageKey) ?? '{}');
const notesKey = target => `${target.kind}:${target.taskId}:${target.reviewOn ?? ''}`;
const readNotes = target => ({ ...(taskNotes[notesKey(target)] ?? { text: '', version: 0 }) });
const writeNotes = (target, notes) => {
  taskNotes[notesKey(target)] = { ...notes };
  sessionStorage.setItem(notesStorageKey, JSON.stringify(taskNotes));
};

const calls = [], unexpected = [];
const roleById = Object.fromEntries(syntheticRolePeople.map(person => [person.id, person.role]));
const personFor = id => syntheticRolePeople.find(person => person.id === id);
const previewReviewDelegate = new URLSearchParams(location.search).get('subscription-reviews') === 'preview-register-manager';
const grantsById = ordinaryReviewEmployee || previewReviewDelegate
  ? { [reviewOwnerId]: { can_view_subscription_register: true, can_manage_subscriptions: true, can_manage_subscription_credentials: false } } : {};
const delegationPeople = Array.from({ length: 80 }, (_, index) => ({
  personId: `77000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  fullName: `Synthetic ${index === 0 ? 'Manager' : 'Employee'} ${String(index + 1).padStart(2, '0')}`,
  positionTitle: index === 0 ? 'Manager' : 'Employee',
}));
let delegationManagement = [], delegationVault = [];
const outcomeFor = id => {
  const result = UNIFIED_ROLE_FIXTURE_RESULTS.roles[id][roleById[id]];
  if (!['manager','employee'].includes(roleById[id]) || !grantsById[id]) return result;
  return { ...result, capabilities: { ...result.capabilities, ...grantsById[id] } };
};
export const actorCapabilities = ordinaryReviewEmployee ? outcomeFor(reviewOwnerId).capabilities : UNIFIED_ROLE_FIXTURE_RESULTS.actor.capabilities;
const failures = new Map(), held = new Set(), pending = new Map(), responses = [];
window.unifiedRoleFixture = {
  calls, unexpected, responses,
  leaveSnapshot(id) { const workspace = leaveWorkspace(id); return { today: completedFixtureToday, requests: workspace.requests, calendarEntries: workspace.calendarEntries }; },
  setRole(id, role) {
    if (!Object.hasOwn(UNIFIED_ROLE_FIXTURE_RESULTS.roles[id], role)) throw new Error('Invalid synthetic role');
    roleById[id] = role;
  },
  setContact(id, sourceId) { UNIFIED_ROLE_FIXTURE_RESULTS.contacts[id] = { ...UNIFIED_ROLE_FIXTURE_RESULTS.contacts[sourceId], personId: id }; },
  holdNext(name, id) { held.add(`${name}:${id ?? ''}`); },
  pendingKeys: () => [...pending.keys()],
  finish(name, id) {
    const key = `${name}:${id ?? ''}`;
    const queue = pending.get(key);
    const request = queue?.shift();
    if (!request) throw new Error(`No synthetic pending request ${key}`);
    if (!queue.length) pending.delete(key);
    request.resolve(request.result);
  },
  rejectPending(name, id) {
    const key = `${name}:${id ?? ''}`;
    const queue = pending.get(key);
    const request = queue?.shift();
    if (!request) throw new Error(`No synthetic pending request ${key}`);
    if (!queue.length) pending.delete(key);
    request.resolve(Promise.reject(new Error('synthetic uncertain save outcome')));
  },
  failNext(name, id, kind) { failures.set(`${name}:${id ?? ''}`, kind); },
  setTaskNotes(target, text, version) { writeNotes(target, { text, version }); },
  removeScheduleRequest() { scheduleRequest = { ...scheduleRequest, status: 'cancelled' }; },
  setSubscriptionGrants(id, management, vault) {
    grantsById[id] = { can_manage_subscriptions: management, can_manage_subscription_credentials: vault };
  },
};

function leaveWorkspace(id = ordinaryReviewEmployee ? reviewOwnerId : undefined) {
  const role = id ? roleById[id] : 'system_admin';
  const people = role === 'manager' ? syntheticRolePeople.filter(person => person.id === id || person.role === 'employee')
    : role === 'employee' ? [personFor(id)] : syntheticRolePeople;
  let requests = people.map(person => ({
    id: person.id.replace(/^11/, '22'), personId: person.id, employee: person.name, company: person.company,
    leaveType: 'Annual leave', startDate: '2026-10-12', endDate: '2026-10-12', days: 1, hours: 7.6,
    fullDayHours: 7.6, approvalRequired: true, status: 'Pending', submittedAt: '2026-10-01T00:00:00Z',
    assignedReviewerLabel: 'Synthetic reviewer',
    canDecide: person.id !== id && (role === 'manager' || role === 'admin' || role === 'system_admin'),
    canCancel: person.id === id, canAttach: person.id === id, employeeNote: 'Synthetic retained employee note',
  }));
  if (role === 'account') for (const [index, status] of ['Approved', 'Declined', 'Cancelled'].entries()) {
    const request = requests.find(request => request.personId === syntheticRolePeople[3].id);
    requests.push({ ...request, id: `23000000-0000-4000-8000-00000000000${index}`, status });
  }
  if (completedMode) requests = leaveCompletedRequests(people, id, role);
  const attachments = requests.some(request => request.id === syntheticRolePeople[3].id.replace(/^11/, '22')) ? [{
    id: '44000000-0000-4000-8000-000000000001', leaveRequestId: syntheticRolePeople[3].id.replace(/^11/, '22'),
    fileName: 'synthetic-evidence.pdf', mimeType: 'application/pdf', sizeBytes: 128, createdAt: '2026-10-01T00:00:00Z', canDelete: role === 'employee',
  }] : [];
  return {
    requests, attachments, calendarEntries: requests.filter(request => request.status === 'Pending' || request.status === 'Approved').map(request => ({ ...request, teamName: 'Operation & Accounts' })), birthdayEntries: [], checkInEntries: [],
    subscriptionReviewEntries: [], payrollBalanceReminderEntries: [],
    canViewSubscriptionReviewCalendar: false, canViewPayrollBalanceReminderCalendar: false,
    canImportPayrollBalances: role === 'account' || role === 'admin' || role === 'system_admin',
    canReviewLeave: role === 'manager' || role === 'admin' || role === 'system_admin',
    canViewAllLeave: role === 'account' || role === 'admin' || role === 'system_admin',
    employmentType: id ? 'full_time' : null, hasPaidLeaveEntitlement: Boolean(id),
    availableLeaveTypes: id ? [{ value: 'Annual leave', label: 'Annual leave' }] : [],
    isProfilePreview: Boolean(id),
    priority: { people: [], requests: [], pendingBalanceCalendarIds: [], canManageBalances: role === 'admin' || role === 'system_admin' },
  };
}

const handlers = {
  '@/app/roles/actions': { getPortalRoleCapabilities: id => id ? outcomeFor(id) : ordinaryReviewEmployee ? UNIFIED_ROLE_FIXTURE_RESULTS.roles[reviewOwnerId].employee : UNIFIED_ROLE_FIXTURE_RESULTS.actor },
  '@/app/profile/actions': { getCurrentEmployeeSelfProfile: () => UNIFIED_ROLE_FIXTURE_RESULTS.contacts[reviewOwnerId], getSelectedEmployeeProfile: id => UNIFIED_ROLE_FIXTURE_RESULTS.contacts[id], updateSelectedEmployeeProfile: input => ({ ...UNIFIED_ROLE_FIXTURE_RESULTS.contactMutations[input.personId], phone: input.phone, personalEmail: input.personalEmail, dateOfBirth: input.dateOfBirth }) },
  '@/app/people/actions': {
    listEmployeeDirectoryRecords: () => syntheticRolePeople.map(syntheticRoleDirectoryRecord),
    listEmployeeDirectoryRoles: () => ({ ...roleById }), getOrganisationPersonWorkEmail: id => `${personFor(id).role}@example.test`,
  },
  '@/app/accounts/actions': { listPortalAccounts: () => [] },
  '@/app/leave/actions': { getLeaveWorkspaceData: leaveWorkspace },
  '@/app/work-schedule/actions': { loadEmployeeWorkScheduleWorkspace: previewPersonId => {
    const id = previewPersonId ?? (ordinaryReviewEmployee ? reviewOwnerId : undefined);
    return { ok: true, workspace: {
    activePersonId: id ?? null, activePersonName: personFor(id)?.name ?? null, workingWeekdays: id ? [1, 2, 3, 4, 5] : null,
    workingDayTimes: [], initialSetupAvailable: false, canRequestChange: Boolean(id), isProfilePreview: Boolean(previewPersonId),
    history: scheduleTasks && id === reviewOwnerId ? [{ ...scheduleRequest }] : [],
    reviews: scheduleTasks && (!id || roleById[id] === 'manager') ? [{ ...scheduleRequest, personId: reviewOwnerId, employeeName: 'Synthetic Employee' }] : [],
  } }; }, reviewEmployeeWorkScheduleChange: input => {
    if (input.requestId !== scheduleRequest.id || scheduleRequest.status !== 'submitted' || !input.reason.trim()) return { ok: false, message: 'Enter a valid decision reason for this request.' };
    scheduleRequest = { ...scheduleRequest, status: input.decision, decisionReason: input.reason, reviewerName: 'Synthetic Admin' };
    return { ok: true };
  } },
  '@/app/people/team-directory-actions': { listEmployeeTeamDirectory: id => [personFor(id)].filter(Boolean).map(person => ({
    id: person.id, name: person.name, position: person.title, company: person.company,
    reportsTo: null, managerName: '', kind: 'person', isActive: true, version: 1,
  })) },
  '@/app/people/manager-actions': { listManagedEmployeeDirectoryRecordsAction: id => ({ ok: true, records: syntheticRolePeople.filter(person => person.id === id || person.role === 'employee').map(person => {
    const record = syntheticRoleDirectoryRecord(person);
    return Object.fromEntries(['personId', 'personVersion', 'detailVersion', 'company', 'isActive', 'firstName', 'lastName', 'fullName', 'positionTitle', 'teamName', 'managerName', 'workEmail'].map(key => [key, record[key]]));
  }) }) },
  '@/app/payroll-balances/actions': {
    getPayrollBalanceImportWorkspace: () => ({ status: 'ready', workspace: {
      canImport: true, canManageAccess: false, recentBatches: [],
      reminder: { dueOn: '2026-10-01', mamAsOf: null, equipsyAsOf: null, mamComplete: false, equipsyComplete: false, complete: false },
    } }),
    stagePayrollBalanceFiles: (formData, id) => ({ ok: true, batch: {
      batchId: '55000000-0000-4000-8000-000000000001', version: 1, status: 'staged', comparisonOnly: roleById[id] === 'account',
      differenceCount: 0, createdAt: '2026-10-01T00:00:00Z', committedAt: null,
      files: formData.getAll('files').map(file => ({ name: file.name, sizeBytes: file.size, companies: ['mam'], asOfDates: ['2026-10-01'], employeeRows: 1 })),
      rows: [{ rowId: 1, employeeName: 'Synthetic Employee', company: 'mam', annualHours: 16, sickHours: null, asOf: '2026-10-01', status: 'linked', linkedName: 'Synthetic Employee', willApplyAnnual: false, willApplySick: false }],
      comparisonRows: [{ rowId: 1, employeeName: 'Synthetic Employee', company: 'mam', kind: 'annual', uploadedHours: 16, systemHours: 16, fileAsOf: '2026-10-01', systemAsOf: '2026-10-01', different: false }],
    } }),
  },
  '@/app/assets/employee-actions': { listItAssetsForEmployeePreview: () => [], listMyItAssets: () => [] },
  '@/app/assets/actions': { listItAssetsForEmployee: () => [], listItAssets: () => [], listItAssetAssignees: () => [] },
  '@/app/subscriptions/actions': {
    listSubscriptions: () => registeredSubscriptions,
    createSubscription: input => {
      const person = syntheticRolePeople.find(person => person.id === input.responsiblePersonId);
      const subscription = { ...syntheticRoleSubscription, ...input, id: '33000000-0000-4000-8000-000000000020',
        responsible: { ...syntheticRoleSubscription.responsible, personId: person.id, fullName: person.name }, memberNames: [],
      };
      registeredSubscriptions = [...registeredSubscriptions, subscription];
      return subscription;
    },
    listSubscriptionPeople: () => syntheticRolePeople.map(person => ({ personId: person.id, fullName: person.name, positionTitle: person.title, teamName: 'Operation & Accounts', company: person.company })),
  },
  '@/app/subscription-requests/actions': {
    loadSubscriptionRequests: requestWorkspace,
    mutateSubscriptionRequest: input => {
      const evidence = (input.evidence ?? []).map(file => ({ name: file.name, mime: file.mime, bytes: atob(file.base64).length }));
      const payload = structuredClone(input.payload);
      const row = { id: input.id, applicant: requestApplicant.id, applicantName: requestApplicant.name,
        requestedAt: '2026-10-15T00:00:00Z', status: input.operation === 'submit' ? 'submitted' : 'draft',
        version: input.version + 1, revision: 1, evidenceVersion: input.version + 1, payload, evidence,
        events: [{ version: input.version + 1, operation: input.operation, actor: requestApplicant.id,
          actorName: requestApplicant.name, at: '2026-10-15T00:00:00Z', payload, evidence, reason: '' }],
        canEdit: input.operation !== 'submit', canDecide: false, canWithdraw: input.operation === 'submit',
        canActivate: false, canCompletePurchase: false, linkedSubscriptionId: null,
      };
      requestRows = [row, ...requestRows.filter(request => request.id !== row.id)];
      return { ok: true, data: row, committed: true };
    },
  },
  '@/app/subscriptions/delegation-actions': {
    listSubscriptionManagementDelegates: () => ({ ok: true, delegates: delegationPeople.filter(person => delegationManagement.includes(person.personId)) }),
    replaceSubscriptionManagementDelegates: ids => { delegationManagement = [...ids]; return { ok: true }; },
  },
  '@/app/subscription-credentials/actions': {
    listSubscriptionCredentialCatalogue: () => [{ subscriptionId: syntheticRoleSubscription.id, credentialsSaved: false }],
    listSubscriptionCredentialGrantCandidates: () => delegationPeople,
    listSubscriptionCredentialAccessGrants: () => delegationPeople.filter(person => delegationVault.includes(person.personId)),
    replaceSubscriptionCredentialAccessGrants: ids => { delegationVault = [...ids]; return { ok: true }; },
  },
  '@/app/subscriptions/review-task-actions': { completeMySubscriptionReviewTask: input => {
    if (!ordinaryReviewEmployee || input.subscriptionId !== reviewRows[0].subscription_id || input.version !== reviewRows[0].version) return UNIFIED_ROLE_FIXTURE_RESULTS.reviewStale;
    const result = UNIFIED_ROLE_FIXTURE_RESULTS.reviewCompleted;
    if (result.ok && result.task) reviewRows = reviewRows.map(row => row.subscription_id === input.subscriptionId ? { ...row, next_review_on: result.task.nextReviewOn, version: result.task.version } : row);
    return result;
  } },
  '@/app/subscriptions/password-task-actions': { completeMySubscriptionPasswordTask: input => {
    const task = passwordRows.find(row => row.task_id === input.taskId);
    if (!ordinaryReviewEmployee || !task || task.version !== input.version || input.passwordChanged !== true) return {ok:false,error:'Password task changed.'};
    passwordRows = passwordRows.filter(row => row.task_id !== input.taskId);
    return UNIFIED_ROLE_FIXTURE_RESULTS.passwordCompleted;
  } },
  '@/app/check-in-tasks/actions': { completeMyEmployeeCheckInTask: reminderId => {
    checkInRows = checkInRows.map(row => ({ ...row, reminders: row.reminders.filter(reminder => reminder.id !== reminderId) }));
  } },
  '@/app/tasks/note-actions': {
    getTaskNotes: target => ({ ok: true, notes: readNotes(target) }),
    saveTaskNotes: input => {
      const current = readNotes(input.target);
      if (current.version !== input.version) return { ok: false, error: 'Notes have changed. Refresh and try again.' };
      const notes = { text: input.text, version: current.version + 1 };
      writeNotes(input.target, notes);
      return { ok: true, notes };
    },
  },
  '@/app/subscriptions/employee-actions': { listEmployeeSubscriptionsForPreview: () => [], listMySubscriptions: () => [] },
};

export async function invokeServerAction(module, name, args) {
  calls.push({ module, name, args: args.map(arg => arg instanceof FormData ? { files: arg.getAll('files').map(file => ({ name: file.name, type: file.type, size: file.size })) } : arg) });
  const key = `${name}:${['mutateSubscriptionRequest', 'createSubscription'].includes(name) ? '' : args[0]?.personId ?? args[0]?.subscriptionId ?? args[0]?.requestId ?? args[0]?.target?.taskId ?? args[0]?.taskId ?? args[0] ?? ''}`;
  const failure = failures.get(key);
  if (failure) {
    failures.delete(key);
    if (failure === 'contact') throw new Error(UNIFIED_ROLE_FIXTURE_RESULTS.contactError);
    if (['loadSubscriptionRequests', 'mutateSubscriptionRequest'].includes(name) && failure === 'denied') return { ok: false, denied: true, message: 'You do not have permission for this request.' };
    if (name === 'mutateSubscriptionRequest' && failure === 'uncertain') return { ok: false, denied: false, uncertain: true, message: 'The request could not be confirmed. Reload before retrying.' };
    if (name === 'getPortalRoleCapabilities' && (failure === 'denied' || failure === 'malformed')) return UNIFIED_ROLE_FIXTURE_RESULTS[failure];
    if (name === 'saveTaskNotes' && failure === 'stale') return { ok: false, error: 'Notes have changed. Refresh and try again.' };
    if (failure === 'transport') throw new Error('private synthetic provider permission detail');
    throw new Error(`Unexpected synthetic failure ${failure}`);
  }
  const handler = handlers[module]?.[name];
  if (!handler) {
    unexpected.push({ module, name });
    throw new Error(`Unexpected synthetic action ${module}:${name}`);
  }
  const result = await handler(...args);
  if (held.delete(key)) {
    const delayed = await new Promise(resolve => {
      const queue = pending.get(key) ?? [];
      queue.push({ resolve, result });
      pending.set(key, queue);
    });
    responses.push({ key });
    return delayed;
  }
  responses.push({ key });
  return result;
}

const client = {
  from(table) {
    if (table !== 'internal_org_people') throw new Error(`Unexpected synthetic table ${table}`);
    const query = { select: () => query, order: () => query, then: done => Promise.resolve({ data: syntheticRoleOrgRows, error: null }).then(done) };
    return query;
  },
  async rpc(name, args) {
    calls.push({ module: 'supabase', name, args: [args] });
    if (name === 'list_my_employee_check_in_tasks' || name === 'list_employee_check_in_tasks_for_preview') return { data: checkInRows, error: null };
    if (name === 'list_my_subscription_review_tasks') return subscriptionReviewsFail ? { data: null, error: { code: 'XX000', message: 'synthetic private provider detail' } } : { data: ordinaryReviewEmployee ? reviewRows : [], error: null };
    if (name === 'list_subscription_review_tasks_for_preview') return { data: args.p_person_id === reviewOwnerId && grantsById[reviewOwnerId]?.can_manage_subscriptions ? reviewRows : [], error: null };
    if (name === 'list_my_subscription_password_tasks') return {data:ordinaryReviewEmployee ? passwordRows : [],error:null};
    if (name === 'list_subscription_password_tasks_for_preview') return {data:args.p_person_id === reviewOwnerId && grantsById[reviewOwnerId]?.can_manage_subscriptions ? passwordRows : [],error:null};
    if (name === 'can_edit_internal_org' || name === 'can_manage_employee_directory') return { data: true, error: null };
    unexpected.push({ module: 'supabase', name });
    throw new Error(`Unexpected synthetic RPC ${name}`);
  },
  channel() {
    const channel = { on: () => channel, subscribe: () => channel };
    return channel;
  },
  async removeChannel() {},
};
export function createClient() { return client; }
