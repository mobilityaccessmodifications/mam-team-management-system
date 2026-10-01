import { useState } from 'react';
import { EmployeeDirectory } from '@/components/employee-directory';
import { record } from './directory-actions';
window.directoryRefreshes = 0;
window.directorySelections = [];
export function DirectoryFixture() {
  const [selectedPersonId, setSelectedPersonId] = useState(record.personId);
  return <EmployeeDirectory initialRecords={[record]} selectedPersonId={selectedPersonId}
    onSelectedPersonId={id => { window.directorySelections.push(id); setSelectedPersonId(id); }} onRecordsChanged={() => { window.directoryRefreshes++; }} />;
}
export function EmployeeDeviceAssignments() { return null; }
