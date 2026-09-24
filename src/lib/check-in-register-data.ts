import type {
  CheckInEnrolmentMode,
  CheckInRegisterData,
  CheckInRegisterRecord,
  CheckInReminder,
  CheckInReminderStatus,
} from "@/lib/check-in-register-types";

type CheckInReminderRpcRow = {
  id?: unknown;
  milestone?: unknown;
  sequence?: unknown;
  dueDate?: unknown;
  notifyDate?: unknown;
  status?: unknown;
  deliveredAt?: unknown;
  completedAt?: unknown;
  lastDeliveryErrorAt?: unknown;
  needsReviewReason?: unknown;
  reviewOutcome?: unknown;
  reviewDate?: unknown;
  reviewNotes?: unknown;
  reviewVersion?: unknown;
  reviewRecordedAt?: unknown;
  peopleCultureApproved?: unknown;
};

type CheckInRegisterRpcRow = {
  person_id?: unknown;
  company_key?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  role?: unknown;
  department?: unknown;
  manager_name?: unknown;
  address?: unknown;
  date_of_birth?: unknown;
  mobile?: unknown;
  email?: unknown;
  start_date?: unknown;
  recipient_email?: unknown;
  recipient_source?: unknown;
  enrolment_mode?: unknown;
  reminders?: unknown;
};

export const CHECK_IN_REGISTER_LOAD_ERROR = "Employee check-in records could not be loaded. Refresh and try again.";

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function requiredText(value: unknown) {
  const result = text(value).trim();
  if (!result) throw new Error(CHECK_IN_REGISTER_LOAD_ERROR);
  return result;
}

function company(value: unknown): CheckInRegisterRecord["company"] {
  if (value === "mam" || value === "equipsy") return value;
  throw new Error(CHECK_IN_REGISTER_LOAD_ERROR);
}

function enrolmentMode(value: unknown): CheckInEnrolmentMode {
  if (value === "automatic" || value === "needs_review") return value;
  throw new Error(CHECK_IN_REGISTER_LOAD_ERROR);
}

function reminderStatus(value: unknown): CheckInReminderStatus {
  if (value === "scheduled" || value === "claimed" || value === "delivered" || value === "completed" || value === "needs_review") {
    return value;
  }
  throw new Error(CHECK_IN_REGISTER_LOAD_ERROR);
}

function reviewOutcome(value: unknown): CheckInReminder["reviewOutcome"] {
  if (value === null || value === undefined) return null;
  if (value === "on_track" || value === "follow_up_required" || value === "hr_review_required"
    || value === "probation_extension_pending_hr" || value === "non_confirmation_pending_hr") return value;
  throw new Error(CHECK_IN_REGISTER_LOAD_ERROR);
}

function reviewVersion(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new Error(CHECK_IN_REGISTER_LOAD_ERROR);
}

function reminder(row: CheckInReminderRpcRow): CheckInReminder {
  if (row.milestone !== "2_week" && row.milestone !== "1_month" && row.milestone !== "2_month" && row.milestone !== "3_month" && row.milestone !== "5_month" && row.milestone !== "6_month") {
    throw new Error(CHECK_IN_REGISTER_LOAD_ERROR);
  }
  if (row.sequence !== "initial" && row.sequence !== "final") throw new Error(CHECK_IN_REGISTER_LOAD_ERROR);

  return {
    id: requiredText(row.id),
    milestone: row.milestone,
    sequence: row.sequence,
    dueDate: requiredText(row.dueDate),
    notifyDate: requiredText(row.notifyDate),
    status: reminderStatus(row.status),
    deliveredAt: nullableText(row.deliveredAt),
    completedAt: nullableText(row.completedAt),
    lastDeliveryErrorAt: nullableText(row.lastDeliveryErrorAt),
    needsReviewReason: nullableText(row.needsReviewReason),
    reviewOutcome: reviewOutcome(row.reviewOutcome),
    reviewDate: nullableText(row.reviewDate),
    reviewNotes: text(row.reviewNotes),
    reviewVersion: reviewVersion(row.reviewVersion),
    reviewRecordedAt: nullableText(row.reviewRecordedAt),
    peopleCultureApproved: row.peopleCultureApproved === true,
  };
}

function toRecord(row: CheckInRegisterRpcRow): CheckInRegisterRecord {
  if (row.recipient_source !== "manager_work_email" && row.recipient_source !== "missing") {
    throw new Error(CHECK_IN_REGISTER_LOAD_ERROR);
  }
  if (!Array.isArray(row.reminders)) throw new Error(CHECK_IN_REGISTER_LOAD_ERROR);

  return {
    personId: requiredText(row.person_id),
    company: company(row.company_key),
    firstName: text(row.first_name),
    lastName: text(row.last_name),
    role: text(row.role),
    department: text(row.department),
    managerName: text(row.manager_name),
    address: text(row.address),
    dateOfBirth: text(row.date_of_birth),
    mobile: text(row.mobile),
    email: text(row.email),
    startDate: text(row.start_date),
    recipientEmail: text(row.recipient_email),
    recipientSource: row.recipient_source,
    enrolmentMode: enrolmentMode(row.enrolment_mode),
    reminders: row.reminders.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(CHECK_IN_REGISTER_LOAD_ERROR);
      return reminder(value as CheckInReminderRpcRow);
    }),
  };
}

/** Validates the HR-only register response in browser or server code. */
export function parseCheckInRegisterRecords(data: unknown): CheckInRegisterData["records"] {
  if (!Array.isArray(data)) throw new Error(CHECK_IN_REGISTER_LOAD_ERROR);
  return (data as CheckInRegisterRpcRow[])
    .map(toRecord)
    .sort((first, second) => `${first.lastName} ${first.firstName}`.localeCompare(`${second.lastName} ${second.firstName}`));
}
