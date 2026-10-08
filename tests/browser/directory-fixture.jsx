import { useState } from 'react';
import { EmployeeDirectory } from '@/components/employee-directory';
import { record, managerRecords } from './directory-actions';
window.directoryRefreshes = 0;
window.directorySelections = [];
export function DirectoryFixture() {
  const [selectedPersonId, setSelectedPersonId] = useState(record.personId);
  return <EmployeeDirectory initialRecords={new URLSearchParams(location.search).has('teamManager') ? [record, ...managerRecords] : [record]} selectedPersonId={selectedPersonId} canManageRoles={new URLSearchParams(location.search).get('viewer') !== 'admin'}
    onSelectedPersonId={id => { window.directorySelections.push(id); setSelectedPersonId(id); }} onRecordsChanged={() => { window.directoryRefreshes++; }} />;
}
export function EmployeeDeviceAssignments() { return null; }
