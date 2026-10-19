export const syntheticRolePeople = [
  { id: '11000000-0000-4000-8000-000000000002', role: 'admin', name: 'Synthetic Admin' },
  { id: '11000000-0000-4000-8000-000000000003', role: 'account', name: 'Synthetic Account' },
  { id: '11000000-0000-4000-8000-000000000004', role: 'manager', name: 'Synthetic Manager' },
  { id: '11000000-0000-4000-8000-000000000005', role: 'employee', name: 'Synthetic Employee' },
].map(person => ({ ...person, title: 'Coordinator', company: 'mam' }));

export const syntheticPerformanceManager = { id: '11000000-0000-4000-8000-000000000006', role: 'manager', name: 'Synthetic Manager B', title: 'Coordinator', company: 'mam' };

export const syntheticRoleOrgRows = syntheticRolePeople.map((person, index) => ({
  id: person.id, node_kind: 'person', company_key: person.company, full_name: person.name,
  position_title: person.title, parent_id: person.role === 'employee' ? syntheticRolePeople[2].id : null,
  sort_order: index, is_active: true, updated_at: '2026-10-01T00:00:00Z', version: 1,
}));

export function syntheticRoleDirectoryRecord(person) {
  return {
    personId: person.id, personVersion: 1, detailVersion: 1,
    company: person.company, isActive: true, firstName: 'Synthetic', lastName: person.name.split(' ')[1],
    fullName: person.name, positionTitle: person.title, teamName: 'Operation & Accounts',
    managerId: person.role === 'employee' ? syntheticRolePeople[2].id : null,
    managerName: person.role === 'employee' ? syntheticRolePeople[2].name : '',
    workEmail: `${person.role}@example.test`, personalEmail: '', phone: '', country: '', address: '', dateOfBirth: '',
    startedDate: '2026-01-05', scheduledEmploymentEndDate: '', workingWeekdays: [1, 2, 3, 4, 5],
    workingDayTimes: [], archiveReason: '', employmentType: 'full_time', contractType: 'permanent',
    hasPaidLeaveEntitlement: true, laptopSupplied: '', laptopId: '', mouseId: '', keyboardId: '', assetTags: [],
  };
}

export const syntheticRoleSubscription = {
  id: '33000000-0000-4000-8000-000000000001', subscriptionCode: 'SUB-TEST-001', serviceName: 'Synthetic service', planName: 'Team',
  company: 'mam', status: 'active', pricingModel: 'paid', billingCycle: 'monthly', amountCents: 1000, currency: 'AUD',
  renewalDate: null, seatCount: 2, creditCardUsed: false, creditCardHolder: null, billingDate: '2026-09-01',
  nextBillingOn: '2026-10-01', lastReviewedOn: null, nextReviewOn: '2026-10-01',
  responsible: { personId: syntheticRolePeople[2].id, fullName: syntheticRolePeople[2].name, positionTitle: 'Coordinator', teamName: 'Operation & Accounts', company: 'mam' },
  memberPersonIds: [syntheticRolePeople[3].id], memberNames: [syntheticRolePeople[3].name], version: 1,
};
