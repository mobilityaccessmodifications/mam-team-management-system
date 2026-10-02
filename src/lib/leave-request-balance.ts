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
  retainedHours?: number;
  balanceSource?: "owner_estimate" | "confirmed_usage" | null;
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

// A shorter request uses the same duration rules and the same start-date
// projection. Do not accrue again during the requested absence.
export function annualLeaveLimitGuidance(start: string, end: string, startTime: string, endTime: string, fullDayHours: number, availableHours: number | null | undefined): string | null {
  if (availableHours == null || !Number.isFinite(availableHours) || !Number.isFinite(fullDayHours) || fullDayHours <= 0) return null;
  const requested = requestedLeaveHours(start, end, startTime, endTime, fullDayHours);
  if (requested == null || requested <= availableHours) return null;
  const first = Date.parse(`${start}T12:00:00Z`);
  const last = Date.parse(`${end}T12:00:00Z`);
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  let precedingHours = 0;
  let affordableDate: number | null = null;
  for (let day = first; day <= last; day += 86400000) {
    const weekday = new Date(day).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const begins = day === first && startTime ? minutes(startTime) : 360;
    const candidateHours = precedingHours + (startTime ? Math.max(0, (minutes(endTime) - begins) / 60) : fullDayHours);
    if (candidateHours > 0 && Math.round(candidateHours * 100) / 100 <= availableHours) affordableDate = day;
    precedingHours += startTime ? Math.max(0, (1080 - begins) / 60) : fullDayHours;
  }
  if (affordableDate == null) return startTime
    ? "Not enough balance for the selected hours on the first working day. Request fewer paid hours, if available, or submit a separate unpaid leave request."
    : "Not enough balance for one full working day from your selected start date. Request part-day annual leave only if you have enough hours available; submit the remainder as a separate unpaid leave request.";
  const date = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(affordableDate);
  return `Based on the displayed balance, you can apply for annual leave up to ${date} ${startTime ? "with the selected start/end times" : "for full working days"}. For the remaining dates, please send a separate unpaid leave request.${startTime ? "" : " Any hours left over can be requested as part-day annual leave."}`;
}
