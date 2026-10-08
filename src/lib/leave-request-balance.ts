import type { LeaveAccrualStatus, LeaveBankSourceKind, LeaveRequestWorkPolicy } from "@/lib/leave-priority";

export const INSUFFICIENT_BALANCE_MESSAGE = "Not enough balance. Your projected annual leave balance at the start of this leave is insufficient. Request fewer paid hours or submit a separate unpaid leave request.";
export const UNAVAILABLE_BALANCE_MESSAGE = "Your annual leave projection is unavailable. Please contact payroll before requesting annual leave.";
export const UNCONFIRMED_ACCRUAL_MESSAGE = "Future accrual could not be confirmed and your banked balance is insufficient. Please contact payroll.";

export type AnnualLeaveProjection = {
  status: "projected" | "banked_only" | "unavailable";
  projectedDate: string;
  fromDate?: string;
  throughDate?: string;
  payrollDate?: string;
  bankReportDate?: string | null;
  coveredServiceThrough?: string | null;
  accrualStatus?: LeaveAccrualStatus;
  sourceKind?: LeaveBankSourceKind | null;
  requestedHours?: number | null;
  quantityPolicy?: (LeaveRequestWorkPolicy & { publicHolidayDates: string[] }) | null;
  payrollHours?: number;
  approvedHours?: number;
  retainedHours?: number;
  balanceSource?: "owner_estimate" | "confirmed_usage" | LeaveBankSourceKind | null;
  accruedHours?: number;
  otherTakenHours?: number;
  availableHours?: number;
  terms?: Array<{ fromDate: string; throughDate: string; weeklyHours: number; weekdays: number[]; annualWeeks: number; eligibleHours: number; accruedHours: number }>;
};

export type LeaveRequestHoursPolicy = LeaveRequestWorkPolicy & {
  publicHolidayDates?: ReadonlySet<string>;
};

function policyRequestDays(start: string, end: string, startTime: string, endTime: string, policy: LeaveRequestHoursPolicy): Array<{ date: number; hours: number }> | null {
  const parseDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const parsed = Date.parse(`${value}T12:00:00Z`);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? parsed : NaN;
  };
  const first = parseDate(start);
  const last = parseDate(end);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first || Boolean(startTime) !== Boolean(endTime)
    || !Number.isFinite(policy.weeklyHours) || policy.weeklyHours <= 0 || policy.weeklyHours > 38
    || policy.weekdays.length < 1 || policy.weekdays.length > 7 || new Set(policy.weekdays).size !== policy.weekdays.length
    || policy.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
    || (policy.calendarKey !== "none" && !policy.publicHolidayDates)) return null;
  const ordinary = policy.weeklyHours / policy.weekdays.length;
  let timedHours: number | null = null;
  if (startTime) {
    if (first !== last || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startTime)
      || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(endTime)) return null;
    const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
    timedHours = (minutes(endTime) - minutes(startTime)) / 60;
    if (timedHours <= 0 || timedHours > 24) return null;
  }
  const result: Array<{ date: number; hours: number }> = [];
  for (let day = first; day <= last; day += 86400000) {
    if (!policy.weekdays.includes(new Date(day).getUTCDay() || 7)) continue;
    const publicHoliday = policy.publicHolidayDates?.has(new Date(day).toISOString().slice(0, 10));
    if (publicHoliday && policy.calendarKey == null) return null;
    if (publicHoliday && policy.calendarKey === "victoria") continue;
    result.push({ date: day, hours: timedHours ?? ordinary });
  }
  return result;
}

function policyLimitGuidance(start: string, end: string, startTime: string, endTime: string, availableHours: number | null | undefined, policy: LeaveRequestHoursPolicy): string | null {
  if (availableHours == null || !Number.isFinite(availableHours)) return null;
  const days = policyRequestDays(start, end, startTime, endTime, policy);
  if (!days?.length) return null;
  const requested = startTime ? days[0].hours : days.length * policy.weeklyHours / policy.weekdays.length;
  if (requested <= availableHours) return null;
  let count = 0;
  let affordableDate: number | null = null;
  for (const day of days) {
    count += 1;
    const total = startTime ? day.hours : count * policy.weeklyHours / policy.weekdays.length;
    if (total <= availableHours) affordableDate = day.date;
    else break;
  }
  if (affordableDate == null) return startTime
    ? "Not enough balance for the selected hours on the first working day. Request fewer paid hours, if available, or submit a separate unpaid leave request."
    : "Not enough balance for one full working day from your selected start date. Request part-day annual leave only if you have enough hours available; submit the remainder as a separate unpaid leave request.";
  const date = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(affordableDate);
  return `Based on the displayed balance, you can apply for annual leave up to ${date} ${startTime ? "with the selected start/end times" : "for full working days"}. For the remaining dates, please send a separate unpaid leave request.${startTime ? "" : " Any hours left over can be requested as part-day annual leave."}`;
}

// Mirrors the existing database duration rules; no projected accrual is used.
export function requestedLeaveHours(start: string, end: string, startTime: string, endTime: string, fullDayHours: number, policy?: LeaveRequestHoursPolicy): number | null {
  if (policy) {
    const days = policyRequestDays(start, end, startTime, endTime, policy);
    const total = days?.length ? startTime ? days[0].hours : days.length * policy.weeklyHours / policy.weekdays.length : null;
    return total != null && total > 0 && Number.isFinite(total) ? total : null;
  }
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
export function annualLeaveLimitGuidance(start: string, end: string, startTime: string, endTime: string, fullDayHours: number, availableHours: number | null | undefined, policy?: LeaveRequestHoursPolicy): string | null {
  if (policy) return policyLimitGuidance(start, end, startTime, endTime, availableHours, policy);
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
