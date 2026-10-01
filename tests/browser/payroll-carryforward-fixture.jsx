import { ApprovalLeaveBalances, LeaveRequestBalance } from '@/components/leave-priority-controls';
const person = { personId: 'synthetic', name: 'Synthetic Employee', canViewBalance: true, paidLeave: true,
  hours: 140.4321, annualPayrollHours: 140.4321, annualPayrollDate: '2026-09-24', annualApprovedHours: 45.6,
  annualRetainedHours: 38, annualAvailableHours: 94.8321, annualBalanceSource: 'owner_estimate', canViewSickBalance: false };
export function PayrollCarryforwardFixture() {
  const workspace = { people: [person], requests: [], canManageBalances: false, pendingBalanceCalendarIds: [] };
  return <><ApprovalLeaveBalances workspace={workspace} personId="synthetic" requestId="synthetic-request" />
    <LeaveRequestBalance workspace={workspace} personId="synthetic" requestedHours={7.6} projection={{ status: 'projected', projectedDate: '2026-09-25', throughDate: '2026-09-24', payrollDate: '2026-09-24', payrollHours: 140.4321, approvedHours: 45.6, retainedHours: 38, balanceSource: 'owner_estimate', accruedHours: 0, otherTakenHours: 0, availableHours: 94.8321, terms: [] }} /></>;
}
