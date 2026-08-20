export type CheckInTaskCompany = "mam" | "equipsy";

export type CheckInTaskMilestone = "2_week" | "1_month" | "3_month" | "5_month";

export type CheckInTaskStatus = "scheduled" | "claimed" | "delivered" | "needs_review";

/**
 * Minimal manager-safe task projection. This intentionally excludes all HR
 * register fields such as contact details, date of birth, address, manager
 * email, reminder delivery metadata, and enrolment controls.
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
  /** Derived for presentation only; the completion RPC remains authoritative. */
  canComplete: boolean;
};

export type CheckInTasksData = {
  tasks: CheckInTask[];
};
