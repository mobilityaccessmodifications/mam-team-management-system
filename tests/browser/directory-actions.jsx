export const record = {
  personId: '10000000-0000-4000-8000-000000000001', personVersion: 1, detailVersion: 1,
  firstName: 'Taylor', lastName: 'Synthetic', fullName: 'Taylor Synthetic', positionTitle: 'Coordinator',
  workEmail: '', personalEmail: '', phone: '', teamName: 'Operation & Accounts', managerId: null, managerName: '',
  country: '', address: '', dateOfBirth: '', startedDate: '2026-10-05', scheduledEmploymentEndDate: '',
  workingWeekdays: null, workingDayTimes: [], archiveReason: '', employmentType: 'full_time', contractType: '',
  laptopSupplied: '', laptopId: '', mouseId: '', keyboardId: '', assetTags: [], company: 'mam', isActive: true,
};
window.directoryCalls = [];
window.directoryRoleReads = 0;
window.directoryManagerReads = [];
export const managerRecords = [
  { ...record, personId: '10000000-0000-4000-8000-000000000002', firstName: 'Morgan', fullName: 'Morgan Synthetic', positionTitle: 'Manager' },
  { ...record, personId: '10000000-0000-4000-8000-000000000003', firstName: 'Casey', fullName: 'Casey Synthetic', positionTitle: 'Manager', company: 'equipsy', teamName: 'Equipsy' },
  { ...record, personId: '10000000-0000-4000-8000-000000000004', firstName: 'Riley', fullName: 'Riley Synthetic', positionTitle: 'Manager' },
];
export async function getEmployeeTeamManagerDefault(input) {
  window.directoryManagerReads.push(input);
  const params = new URLSearchParams(location.search);
  const state = params.get('managerState');
  const result = DIRECTORY_MANAGER_FIXTURE_RESULTS[state === 'missing' || state === 'invalid' ? state : input.company];
  if (state === 'held' && input.company === 'mam' && input.teamName === 'Warehouse') {
    return new Promise(resolve => { window.releaseOldTeamManager = () => resolve(result); });
  }
  return params.has('teamManager') ? result : DIRECTORY_MANAGER_FIXTURE_RESULTS.missing;
}
export async function listEmployeeDirectoryRecords() { return new URLSearchParams(location.search).has('teamManager') ? [record, ...managerRecords] : [record]; }
export async function listEmployeeDirectoryRoles() {
  window.directoryRoleReads++;
  return { [record.personId]: new URLSearchParams(location.search).get('storedRole') ?? 'employee' };
}
async function mutate(method, input) {
  window.directoryCalls.push({ method, input });
  const outcome = new URLSearchParams(location.search).get('outcome') ?? 'lock';
  if (outcome === 'transport') throw new Error('private synthetic provider details');
  if (outcome === 'success' && method === 'create' && new URLSearchParams(location.search).has('teamManager')) {
    const state = new URLSearchParams(location.search).get('managerState');
    const configured = DIRECTORY_MANAGER_FIXTURE_RESULTS[state === 'missing' || state === 'invalid' ? state : input.company];
    const managerId = input.managerId ?? (configured.status === 'valid' ? configured.managerId : null);
    return { record: { ...record, ...input, personVersion: 2, detailVersion: 2,
      fullName: [input.firstName, input.lastName].filter(Boolean).join(' '), managerId,
      managerName: managerRecords.find(manager => manager.personId === managerId)?.fullName ?? '' } };
  }
  if (outcome === 'success' || outcome === 'warning') return { record: { ...record, ...input, personVersion: 2, detailVersion: 2 }, ...(outcome === 'warning' ? { warning: 'Employee details were saved, but the contract type was not. Choose it again and save.' } : {}) };
  return DIRECTORY_FIXTURE_RESULTS[outcome];
}
export async function createEmployeeDirectoryRecord(input) { return mutate('create', input); }
export async function updateEmployeeDirectoryRecord(input) { return mutate('update', input); }
export async function updateEmployeeDirectoryRole(input) {
  window.directoryCalls.push({ method: 'role', input });
  const outcome = new URLSearchParams(location.search).get('outcome');
  if (outcome === 'roleSuccess') return DIRECTORY_FIXTURE_RESULTS.roleSuccess[input.role];
  return DIRECTORY_FIXTURE_RESULTS[outcome === 'partialRole' ? 'partialRole' : 'role'];
}
export async function archiveEmployeeDirectoryRecord(input) {
  const scenario = new URLSearchParams(location.search).get('archivePreflight');
  if (scenario !== 'reports' && scenario !== 'readError') throw new Error('Unexpected archive');
  window.directoryCalls.push({ method: 'archive', input });
  return DIRECTORY_ARCHIVE_FIXTURE_RESULTS[scenario];
}
export async function deleteEmployeeDirectoryRecord() { throw new Error('Unexpected delete'); }
