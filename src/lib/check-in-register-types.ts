export type CheckInEnrolmentMode = "automatic" | "needs_review";

export type CheckInReminderStatus =
  | "scheduled"
  | "claimed"
  | "delivered"
  | "completed"
  | "needs_review";

export type CheckInReviewOutcome =
  | "on_track"
  | "follow_up_required"
  | "hr_review_required"
  | "probation_extension_pending_hr"
  | "non_confirmation_pending_hr";

export type CheckInReminder = {
  id: string;
  milestone: "2_week" | "1_month" | "2_month" | "3_month" | "5_month" | "6_month" | "6_month_casual";
  sequence: "initial" | "final";
  dueDate: string;
  notifyDate: string;
  status: CheckInReminderStatus;
  deliveredAt: string | null;
  completedAt: string | null;
  lastDeliveryErrorAt: string | null;
  needsReviewReason: string | null;
  reviewOutcome: CheckInReviewOutcome | null;
  reviewDate: string | null;
  reviewNotes: string;
  reviewVersion: number | null;
  reviewRecordedAt: string | null;
  peopleCultureApproved: boolean;
};

/**
 * This is intentionally an HR-only DTO. It contains the private Employee
 * Check-In Register fields requested by HR and must never be used by an
 * employee, manager, calendar, or outbound-email component.
 */
export type CheckInRegisterRecord = {
  personId: string;
  company: "mam" | "equipsy";
  firstName: string;
  lastName: string;
  role: string;
  department: string;
  managerName: string;
  address: string;
  dateOfBirth: string;
  mobile: string;
  email: string;
  startDate: string;
  recipientEmail: string;
  recipientSource: "manager_work_email" | "missing";
  enrolmentMode: CheckInEnrolmentMode;
  reminders: CheckInReminder[];
};

export type CheckInResourceLinks = {
  managerGuideUrl: string | null;
  checkInFormUrl: string | null;
  probationTemplatesUrl: string | null;
  /** HR navigation only; never included in an automated manager reminder. */
  legacyFormsFolderUrl: string | null;
  deliveryConfigured: boolean;
  canApproveEmploymentDecisions: boolean;
};

export type CheckInRegisterData = {
  records: CheckInRegisterRecord[];
  resources: CheckInResourceLinks;
};

/**
 * Minimal task DTO for an authorised global reviewer or reporting-line leader.
 * It deliberately excludes HR register, contact and reminder-delivery fields.
 */
export type CheckInWorkspaceRecord = {
  personId: string;
  fullName: string;
  positionTitle: string;
  company: "mam" | "equipsy";
  startDate: string;
  reminders: CheckInWorkspaceReminder[];
};

export type CheckInWorkspaceReminder = Pick<
  CheckInReminder,
  | "id"
  | "milestone"
  | "sequence"
  | "dueDate"
  | "status"
  | "reviewOutcome"
  | "reviewDate"
  | "reviewNotes"
  | "reviewVersion"
  | "reviewRecordedAt"
  | "peopleCultureApproved"
>;

export type CheckInWorkspaceData = {
  records: CheckInWorkspaceRecord[];
  resources: Pick<
    CheckInResourceLinks,
    "managerGuideUrl" | "checkInFormUrl" | "probationTemplatesUrl" | "canApproveEmploymentDecisions"
  >;
};
