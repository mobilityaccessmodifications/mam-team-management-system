import { BALANCE_PENDING_STATUS, melbourneToday } from '@/lib/leave-priority';

// Synthetic date-only requests, frozen at fixture load. The real parent must
// reclassify them after midnight without fetching/mutating their approval state.
export const completedFixtureToday = melbourneToday();
const shift = days => {
  const date = new Date(`${completedFixtureToday}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
export function leaveCompletedRequests(people, activeId, role) {
  return people.flatMap((person, personIndex) => {
    const request = (index, startDate, endDate, status = 'Approved', changes = {}) => ({
      id: `26000000-0000-4000-8000-${String(personIndex * 100 + index + 1).padStart(12, '0')}`,
      personId: person.id, employee: person.name, company: person.company,
      leaveType: index === 24 ? 'Sick leave' : 'Annual leave', startDate, endDate,
      days: 1, hours: 7.6, fullDayHours: 7.6, approvalRequired: true, status,
      submittedAt: `${shift(-30)}T00:00:00Z`, assignedReviewerLabel: 'Synthetic reviewer',
      canDecide: person.id !== activeId && ['manager', 'admin', 'system_admin'].includes(role)
        && ['Pending', BALANCE_PENDING_STATUS].includes(status),
      canCancel: false, canAttach: false, ...changes,
    });
    return [
      ...Array.from({ length: 25 }, (_, index) => request(index, shift(-1 - index), shift(-1 - index), 'Approved',
        index === 1 ? { startDate: shift(-5), days: 4, hours: 30.4 }
          : index === 2 ? { hours: 3, startTime: '09:00', endTime: '12:00' } : {})),
      request(25, shift(0), shift(0), 'Approved', { hours: 3, startTime: '09:00', endTime: '12:00' }),
      request(26, shift(-2), shift(1), 'Approved', { days: 4, hours: 30.4 }),
      request(27, shift(2), shift(2)),
      ...['Pending', BALANCE_PENDING_STATUS, 'Declined', 'Cancelled'].map((status, index) => request(28 + index, shift(-2), shift(-2), status)),
    ];
  });
}
