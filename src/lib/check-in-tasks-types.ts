export type CheckInTaskCompany = "mam" | "equipsy";

export type CheckInTaskMilestone = "2_week" | "1_month" | "2_month" | "3_month" | "5_month" | "6_month";

export type CheckInTaskStatus = "scheduled" | "claimed" | "delivered" | "needs_review";

/**
 * Minimal manager-safe task projection. This intentionally excludes all HR
 * register fields such as contact details, date of birth, address, manager
 * email, and enrolment controls. The review reason is a safe operational
 * status, not private employee data.
 */
export type CheckInTask = {
  reminderId: string;
  personId: string;
  employeeName: string;
  positionTitle: string;
  company: CheckInTaskCompany;
  dueDate: string;
  milestone: CheckInTaskMilestone;
  status: CheckInTaskStatus;
  /** Why automatic delivery is paused when status is needs_review. */
  needsReviewReason: string | null;
  /** Derived for presentation only; the completion RPC remains authoritative. */
  canComplete: boolean;
};

export type CheckInTasksData = {
  tasks: CheckInTask[];
};
