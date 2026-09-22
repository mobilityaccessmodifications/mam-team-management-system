export const INSUFFICIENT_BALANCE_MESSAGE = "Not enough balance. Your projected annual leave balance at the start of this leave is insufficient. Request fewer paid hours or submit a separate unpaid leave request.";
export const UNAVAILABLE_BALANCE_MESSAGE = "Your annual leave projection is unavailable. Please contact payroll before requesting annual leave.";
export const UNCONFIRMED_ACCRUAL_MESSAGE = "Future accrual could not be confirmed and your banked balance is insufficient. Please contact payroll.";

export type AnnualLeaveProjection = {
  status: "projected" | "banked_only" | "unavailable";
  projectedDate: string;
  fromDate?: string;
  throughDate?: string;
  payrollDate?: string;
  payrollHours?: number;
  approvedHours?: number;
  accruedHours?: number;
  otherTakenHours?: number;
  availableHours?: number;
  terms?: Array<{ fromDate: string; throughDate: string; weeklyHours: number; weekdays: number[]; annualWeeks: number; eligibleHours: number; accruedHours: number }>;
};

// Mirrors the existing database duration rules; no projected accrual is used.
export function requestedLeaveHours(start: string, end: string, startTime: string, endTime: string, fullDayHours: number): number | null {
  const first = Date.parse(`${start}T12:00:00Z`);
  const last = Date.parse(`${end}T12:00:00Z`);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first || Boolean(startTime) !== Boolean(endTime)) return null;
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  let hours = 0;
  for (let day = first; day <= last; day += 86400000) {
    const weekday = new Date(day).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    hours += startTime
      ? Math.max(0, ((day === last ? minutes(endTime) : 1080) - (day === first ? minutes(startTime) : 360)) / 60)
      : fullDayHours;
  }
  return hours > 0 && Number.isFinite(hours) ? Math.round(hours * 100) / 100 : null;
}
