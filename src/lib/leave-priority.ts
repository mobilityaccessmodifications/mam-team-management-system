export const BALANCE_PENDING_STATUS = "Approved – pending leave balance" as const;
export type LeaveDecision = "Approved" | "Declined" | typeof BALANCE_PENDING_STATUS;

export type LeaveBalancePerson = {
  personId: string;
  name: string;
  canSubmit: boolean;
  paidLeave: boolean;
  canViewBalance: boolean;
  hours: number | null;
  asOf: string | null;
  isExample: boolean;
  canViewSickBalance?: boolean;
  sickHours?: number | null;
  sickAsOf?: string | null;
  annualPayrollHours?: number | null;
  annualPayrollDate?: string | null;
  annualApprovedHours?: number | null;
  annualAvailableHours?: number | null;
  sickPayrollHours?: number | null;
  sickPayrollDate?: string | null;
  sickApprovedHours?: number | null;
  sickAvailableHours?: number | null;
  accrualStatus?: "current" | "needs_review" | "not_configured";
  accrualReviewDate?: string | null;
  accrualPolicy?: {
    weeklyHours: number; annualWeeks: number; personalWeeks: number;
    shiftworker: boolean; enabled: boolean; note: string;
  } | null;
};
export type LeavePriorityWorkspace = {
  people: LeaveBalancePerson[];
  payrollImports?: Array<{
    id: string; employeeName: string; company: "mam" | "equipsy";
    annualHours: number | null; sickHours: number | null; asOf: string;
    status: "linked" | "inactive" | "unmatched" | "company_mismatch" | "ambiguous";
    linkedName: string | null; sourceFile: string;
  }>;
  canManageBalances: boolean;
  requests: Array<{ id: string; pendingBalance: boolean; evidenceDueDate: string | null; canAttach: boolean; requiredHours?: number | null; balanceSufficient?: boolean; fullDayHours?: number }>;
  pendingBalanceCalendarIds: string[];
};

/**
 * First working day on or after the Monday following the final sick-leave
 * date. Callers provide the same published holiday dates used by Calendar.
 */
export function sickEvidenceDeadline(
  endDate: string,
  publicHolidayDates?: ReadonlySet<string>,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return "";
  const date = new Date(`${endDate}T12:00:00Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== endDate) return "";
  const isoDay = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 8 - isoDay);

  while (
    date.getUTCDay() === 0
    || date.getUTCDay() === 6
    || publicHolidayDates?.has(date.toISOString().slice(0, 10))
  ) {
    date.setUTCDate(date.getUTCDate() + 1);
  }

  return date.toISOString().slice(0, 10);
}

export function melbourneToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function leaveDateLabel(date: string) {
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

// Full-day display hours are supplied from the database's snapshotted/current
// classification. Staged or older payloads retain the former 7.5-hour fallback.
export function approvalRequestHours(request: { days: number; hours?: number; fullDayHours?: number }): number | null {
  const hours = request.hours ?? request.days * (request.fullDayHours ?? 7.5);
  return Number.isFinite(hours) && hours > 0 ? hours : null;
}

export function approvalBalanceCoverage(person: LeaveBalancePerson | undefined, leaveType: string, requiredHours: number | null) {
  const sick = leaveType === "Sick leave" || leaveType === "Carer's leave";
  if (leaveType !== "Annual leave" && !sick) return null;
  if (!person || !(sick ? person.canViewSickBalance : person.canViewBalance)) return null;
  const availableField = sick ? "sickAvailableHours" : "annualAvailableHours";
  const balance = Object.hasOwn(person, availableField)
    ? person[availableField]
    : sick ? person.sickHours : person.hours;
  if (requiredHours == null || balance == null || !Number.isFinite(balance) || person.accrualStatus === "needs_review") return "Check balance";
  return balance >= requiredHours ? "Enough balance" : "Not enough balance";
}
