const contacts = CONTACT_FIXTURE_RESULTS;
const people = Object.values(contacts);
const calls = [], unexpected = [], held = new Set(), pending = new Map();
window.contactFixture = {
  calls, unexpected,
  hold(id) { held.add(id); },
  finish(id, reject = false) {
    const queue = pending.get(id), request = queue?.shift();
    if (!request) throw new Error('No pending contact mutation');
    if (!queue.length) pending.delete(id);
    if (reject) request.reject(new Error('synthetic uncertain response'));
    else request.resolve(request.result);
  },
  pendingKeys: () => [...pending.keys()],
  identical(id, source) { contacts[id] = { ...contacts[source], personId: id }; },
};
const workspace = id => ({ requests: [], attachments: [], calendarEntries: [], birthdayEntries: [], checkInEntries: [], subscriptionReviewEntries: [], payrollBalanceReminderEntries: [], canViewSubscriptionReviewCalendar: false, canViewPayrollBalanceReminderCalendar: false, canImportPayrollBalances: false, canReviewLeave: false, canViewAllLeave: false, employmentType: null, hasPaidLeaveEntitlement: false, availableLeaveTypes: [], isProfilePreview: Boolean(id), priority: { people: [], requests: [], pendingBalanceCalendarIds: [], canManageBalances: false } });
export async function invokeServerAction(module, name, args) {
  calls.push({ module, name, args });
  if (name === 'getPortalRoleCapabilities') return CONTACT_ROLE_RESULTS[args[0] || 'self'];
  if (name === 'getSelectedEmployeeProfile') return contacts[args[0]];
  if (name === 'getCurrentEmployeeSelfProfile') return contacts[people[0].personId];
  if (name === 'updateSelectedEmployeeProfile' || name === 'updateCurrentEmployeeSelfProfile') {
    const input = args[0], id = input.personId ?? people[0].personId;
    const result = { ...contacts[id], ...input, detailVersion: contacts[id].detailVersion + 1 };
    if (held.delete(id)) return new Promise((resolve, reject) => {
      const queue = pending.get(id) ?? []; queue.push({ resolve, reject, result }); pending.set(id, queue);
    });
    return result;
  }
  if (name === 'getLeaveWorkspaceData') return workspace(args[0]);
  if (name === 'listEmployeeDirectoryRecords') return [];
  if (name === 'listEmployeeDirectoryRoles') return Object.fromEntries(people.map(p => [p.personId, 'employee']));
  if (name === 'loadEmployeeWorkScheduleWorkspace') return { ok: true, workspace: { activePersonId: args[0] ?? null, activePersonName: contacts[args[0]]?.name ?? null, workingWeekdays: null, workingDayTimes: [], initialSetupAvailable: false, canRequestChange: false, isProfilePreview: Boolean(args[0]), history: [], reviews: [] } };
  if (['listPortalAccounts', 'listEmployeeTeamDirectory', 'listEmployeeSubscriptionsForPreview', 'listMySubscriptions', 'listItAssetsForEmployeePreview', 'listMyItAssets'].includes(name)) return [];
  unexpected.push({ module, name });
  throw new Error('Unimplemented synthetic action '+module+':'+name);
}
const rows = people.map((p, i) => ({ id: p.personId, node_kind: 'person', company_key: p.company, full_name: p.name, position_title: p.title, parent_id: null, sort_order: i, is_active: true, updated_at: '2026-10-01T00:00:00Z', version: 1 }));
const client = {
  from(table) {
    if (table !== 'internal_org_people') throw new Error('Unexpected synthetic table '+table);
    const query = { select: () => query, order: () => query, then: done => Promise.resolve({ data: rows, error: null }).then(done) }; return query;
  },
  async rpc(name) {
    if (name === 'can_edit_internal_org' || name === 'can_manage_employee_directory') return { data: true, error: null };
    throw new Error('Unexpected synthetic RPC '+name);
  },
  channel() { const channel = { on: () => channel, subscribe: () => channel }; return channel; },
  async removeChannel() {},
};
export function createClient() { return client; }
