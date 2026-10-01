export const record = {
  personId: '10000000-0000-4000-8000-000000000001', personVersion: 1, detailVersion: 1,
  firstName: 'Taylor', lastName: 'Synthetic', fullName: 'Taylor Synthetic', positionTitle: 'Coordinator',
  workEmail: '', personalEmail: '', phone: '', teamName: 'Operation & Accounts', managerId: null, managerName: '',
  country: '', address: '', dateOfBirth: '', startedDate: '2026-10-05', scheduledEmploymentEndDate: '',
  workingWeekdays: null, workingDayTimes: [], archiveReason: '', employmentType: 'full_time', contractType: '',
  laptopSupplied: '', laptopId: '', mouseId: '', keyboardId: '', assetTags: [], company: 'mam', isActive: true,
};
window.directoryCalls = [];
export async function listEmployeeDirectoryRecords() { return [record]; }
export async function listEmployeeDirectoryRoles() { return { [record.personId]: 'employee' }; }
async function mutate(method, input) {
  window.directoryCalls.push({ method, input });
  const outcome = new URLSearchParams(location.search).get('outcome') ?? 'lock';
  if (outcome === 'transport') throw new Error('private synthetic provider details');
  if (outcome === 'success' || outcome === 'warning') return { record: { ...record, ...input, personVersion: 2, detailVersion: 2 }, ...(outcome === 'warning' ? { warning: 'Employee details were saved, but the contract type was not. Choose it again and save.' } : {}) };
  return DIRECTORY_FIXTURE_RESULTS[outcome];
}
export async function createEmployeeDirectoryRecord(input) { return mutate('create', input); }
export async function updateEmployeeDirectoryRecord(input) { return mutate('update', input); }
export async function updateEmployeeDirectoryRole(input) { window.directoryCalls.push({ method: 'role', input }); return DIRECTORY_FIXTURE_RESULTS[new URLSearchParams(location.search).get('outcome') === 'partialRole' ? 'partialRole' : 'role']; }
export async function archiveEmployeeDirectoryRecord() { throw new Error('Unexpected archive'); }
export async function deleteEmployeeDirectoryRecord() { throw new Error('Unexpected delete'); }
