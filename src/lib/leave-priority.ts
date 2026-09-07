export const BALANCE_PENDING_STATUS = "Approved – pending leave balance" as const;
export type LeaveDecision = "Approved" | "Declined" | typeof BALANCE_PENDING_STATUS;

export type LeaveBalancePerson = {
  personId: string;
  name: string;
  canSubmit: boolean;
  paidLeave: boolean;
  hours: number | null;
  asOf: string | null;
  isExample: boolean;
};
export type LeavePriorityWorkspace = {
  people: LeaveBalancePerson[];
  canManageBalances: boolean;
  requests: Array<{ id: string; pendingBalance: boolean; evidenceDueDate: string | null; canAttach: boolean }>;
  pendingBalanceCalendarIds: string[];
};

/** Monday immediately following the final sick-leave date, in date-only time. */
export function sickEvidenceDeadline(endDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return "";
  const date = new Date(`${endDate}T12:00:00Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== endDate) return "";
  const isoDay = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 8 - isoDay);
  return date.toISOString().slice(0, 10);
}

export function melbourneToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function leaveDateLabel(date: string) {
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}
