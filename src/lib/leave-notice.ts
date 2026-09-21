import { melbourneToday } from "@/lib/leave-priority";

export const LEAVE_NOTICE_MESSAGE = "Annual and unpaid leave require at least 14 days’ notice. For leave sooner than this, please speak to your manager, who can log the leave for you.";

export function requiresLeaveNotice(input: {
  employmentType: string | null;
  leaveType: string;
  startDate: string;
  onBehalfOf: boolean;
}, today = melbourneToday()) {
  if (input.onBehalfOf || input.employmentType === "abn"
    || !["Annual leave", "Unpaid leave"].includes(input.leaveType)) return false;
  const earliest = new Date(`${today}T12:00:00Z`);
  earliest.setUTCDate(earliest.getUTCDate() + 14);
  return /^\d{4}-\d{2}-\d{2}$/.test(input.startDate)
    && input.startDate < earliest.toISOString().slice(0, 10);
}
