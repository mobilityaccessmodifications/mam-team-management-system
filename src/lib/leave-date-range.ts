/** Inclusive calendar-day limit, shared by the form and Server Actions. */
export const MAX_LEAVE_SPAN_DAYS = 366;

function dayNumber(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) return null;
  return timestamp / 86_400_000;
}

export function leaveDateRangeError(start: string, end: string): string | null {
  const first = dayNumber(start);
  const last = dayNumber(end);
  if (first === null) return "Choose a valid start date.";
  if (last === null) return "Choose a valid end date.";
  if (last < first) return "End date must be on or after start date.";
  if (last - first + 1 > MAX_LEAVE_SPAN_DAYS) {
    return `A leave request cannot span more than ${MAX_LEAVE_SPAN_DAYS} days.`;
  }
  return null;
}
