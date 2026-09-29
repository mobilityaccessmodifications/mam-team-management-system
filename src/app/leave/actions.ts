"use server";

import { LEAVE_NOTICE_MESSAGE } from "@/lib/leave-notice";
import { leaveDateRangeError, MAX_LEAVE_SPAN_DAYS } from "@/lib/leave-date-range";
import { INSUFFICIENT_BALANCE_MESSAGE, UNAVAILABLE_BALANCE_MESSAGE, UNCONFIRMED_ACCRUAL_MESSAGE, type AnnualLeaveProjection } from "@/lib/leave-request-balance";
import { dispatchLeaveNotificationsForRequest } from "@/lib/leave-notification-outbox";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { BALANCE_PENDING_STATUS, type LeaveDecision, type LeavePriorityWorkspace } from "@/lib/leave-priority";

// Email delivery must not hold the Server Action open (up to 15 s per
// audience). Drain after the response; the outbox cron remains the durable
// fallback, so a scheduling failure never asks the user to submit again.
function scheduleLeaveNotifications(requestId: string) {
  try {
    after(() => dispatchLeaveNotificationsForRequest(requestId));
  } catch {
    console.warn("Leave notification remains queued.");
  }
}

export type LeaveStatus = "Pending" | "Approved" | "Declined" | "Cancelled" | typeof BALANCE_PENDING_STATUS;

export type LeaveWorkspaceRequest = {
  id: string;
  /** Stable employee directory identifier. Missing legacy links fail closed in employee previews. */
  personId?: string;
  employee: string;
  company: "mam" | "equipsy";
  leaveType: string;
  startDate: string;
  endDate: string;
  startTime?: string;
  endTime?: string;
  days: number;
  hours?: number;
  /** Full-day hours derived from the employee classification at submission. */
  fullDayHours?: number;
  approvalRequired: boolean;
  status: LeaveStatus;
  submittedAt: string;
  assignedReviewerLabel?: string;
  canDecide: boolean;
  /**
   * Derived by the leave RPC for the current session only. It never relies on
   * a browser-selected employee, display name, or local date calculation.
   */
  canCancel: boolean;
  /** True only for the current owner while a submitted/approved request accepts evidence. */
  canAttach: boolean;
  employeeNote?: string;
  managerNote?: string;
  evidenceDueDate?: string;
};

export type LeaveAttachment = {
  id: string;
  leaveRequestId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  /** Database-derived ownership capability for the authenticated uploader. */
  canDelete: boolean;
};

export type LeaveCalendarEntry = Omit<
  Pick<
    LeaveWorkspaceRequest,
    | "id"
    | "personId"
    | "employee"
    | "company"
    | "leaveType"
    | "startDate"
    | "endDate"
    | "startTime"
    | "endTime"
    | "days"
    | "hours"
    | "status"
  >,
  "personId"
> & {
  personId: string;
  teamName: string;
  requestedAt?: string;
  approvedBy?: string;
  documentCount?: number;
};

/**
 * A deliberately minimal, role-scoped birthday projection. It contains
 * neither a date of birth nor any private contact information: the calendar
 * receives only the authorised employee names and recurring month/day.
 */
export type BirthdayCalendarEntry = {
  employee: string;
  month: number;
  day: number;
};

export type CheckInCalendarEntry = {
  reminderId: string;
  personId: string;
  employee: string;
  milestone: "2_week" | "1_month" | "2_month" | "3_month" | "5_month" | "6_month" | "6_month_casual";
  sequence: "initial" | "final";
  dueDate: string;
  status: "scheduled" | "claimed" | "delivered" | "completed" | "needs_review";
};

/**
 * A minimal, owner-scoped subscription review reminder. The calendar never
 * receives pricing, plan, access membership or credential information.
 */
export type SubscriptionReviewCalendarEntry = {
  subscriptionId: string;
  serviceName: string;
  dueDate: string;
  status: "active" | "paused";
};

/** Minimal monthly reminder for authorised payroll-balance importers. */
export type PayrollBalanceReminderCalendarEntry = {
  reminderId: string;
  dueDate: string;
  status: "due";
};

export type LeaveWorkspaceData = {
  priority?: LeavePriorityWorkspace;
  requests: LeaveWorkspaceRequest[];
  attachments: LeaveAttachment[];
  calendarEntries: LeaveCalendarEntry[];
  birthdayEntries: BirthdayCalendarEntry[];
  checkInEntries: CheckInCalendarEntry[];
  subscriptionReviewEntries: SubscriptionReviewCalendarEntry[];
  payrollBalanceReminderEntries: PayrollBalanceReminderCalendarEntry[];
  /** Current active profile may open the calendar for its own review dates. */
  canViewSubscriptionReviewCalendar: boolean;
  /** Current authenticated user may open the monthly payroll reminder. */
  canViewPayrollBalanceReminderCalendar: boolean;
  /** Current authenticated user is System Admin or an explicit payroll-import delegate. */
  canImportPayrollBalances: boolean;
  /**
   * A capability asserted by the database for the authenticated session.
   * This intentionally remains separate from per-request `canDecide`, so an
   * authorised reviewer still receives an empty Approvals workspace when no
   * request is pending.
   */
  canReviewLeave: boolean;
  canViewAllLeave: boolean;
  /** Employment classification is authoritative; ABN/Casual receive Unpaid leave only. */
  employmentType: "abn" | "casual" | "full_time" | "part_time" | null;
  hasPaidLeaveEntitlement: boolean;
  availableLeaveTypes: Array<{
    value: "Annual leave" | "Sick leave" | "Carer's leave" | "Unpaid leave";
    label: string;
  }>;
  /** True when Super Admin has requested a server-scoped Change Profile view. */
  isProfilePreview: boolean;
  /** Non-blocking notice when an optional calendar projection is unavailable. */
  warning?: string;
};

export type SubmitLeaveInput = {
  submissionKey: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  startTime?: string;
  endTime?: string;
  employeeNote?: string;
};

export type DecideLeaveInput = {
  requestId: string;
  status: LeaveDecision;
  managerNote?: string;
};

export type CancelLeaveInput = {
  requestId: string;
};

export type CancelLeaveResult =
  | { ok: true; id: string; status: "Cancelled" }
  | { ok: false; message: string };

export type PrepareLeaveAttachmentInput = {
  requestId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

export type CompleteLeaveAttachmentInput = {
  storagePath: string;
};

export type DeleteLeaveAttachmentInput = {
  attachmentId: string;
};

export type LeaveAttachmentUploadPlan = {
  storagePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

type WorkspaceRpcRow = {
  id: string;
  person_id?: string | null;
  employee_name: string;
  company_key: string;
  leave_type_label: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  business_days: number | string;
  hours: number | string | null;
  approval_required: boolean;
  status: string;
  submitted_at: string | null;
  assigned_reviewer_label: string | null;
  can_decide: boolean;
  can_cancel: boolean;
  can_attach?: boolean;
  employee_note: string | null;
  manager_note: string | null;
};

type CalendarRpcRow = Omit<
  WorkspaceRpcRow,
  "person_id" | "approval_required" | "submitted_at" | "assigned_reviewer_label" | "can_decide" | "can_cancel" | "can_attach" | "employee_note" | "manager_note"
> & {
  person_id: string;
  team_name: string;
  requested_at?: unknown;
  approved_by?: unknown;
  document_count?: unknown;
};

type AttachmentRpcRow = {
  id: string;
  leave_request_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number | string;
  created_at: string;
  can_delete?: boolean;
};

type AttachmentUploadPlanRpcRow = {
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number | string;
};

type BirthdayCalendarRpcRow = {
  employee_name: string;
  birthday_month: number | string;
  birthday_day: number | string;
};

type CheckInCalendarRpcRow = {
  reminder_id: unknown;
  person_id: unknown;
  employee_name: unknown;
  milestone: unknown;
  sequence: unknown;
  due_date: unknown;
  status: unknown;
};

type SubscriptionReviewCalendarRpcRow = {
  subscription_id: unknown;
  service_name: unknown;
  due_date: unknown;
  status: unknown;
};

type PayrollBalanceReminderCalendarRpcRow = {
  reminder_id: unknown;
  due_date: unknown;
  status: unknown;
};

type SubmitRpcRow = {
  id: string;
  status: string;
  approval_required: boolean;
  assigned_reviewer_label: string | null;
};

type LeaveEntitlementPolicyRpcRow = {
  person_id: string;
  employment_type: string | null;
  has_paid_leave_entitlement: boolean;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:(?:0[6-9]|1[0-7]):(?:00|15|30|45)|18:00)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTACHMENT_STORAGE_PATH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:pdf|heic|heif|jpg|png|webp)$/i;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const LEAVE_TYPES = new Set([
  "Annual leave",
  "Sick leave",
  "Carer's leave",
  "Unpaid leave",
]);
const PAID_ENTITLEMENT_LEAVE_TYPES: LeaveWorkspaceData["availableLeaveTypes"] = [
  { value: "Annual leave", label: "Annual leave" },
  { value: "Sick leave", label: "Sick leave" },
  { value: "Carer's leave", label: "Carer's leave" },
  { value: "Unpaid leave", label: "Unpaid leave" },
];
const UNPAID_ONLY_LEAVE_TYPES: LeaveWorkspaceData["availableLeaveTypes"] = [
  { value: "Unpaid leave", label: "Unpaid leave" },
];
const ATTACHMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const LOAD_ERROR = "Leave records could not be loaded. Refresh and try again.";
const SAVE_ERROR = "The leave request could not be saved. Refresh and try again.";
const DECISION_ERROR = "The leave decision could not be saved. Refresh and try again.";
const SELECTED_PROFILE_SUBMIT_ERROR = "The selected employee leave request could not be saved. Refresh and try again.";
const CANCEL_ERROR = "The leave request could not be cancelled. Refresh and try again.";
const ATTACHMENT_ERROR = "The supporting file could not be attached. Refresh and try again.";
const ATTACHMENT_DELETE_ERROR = "The supporting file could not be deleted. Refresh and try again.";

function requireText(value: unknown, errorMessage: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(errorMessage);
  return value.trim();
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalUuid(value: unknown, errorMessage: string) {
  if (value === null || value === undefined || value === "") return undefined;
  const id = requireText(value, errorMessage);
  if (!UUID_PATTERN.test(id)) throw new Error(errorMessage);
  return id;
}

function requiredUuid(value: unknown, errorMessage: string) {
  const id = requireText(value, errorMessage);
  if (!UUID_PATTERN.test(id)) throw new Error(errorMessage);
  return id;
}

function requiredDate(value: unknown, errorMessage: string) {
  const date = requireText(value, errorMessage);
  if (!DATE_PATTERN.test(date)) throw new Error(errorMessage);
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new Error(errorMessage);
  }
  return date;
}

function optionalTime(value: unknown, errorMessage: string) {
  const time = optionalText(value);
  if (!time) return undefined;
  if (!TIME_PATTERN.test(time)) throw new Error(errorMessage);
  return time;
}

function positiveNumber(value: unknown, errorMessage: string) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(errorMessage);
  return parsed;
}

function optionalPositiveNumber(value: unknown, errorMessage: string) {
  if (value === null || value === undefined) return undefined;
  return positiveNumber(value, errorMessage);
}

function birthdayMonthDay(monthValue: unknown, dayValue: unknown, errorMessage: string) {
  const month = typeof monthValue === "number" ? monthValue : Number(monthValue);
  const day = typeof dayValue === "number" ? dayValue : Number(dayValue);
  if (!Number.isSafeInteger(month) || !Number.isSafeInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(errorMessage);
  }

  // Use a leap year so 29 February remains a valid recurring birthday. The
  // client maps it to 28 February in non-leap calendar years.
  const parsed = new Date(Date.UTC(2000, month - 1, day));
  if (parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error(errorMessage);
  }

  return { month, day };
}

function company(value: unknown, errorMessage: string): "mam" | "equipsy" {
  if (value === "mam" || value === "equipsy") return value;
  throw new Error(errorMessage);
}

function status(value: unknown, errorMessage: string): LeaveStatus {
  if (value === "Pending" || value === "Approved" || value === "Declined" || value === "Cancelled" || value === BALANCE_PENDING_STATUS) return value;
  throw new Error(errorMessage);
}

function optionalDbTime(value: unknown, errorMessage: string) {
  if (value === null || value === undefined) return undefined;
  const time = requireText(value, errorMessage).slice(0, 5);
  return optionalTime(time, errorMessage);
}

function toWorkspaceRequest(value: unknown): LeaveWorkspaceRequest {
  const row = value as WorkspaceRpcRow;
  const id = requireText(row?.id, LOAD_ERROR);
  if (!UUID_PATTERN.test(id)) throw new Error(LOAD_ERROR);

  return {
    id,
    personId: optionalUuid(row.person_id, LOAD_ERROR),
    employee: requireText(row.employee_name, LOAD_ERROR),
    company: company(row.company_key, LOAD_ERROR),
    leaveType: requireText(row.leave_type_label, LOAD_ERROR),
    startDate: requiredDate(row.start_date, LOAD_ERROR),
    endDate: requiredDate(row.end_date, LOAD_ERROR),
    startTime: optionalDbTime(row.start_time, LOAD_ERROR),
    endTime: optionalDbTime(row.end_time, LOAD_ERROR),
    days: positiveNumber(row.business_days, LOAD_ERROR),
    hours: optionalPositiveNumber(row.hours, LOAD_ERROR),
    approvalRequired: row.approval_required === true,
    status: status(row.status, LOAD_ERROR),
    submittedAt: optionalText(row.submitted_at) ?? "",
    assignedReviewerLabel: optionalText(row.assigned_reviewer_label),
    canDecide: row.can_decide === true,
    canCancel: row.can_cancel === true,
    canAttach: row.can_attach === true,
    employeeNote: optionalText(row.employee_note),
    managerNote: optionalText(row.manager_note),
  };
}

function attachmentMimeType(value: unknown, errorMessage: string) {
  const mimeType = requireText(value, errorMessage).toLowerCase();
  if (!ATTACHMENT_MIME_TYPES.has(mimeType)) throw new Error(errorMessage);
  return mimeType;
}

function attachmentFileName(value: unknown, errorMessage: string) {
  const fileName = requireText(value, errorMessage);
  if (fileName.length > 255 || /[\\/\u0000-\u001f]/u.test(fileName)) throw new Error(errorMessage);
  return fileName;
}

function attachmentSize(value: unknown, errorMessage: string) {
  const size = positiveNumber(value, errorMessage);
  if (!Number.isSafeInteger(size) || size > MAX_ATTACHMENT_BYTES) throw new Error(errorMessage);
  return size;
}

function toLeaveAttachment(value: unknown, errorMessage = LOAD_ERROR): LeaveAttachment {
  const row = value as AttachmentRpcRow;
  const id = requireText(row?.id, errorMessage);
  const leaveRequestId = requireText(row?.leave_request_id, errorMessage);
  if (!UUID_PATTERN.test(id) || !UUID_PATTERN.test(leaveRequestId)) throw new Error(errorMessage);
  return {
    id,
    leaveRequestId,
    fileName: attachmentFileName(row.file_name, errorMessage),
    mimeType: attachmentMimeType(row.mime_type, errorMessage),
    sizeBytes: attachmentSize(row.size_bytes, errorMessage),
    createdAt: requireText(row.created_at, errorMessage),
    canDelete: row.can_delete === true,
  };
}

function toCalendarEntry(value: unknown): LeaveCalendarEntry {
  const row = value as CalendarRpcRow;
  const id = requireText(row?.id, LOAD_ERROR);
  if (!UUID_PATTERN.test(id)) throw new Error(LOAD_ERROR);

  let details: Pick<LeaveCalendarEntry, "requestedAt" | "approvedBy" | "documentCount"> = {};
  if (row.requested_at !== undefined || row.document_count !== undefined) {
    const requestedAt = requireText(row.requested_at, LOAD_ERROR);
    const documentCount = Number(row.document_count);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(requestedAt) || !Number.isFinite(Date.parse(requestedAt))
      || !Number.isSafeInteger(documentCount) || documentCount < 0 || documentCount > 10) throw new Error(LOAD_ERROR);
    details = { requestedAt, approvedBy: optionalText(row.approved_by), documentCount };
  }

  return {
    id,
    personId: requiredUuid(row.person_id, LOAD_ERROR),
    teamName: requireText(row.team_name, LOAD_ERROR),
    employee: requireText(row.employee_name, LOAD_ERROR),
    company: company(row.company_key, LOAD_ERROR),
    leaveType: requireText(row.leave_type_label, LOAD_ERROR),
    startDate: requiredDate(row.start_date, LOAD_ERROR),
    endDate: requiredDate(row.end_date, LOAD_ERROR),
    startTime: optionalDbTime(row.start_time, LOAD_ERROR),
    endTime: optionalDbTime(row.end_time, LOAD_ERROR),
    days: positiveNumber(row.business_days, LOAD_ERROR),
    hours: optionalPositiveNumber(row.hours, LOAD_ERROR),
    status: status(row.status, LOAD_ERROR),
    ...details,
  };
}

function toBirthdayCalendarEntry(value: unknown): BirthdayCalendarEntry {
  const row = value as BirthdayCalendarRpcRow;
  const monthDay = birthdayMonthDay(row?.birthday_month, row?.birthday_day, LOAD_ERROR);
  return {
    employee: requireText(row?.employee_name, LOAD_ERROR),
    ...monthDay,
  };
}

function toCheckInCalendarEntry(value: unknown): CheckInCalendarEntry {
  const row = value as CheckInCalendarRpcRow;
  const reminderId = requireText(row?.reminder_id, LOAD_ERROR);
  const personId = requireText(row?.person_id, LOAD_ERROR);
  if (!UUID_PATTERN.test(reminderId) || !UUID_PATTERN.test(personId)) throw new Error(LOAD_ERROR);
  if (!["2_week", "1_month", "2_month", "3_month", "5_month", "6_month", "6_month_casual"].includes(String(row.milestone))) throw new Error(LOAD_ERROR);
  if (row.sequence !== "initial" && row.sequence !== "final") throw new Error(LOAD_ERROR);
  if (!["scheduled", "claimed", "delivered", "completed", "needs_review"].includes(String(row.status))) throw new Error(LOAD_ERROR);

  return {
    reminderId,
    personId,
    employee: requireText(row.employee_name, LOAD_ERROR),
    milestone: row.milestone as CheckInCalendarEntry["milestone"],
    sequence: row.sequence,
    dueDate: requiredDate(row.due_date, LOAD_ERROR),
    status: row.status as CheckInCalendarEntry["status"],
  };
}

function toSubscriptionReviewCalendarEntry(value: unknown): SubscriptionReviewCalendarEntry {
  const row = value as SubscriptionReviewCalendarRpcRow;
  const subscriptionId = requireText(row?.subscription_id, LOAD_ERROR);
  if (!UUID_PATTERN.test(subscriptionId)) throw new Error(LOAD_ERROR);
  if (row.status !== "active" && row.status !== "paused") throw new Error(LOAD_ERROR);

  return {
    subscriptionId,
    serviceName: requireText(row.service_name, LOAD_ERROR),
    dueDate: requiredDate(row.due_date, LOAD_ERROR),
    status: row.status,
  };
}

function toPayrollBalanceReminderCalendarEntry(value: unknown): PayrollBalanceReminderCalendarEntry {
  const row = value as PayrollBalanceReminderCalendarRpcRow;
  const reminderId = requireText(row?.reminder_id, LOAD_ERROR);
  if (!/^payroll-balance:\d{4}-\d{2}-\d{2}$/.test(reminderId) || row.status !== "due") {
    throw new Error(LOAD_ERROR);
  }
  return {
    reminderId,
    dueDate: requiredDate(row.due_date, LOAD_ERROR),
    status: "due",
  };
}

async function requireLeaveSession() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error("Your session has expired. Sign in again.");
  return supabase;
}

function selectedPersonId(value: unknown) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(SELECTED_PROFILE_SUBMIT_ERROR);
  }
  return value;
}

function normaliseLeaveInput(input: SubmitLeaveInput) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(SAVE_ERROR);

  const submissionKey = requireText(input.submissionKey, SAVE_ERROR);
  if (!UUID_PATTERN.test(submissionKey)) throw new Error(SAVE_ERROR);
  const leaveType = requireText(input.leaveType, "Choose a valid leave type.");
  if (!LEAVE_TYPES.has(leaveType)) throw new Error("Choose a valid leave type.");
  const startDate = requiredDate(input.startDate, "Choose a valid start date.");
  const endDate = requiredDate(input.endDate, "Choose a valid end date.");
  const rangeError = leaveDateRangeError(startDate, endDate);
  if (rangeError) throw new Error(rangeError);

  const startTime = optionalTime(input.startTime, "Choose start and end times in 15-minute intervals.");
  const endTime = optionalTime(input.endTime, "Choose start and end times in 15-minute intervals.");
  if (Boolean(startTime) !== Boolean(endTime)) {
    throw new Error("Choose both a start time and an end time, or leave both blank for full-day leave.");
  }
  if (startDate === endDate && startTime && endTime && endTime <= startTime) {
    throw new Error("End time must be later than start time.");
  }

  const employeeNote = optionalText(input.employeeNote);
  if (employeeNote && employeeNote.length > 2000) throw new Error("Leave note must be 2,000 characters or fewer.");

  return { submissionKey, leaveType, startDate, endDate, startTime, endTime, employeeNote };
}

function normaliseDecisionInput(input: DecideLeaveInput) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(DECISION_ERROR);
  const requestId = requireText(input.requestId, DECISION_ERROR);
  if (!UUID_PATTERN.test(requestId)) throw new Error(DECISION_ERROR);
  if (input.status !== "Approved" && input.status !== "Declined" && input.status !== BALANCE_PENDING_STATUS) throw new Error(DECISION_ERROR);
  const managerNote = optionalText(input.managerNote);
  if (input.status === "Declined" && !managerNote) throw new Error("Add a decision note before declining this request.");
  if (managerNote && managerNote.length > 2000) throw new Error("Decision note must be 2,000 characters or fewer.");
  return { requestId, status: input.status, managerNote };
}

function normaliseCancelInput(input: CancelLeaveInput) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(CANCEL_ERROR);
  }
  const requestId = requireText(input.requestId, CANCEL_ERROR);
  if (!UUID_PATTERN.test(requestId)) throw new Error(CANCEL_ERROR);
  return { requestId };
}

function normalisePrepareAttachmentInput(input: PrepareLeaveAttachmentInput) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(ATTACHMENT_ERROR);
  const requestId = requireText(input.requestId, ATTACHMENT_ERROR);
  if (!UUID_PATTERN.test(requestId)) throw new Error(ATTACHMENT_ERROR);
  return {
    requestId,
    fileName: attachmentFileName(input.fileName, "Choose a PDF or supported image up to 5 MB."),
    mimeType: attachmentMimeType(input.mimeType, "Choose a PDF or supported image up to 5 MB."),
    sizeBytes: attachmentSize(input.sizeBytes, "Choose a PDF or supported image up to 5 MB."),
  };
}

function normaliseCompleteAttachmentInput(input: CompleteLeaveAttachmentInput) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(ATTACHMENT_ERROR);
  const storagePath = requireText(input.storagePath, ATTACHMENT_ERROR);
  if (!ATTACHMENT_STORAGE_PATH_PATTERN.test(storagePath)) throw new Error(ATTACHMENT_ERROR);
  return { storagePath };
}

function normaliseDeleteAttachmentInput(input: DeleteLeaveAttachmentInput) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(ATTACHMENT_DELETE_ERROR);
  const attachmentId = requireText(input.attachmentId, ATTACHMENT_DELETE_ERROR);
  if (!UUID_PATTERN.test(attachmentId)) throw new Error(ATTACHMENT_DELETE_ERROR);
  return { attachmentId };
}

function toSubmitResult(value: unknown) {
  const rows = Array.isArray(value) ? value : [];
  const row = rows[0] as SubmitRpcRow | undefined;
  const id = requireText(row?.id, SAVE_ERROR);
  if (!UUID_PATTERN.test(id)) throw new Error(SAVE_ERROR);
  if (!row) throw new Error(SAVE_ERROR);
  return {
    id,
    status: status(row.status, SAVE_ERROR),
    approvalRequired: row.approval_required === true,
    assignedReviewerLabel: optionalText(row.assigned_reviewer_label),
  };
}

function toDecisionResult(value: unknown) {
  return toRequestStatusResult(value, DECISION_ERROR);
}

function toCancellationResult(value: unknown) {
  return toRequestStatusResult(value, CANCEL_ERROR);
}

function toAttachmentUploadPlan(value: unknown) {
  const rows = Array.isArray(value) ? value : [];
  const row = rows[0] as AttachmentUploadPlanRpcRow | undefined;
  const storagePath = requireText(row?.storage_path, ATTACHMENT_ERROR);
  if (!row || !ATTACHMENT_STORAGE_PATH_PATTERN.test(storagePath)) throw new Error(ATTACHMENT_ERROR);
  return {
    storagePath,
    fileName: attachmentFileName(row.file_name, ATTACHMENT_ERROR),
    mimeType: attachmentMimeType(row.mime_type, ATTACHMENT_ERROR),
    sizeBytes: attachmentSize(row.size_bytes, ATTACHMENT_ERROR),
  } satisfies LeaveAttachmentUploadPlan;
}

function toRequestStatusResult(value: unknown, errorMessage: string) {
  const rows = Array.isArray(value) ? value : [];
  const row = rows[0] as { id?: unknown; status?: unknown } | undefined;
  const id = requireText(row?.id, errorMessage);
  if (!UUID_PATTERN.test(id)) throw new Error(errorMessage);
  if (!row) throw new Error(errorMessage);
  return { id, status: status(row.status, errorMessage) };
}

function userFacingSubmitError(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error && "message" in error && typeof error.message === "string"
      ? error.message
      : "";
  if (
    message === LEAVE_NOTICE_MESSAGE
    || message === INSUFFICIENT_BALANCE_MESSAGE
    || message === UNAVAILABLE_BALANCE_MESSAGE
    || message === UNCONFIRMED_ACCRUAL_MESSAGE
    || message === "Choose a valid leave type."
    || message === "End date must be on or after start date."
    || message === `A leave request cannot span more than ${MAX_LEAVE_SPAN_DAYS} days.`
    || message === "Choose at least one weekday for this request."
    || message === "Timed leave must start and end on weekdays."
    || message === "Times must use 15-minute intervals within 06:00 to 18:00."
    || message === "This employment type only allows Unpaid leave."
    || message === "Ask a System Admin to set your employment type before requesting this leave."
  ) {
    return message;
  }
  return SAVE_ERROR;
}

function leaveEntitlementPolicy(
  value: unknown,
  error: unknown,
): Pick<LeaveWorkspaceData, "employmentType" | "hasPaidLeaveEntitlement" | "availableLeaveTypes"> {
  if (error || !Array.isArray(value)) throw new Error(LOAD_ERROR);
  if (!value.length) {
    return {
      employmentType: null,
      hasPaidLeaveEntitlement: false,
      availableLeaveTypes: [],
    };
  }

  const row = value[0] as LeaveEntitlementPolicyRpcRow;
  const personId = requireText(row?.person_id, LOAD_ERROR);
  if (!UUID_PATTERN.test(personId)) throw new Error(LOAD_ERROR);
  const employmentType = row.employment_type;
  if (
    employmentType !== null
    && employmentType !== "abn"
    && employmentType !== "casual"
    && employmentType !== "full_time"
    && employmentType !== "part_time"
  ) throw new Error(LOAD_ERROR);

  const hasPaidLeaveEntitlement = employmentType === "full_time" || employmentType === "part_time";
  if (row.has_paid_leave_entitlement !== hasPaidLeaveEntitlement) throw new Error(LOAD_ERROR);
  return {
    employmentType,
    hasPaidLeaveEntitlement,
    // An unclassified active employee also fails closed to Unpaid leave until
    // a System Admin records their authoritative employment type.
    availableLeaveTypes: hasPaidLeaveEntitlement
      ? PAID_ENTITLEMENT_LEAVE_TYPES
      : UNPAID_ONLY_LEAVE_TYPES,
  };
}

function userFacingDecisionError(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error && "message" in error && typeof error.message === "string"
      ? error.message
      : "";
  if (
    message === "A manager note is required when declining this request."
    || message === "A reviewer note is required when declining this request."
  ) return "Add a decision note before declining this request.";
  return DECISION_ERROR;
}

function userFacingAttachmentError(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error && "message" in error && typeof error.message === "string"
      ? error.message
      : "";
  if (
    message === "Choose a PDF or supported image up to 5 MB."
    || message === "A leave request can have up to 10 supporting files."
    || message === "The supporting file upload was not found. Please try again."
    || message === "Supporting-file uploads are temporarily limited. Please try again later or contact HR."
  ) return message;
  return ATTACHMENT_ERROR;
}

function parseOptionalProjection<T>(
  data: unknown,
  error: unknown,
  parseRow: (row: unknown) => T,
) {
  if (error || !Array.isArray(data)) return { available: false, rows: [] as T[] };
  try {
    return { available: true, rows: data.map(parseRow) };
  } catch {
    // Optional projections are deliberately isolated from the core leave
    // register. One malformed birthday, calendar, check-in or attachment row
    // must not erase otherwise valid leave requests from the workspace.
    return { available: false, rows: [] as T[] };
  }
}

/**
 * Builds the Leave workspace for System Admin's Change Profile mode from one
 * authoritative database projection. PostgreSQL applies the selected user's
 * live reviewer assignments, private-note visibility and date rules; the
 * application only validates and maps the returned DTO.
 */
async function getSelectedEmployeeLeaveWorkspacePreview(
  supabase: Awaited<ReturnType<typeof createClient>>,
  personId: string,
) {
  const { data, error } = await supabase.rpc("get_leave_workspace_for_preview", {
    p_person_id: personId,
  });
  if (error || !data || typeof data !== "object" || Array.isArray(data)) throw new Error(LOAD_ERROR);

  const payload = data as {
    requests?: unknown;
    attachments?: unknown;
    can_review_leave?: unknown;
    is_truncated?: unknown;
  };
  if (
    !Array.isArray(payload.requests)
    || !Array.isArray(payload.attachments)
    || typeof payload.can_review_leave !== "boolean"
    || typeof payload.is_truncated !== "boolean"
  ) throw new Error(LOAD_ERROR);

  let requests: LeaveWorkspaceRequest[];
  let attachments: LeaveAttachment[];
  try {
    requests = payload.requests.map(toWorkspaceRequest);
    attachments = payload.attachments.map((attachment) => toLeaveAttachment(attachment));
  } catch {
    throw new Error(LOAD_ERROR);
  }

  return {
    requests,
    attachments,
    calendarEntries: requests
      .filter((request) => request.status === "Pending" || request.status === "Approved")
      .map((request) => ({
        id: request.id,
        personId: request.personId,
        employee: request.employee,
        company: request.company,
        leaveType: request.leaveType,
        startDate: request.startDate,
        endDate: request.endDate,
        startTime: request.startTime,
        endTime: request.endTime,
        days: request.days,
        hours: request.hours,
        status: request.status,
      })),
    canReviewLeave: payload.can_review_leave,
    canViewAllLeave: false,
    warning: payload.is_truncated
      ? "Leave history is limited to the 1,000 most recent visible requests."
      : undefined,
  };
}

async function getBaseLeaveWorkspaceData(previewPersonId?: string): Promise<LeaveWorkspaceData> {
  const supabase = await requireLeaveSession();
  const checkedPreviewPersonId = previewPersonId ? selectedPersonId(previewPersonId) : null;

  if (checkedPreviewPersonId) {
    const { data: canChangeProfile, error: previewPermissionError } = await supabase.rpc("can_change_employee_view");
    if (previewPermissionError || canChangeProfile !== true) {
      throw new Error(SELECTED_PROFILE_SUBMIT_ERROR);
    }
  }

  if (checkedPreviewPersonId) {
    // The preview workspace is an authoritative database projection. Keep the
    // selected-profile data on this RPC path, then load only the separately
    // authorised calendar projections needed by the UI.
    const preview = await getSelectedEmployeeLeaveWorkspacePreview(supabase, checkedPreviewPersonId);
    const [
      { data: calendarData, error: calendarError },
      { data: staffCalendarData, error: staffCalendarError },
      { data: birthdayData, error: birthdayError },
      { data: checkInData, error: checkInError },
      { data: subscriptionReviewData, error: subscriptionReviewError },
      { data: canViewSubscriptionReviewCalendar, error: subscriptionReviewCalendarPermissionError },
      { data: canImportPayrollBalances, error: payrollBalanceImportPermissionError },
      { data: entitlementPolicyData, error: entitlementPolicyError },
    ] = await Promise.all([
      supabase.rpc("list_leave_calendar_entries_with_teams_for_preview", { p_person_id: checkedPreviewPersonId }),
      supabase.rpc("list_staff_leave_calendar_entries_for_preview", { p_person_id: checkedPreviewPersonId }),
      supabase.rpc("list_calendar_birthdays_for_preview", { p_person_id: checkedPreviewPersonId }),
      supabase.rpc("list_employee_check_in_calendar_entries_for_preview", { p_person_id: checkedPreviewPersonId }),
      supabase.rpc("list_subscription_review_calendar_entries_for_preview", { p_person_id: checkedPreviewPersonId }),
      supabase.rpc("can_view_subscription_review_calendar_for_preview", { p_person_id: checkedPreviewPersonId }),
      supabase.rpc("can_import_payroll_balances_for_preview", { p_person_id: checkedPreviewPersonId }),
      supabase.rpc("get_selected_employee_leave_entitlement_policy", { p_person_id: checkedPreviewPersonId }),
    ]);
    const calendar = parseOptionalProjection(calendarData, calendarError, toCalendarEntry);
    const staffCalendar = parseOptionalProjection(staffCalendarData, staffCalendarError, toCalendarEntry);
    const birthdays = parseOptionalProjection(birthdayData, birthdayError, toBirthdayCalendarEntry);
    const checkIns = parseOptionalProjection(checkInData, checkInError, toCheckInCalendarEntry);
    const subscriptionReviews = parseOptionalProjection(subscriptionReviewData, subscriptionReviewError, toSubscriptionReviewCalendarEntry);
    const unavailable = [
      !calendar.available ? "leave calendar" : "",
      !birthdays.available ? "birthdays" : "",
      !checkIns.available ? "check-ins" : "",
      !subscriptionReviews.available ? "subscription reviews" : "",
    ].filter(Boolean);
    const warnings = [
      preview.warning,
      unavailable.length
        ? `Some optional data is temporarily unavailable (${unavailable.join(", ")}). Leave requests remain available.`
        : "",
    ].filter(Boolean);
    const policy = leaveEntitlementPolicy(entitlementPolicyData, entitlementPolicyError);

    return {
      ...preview,
      ...policy,
      calendarEntries: staffCalendar.rows.length ? staffCalendar.rows : calendar.rows,
      birthdayEntries: birthdays.rows,
      checkInEntries: checkIns.rows,
      subscriptionReviewEntries: subscriptionReviews.rows,
      payrollBalanceReminderEntries: [],
      canViewSubscriptionReviewCalendar: subscriptionReviewCalendarPermissionError
        ? false
        : canViewSubscriptionReviewCalendar === true,
      canViewPayrollBalanceReminderCalendar: false,
      canImportPayrollBalances: !payrollBalanceImportPermissionError
        && canImportPayrollBalances === true,
      isProfilePreview: true,
      warning: warnings.length ? warnings.join(" ") : undefined,
    };
  }

  const [
    { data: workspaceData, error: workspaceError },
    { data: calendarData, error: calendarError },
    { data: staffCalendarData, error: staffCalendarError },
    { data: birthdayData, error: birthdayError },
    { data: checkInData, error: checkInError },
    { data: subscriptionReviewData, error: subscriptionReviewError },
    { data: canViewSubscriptionReviewCalendar, error: subscriptionReviewCalendarPermissionError },
    { data: canReviewLeave, error: canReviewError },
    { data: canViewAllLeave, error: canViewAllLeaveError },
    { data: attachmentData, error: attachmentError },
    { data: entitlementPolicyData, error: entitlementPolicyError },
    { data: payrollBalanceReminderData, error: payrollBalanceReminderError },
    { data: canImportPayrollBalances, error: payrollBalanceImportPermissionError },
  ] = await Promise.all([
    supabase.rpc("list_leave_workspace_requests"),
    supabase.rpc("list_leave_calendar_entries_with_teams"),
    supabase.rpc("list_staff_leave_calendar_entries"),
    supabase.rpc("list_calendar_birthdays"),
    supabase.rpc("list_employee_check_in_calendar_entries"),
    supabase.rpc("list_subscription_review_calendar_entries"),
    supabase.rpc("can_view_subscription_review_calendar"),
    supabase.rpc("can_review_leave_workspace"),
    supabase.rpc("can_view_all_leave_requests"),
    supabase.rpc("list_leave_workspace_attachments"),
    supabase.rpc("get_my_leave_entitlement_policy"),
    supabase.rpc("list_payroll_balance_reminder_calendar_entries"),
    supabase.rpc("can_import_payroll_balances"),
  ]);

  if (workspaceError || canReviewError || canViewAllLeaveError || !Array.isArray(workspaceData)
    || typeof canReviewLeave !== "boolean" || typeof canViewAllLeave !== "boolean") {
    throw new Error(LOAD_ERROR);
  }

  let requests: LeaveWorkspaceRequest[];
  try {
    requests = workspaceData.map(toWorkspaceRequest);
  } catch {
    throw new Error(LOAD_ERROR);
  }

  const attachments = parseOptionalProjection(attachmentData, attachmentError, toLeaveAttachment);
  // Calendar is available to every active employee. Each database projection
  // independently returns only that employee's authorised records.
  const calendar = parseOptionalProjection(calendarData, calendarError, toCalendarEntry);
  const staffCalendar = parseOptionalProjection(staffCalendarData, staffCalendarError, toCalendarEntry);
  const birthdays = parseOptionalProjection(birthdayData, birthdayError, toBirthdayCalendarEntry);
  const checkIns = parseOptionalProjection(checkInData, checkInError, toCheckInCalendarEntry);
  const subscriptionReviews = parseOptionalProjection(subscriptionReviewData, subscriptionReviewError, toSubscriptionReviewCalendarEntry);
  const payrollBalanceReminders = parseOptionalProjection(
    payrollBalanceReminderData,
    payrollBalanceReminderError,
    toPayrollBalanceReminderCalendarEntry,
  );
  const policy = leaveEntitlementPolicy(entitlementPolicyData, entitlementPolicyError);
  // Supporting files are a Leave-detail capability, not a calendar projection.
  // Keep attachment capability failures out of the global notice so a missing
  // optional attachment RPC cannot make Calendar look unhealthy or block the
  // otherwise usable leave workspace.
  const unavailable = [
    !calendar.available ? "leave calendar" : "",
    !birthdays.available ? "birthdays" : "",
    !checkIns.available ? "check-ins" : "",
    !subscriptionReviews.available ? "subscription reviews" : "",
    !payrollBalanceReminders.available ? "payroll balance reminders" : "",
  ].filter(Boolean);

  return {
    ...policy,
    requests,
    attachments: attachments.rows,
    calendarEntries: staffCalendar.rows.length ? staffCalendar.rows : calendar.rows,
    birthdayEntries: birthdays.rows,
    checkInEntries: checkIns.rows,
    subscriptionReviewEntries: subscriptionReviews.rows,
    payrollBalanceReminderEntries: payrollBalanceReminders.rows,
    canViewSubscriptionReviewCalendar: subscriptionReviewCalendarPermissionError
      ? false
      : canViewSubscriptionReviewCalendar === true,
    canViewPayrollBalanceReminderCalendar: payrollBalanceImportPermissionError
      ? false
      : canImportPayrollBalances === true,
    canImportPayrollBalances: payrollBalanceImportPermissionError
      ? false
      : canImportPayrollBalances === true,
    canReviewLeave,
    canViewAllLeave,
    isProfilePreview: false,
    warning: unavailable.length
      ? `Some optional data is temporarily unavailable (${unavailable.join(", ")}). Leave requests remain available.`
      : undefined,
  };
}

export async function getLeaveWorkspaceData(previewPersonId?: string): Promise<LeaveWorkspaceData> {
  const base = await getBaseLeaveWorkspaceData(previewPersonId);
  const supabase = await requireLeaveSession();
  const { data, error } = await supabase.rpc("get_leave_priority_workspace", { p_preview_person_id: previewPersonId ? selectedPersonId(previewPersonId) : null });
  // Keep the existing workspace usable during a staged database deployment.
  if (error || !data || !Array.isArray(data.people) || !Array.isArray(data.requests) || !Array.isArray(data.pendingBalanceCalendarIds)) {
    return { ...base, warning: [base.warning, "Leave balances and team requests are temporarily unavailable."].filter(Boolean).join(" ") };
  }
  const priority = data as LeavePriorityWorkspace;
  const metadata = new Map(priority.requests.map((row) => [row.id, row]));
  const conditionalCalendar = new Set(priority.pendingBalanceCalendarIds);
  return {
    ...base, priority,
    requests: base.requests.map((request) => ({ ...request,
      status: metadata.get(request.id)?.pendingBalance && request.status === "Pending" ? BALANCE_PENDING_STATUS : request.status,
      evidenceDueDate: metadata.get(request.id)?.evidenceDueDate ?? undefined,
      canAttach: metadata.get(request.id)?.canAttach === true,
      fullDayHours: metadata.get(request.id)?.fullDayHours,
    })),
    calendarEntries: base.calendarEntries.map((request) => ({ ...request,
      status: conditionalCalendar.has(request.id) && request.status === "Pending" ? BALANCE_PENDING_STATUS : request.status,
    })),
  };
}

export async function saveAnnualLeaveBalance(personId: string, hours: number, asOf: string, isExample: boolean) {
  const supabase = await requireLeaveSession();
  if (!Number.isFinite(hours) || hours < -10000 || hours > 100000 || !/^\d{4}-\d{2}-\d{2}$/.test(asOf) || typeof isExample !== "boolean") return { ok: false, message: "Enter a valid balance and date." };
  const { error } = await supabase.rpc("set_employee_annual_leave_balance", {
    p_person_id: selectedPersonId(personId), p_hours: hours, p_as_of: asOf, p_is_example: isExample,
  });
  if (error) return { ok: false, message: "Balance could not be saved. Check your access and balance date." };
  revalidatePath("/");
  return { ok: true };
}

export async function saveSickLeaveBalance(personId: string, hours: number, asOf: string) {
  const supabase = await requireLeaveSession();
  if (!Number.isFinite(hours) || hours < -10000 || hours > 100000 || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return { ok: false, message: "Enter a valid balance and date." };
  const { error } = await supabase.rpc("set_employee_sick_leave_balance", {
    p_person_id: selectedPersonId(personId), p_hours: hours, p_as_of: asOf,
  });
  if (error) return { ok: false, message: "Balance could not be saved. Check your access and balance date." };
  revalidatePath("/");
  return { ok: true };
}

export async function saveLeaveAccrualPolicy(personId: string, input: {
  weeklyHours: number; annualWeeks: number; personalWeeks: number;
  shiftworker: boolean; enabled: boolean; note: string;
}) {
  const supabase = await requireLeaveSession();
  if (![input.weeklyHours, input.annualWeeks, input.personalWeeks].every(Number.isFinite)
    || input.weeklyHours <= 0 || input.weeklyHours > 38
    || input.annualWeeks < (input.shiftworker ? 5 : 4) || input.annualWeeks > 52
    || input.personalWeeks < 2 || input.personalWeeks > 52
    || typeof input.shiftworker !== "boolean" || typeof input.enabled !== "boolean"
    || typeof input.note !== "string" || !input.note.trim() || input.note.length > 1000) {
    return { ok: false, message: "Enter ordinary hours, valid entitlements and a policy note." };
  }
  const { error } = await supabase.rpc("set_employee_leave_accrual_policy", {
    p_person_id: selectedPersonId(personId), p_weekly_hours: input.weeklyHours,
    p_annual_weeks: input.annualWeeks, p_personal_weeks: input.personalWeeks,
    p_shiftworker: input.shiftworker, p_enabled: input.enabled, p_note: input.note.trim(),
  });
  if (error) return { ok: false, message: "Policy could not be saved. Check administrator access and employment type; first activation needs opening payroll balances covering yesterday." };
  revalidatePath("/");
  return { ok: true };
}

export async function saveLeaveAccrualDay(personId: string, input: {
  date: string; annualEligible: number; personalEligible: number;
  annualTaken: number; personalTaken: number; note: string;
}) {
  const supabase = await requireLeaveSession();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)
    || ![input.annualEligible, input.personalEligible, input.annualTaken, input.personalTaken].every((n) => Number.isFinite(n) && n >= 0 && n <= 24)
    || typeof input.note !== "string" || !input.note.trim() || input.note.length > 1000) {
    return { ok: false, message: "Enter a completed date, confirmed hours and a reconciliation note." };
  }
  const { error } = await supabase.rpc("review_employee_leave_accrual_day", {
    p_person_id: selectedPersonId(personId), p_date: input.date,
    p_annual_eligible: input.annualEligible, p_personal_eligible: input.personalEligible,
    p_annual_taken: input.annualTaken, p_personal_taken: input.personalTaken, p_note: input.note.trim(),
  });
  if (error) return { ok: false, message: "Hours could not be saved. Check administrator access and the completed date." };
  revalidatePath("/");
  return { ok: true };
}

export async function previewAnnualLeaveBalance(personId: string, startDate: string, previewPersonId?: string): Promise<AnnualLeaveProjection | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return null;
  const supabase = await requireLeaveSession();
  const { data, error } = await supabase.rpc("preview_annual_leave_balance", {
    p_person_id: selectedPersonId(personId), p_start_date: startDate,
    p_preview_person_id: previewPersonId ? selectedPersonId(previewPersonId) : null,
  });
  if (error || !data || !["projected", "banked_only", "unavailable"].includes(data.status)) return null;
  return data as AnnualLeaveProjection;
}

export async function submitLeaveRequest(input: SubmitLeaveInput) {
  const checked = normaliseLeaveInput(input);
  const supabase = await requireLeaveSession();
  const { data, error } = await supabase.rpc("submit_leave_request_once", {
    p_submission_key: checked.submissionKey,
    p_person_id: null,
    p_request_type_label: checked.leaveType,
    p_start_date: checked.startDate,
    p_end_date: checked.endDate,
    p_start_time: checked.startTime ?? null,
    p_end_time: checked.endTime ?? null,
    p_employee_note: checked.employeeNote ?? null,
  });

  if (error) return { error: userFacingSubmitError(error) };
  const result = toSubmitResult(data);
  scheduleLeaveNotifications(result.id);
  revalidatePath("/");
  return result;
}

/**
 * Super Admin Change Profile submission. The database resolves the selected
 * person to its active linked account and keeps the real Super Admin as the
 * audit actor; the browser never supplies a user_id.
 */
export async function submitLeaveRequestForSelectedEmployee(
  personId: string,
  input: SubmitLeaveInput,
) {
  const checkedPersonId = selectedPersonId(personId);
  const checked = normaliseLeaveInput(input);
  const supabase = await requireLeaveSession();
  // The database permits only System Admin or this employee's direct manager.
  const { data, error } = await supabase.rpc("submit_leave_request_once", {
    p_submission_key: checked.submissionKey,
    p_person_id: checkedPersonId,
    p_request_type_label: checked.leaveType,
    p_start_date: checked.startDate,
    p_end_date: checked.endDate,
    p_start_time: checked.startTime ?? null,
    p_end_time: checked.endTime ?? null,
    p_employee_note: checked.employeeNote ?? null,
  });

  if (error) return { error: userFacingSubmitError(error) };
  const result = toSubmitResult(data);
  scheduleLeaveNotifications(result.id);
  revalidatePath("/");
  return result;
}

export async function decideLeaveRequest(input: DecideLeaveInput) {
  const checked = normaliseDecisionInput(input);
  const supabase = await requireLeaveSession();
  const { data, error } = await supabase.rpc("decide_leave_with_balance", {
    p_request_id: checked.requestId,
    p_status: checked.status,
    p_manager_note: checked.managerNote ?? null,
  });

  if (error) throw new Error(userFacingDecisionError(error));
  const result = toDecisionResult(data);
  scheduleLeaveNotifications(result.id);
  revalidatePath("/");
  return result;
}

/**
 * Cancels any non-cancelled request owned by the authenticated employee.
 * The RPC re-checks ownership and active linked-employee state inside one
 * locked database transaction; the browser never determines eligibility.
 */
export async function cancelMyLeaveRequest(input: CancelLeaveInput) {
  try {
    const checked = normaliseCancelInput(input);
    const supabase = await requireLeaveSession();
    const { data, error } = await supabase.rpc("cancel_my_approved_leave_request", {
      p_request_id: checked.requestId,
    });

    // Cancellation is an expected, user-triggered failure mode (for example,
    // the leave may have started in another tab). Returning a serialisable
    // result keeps Next.js from converting the Server Action exception into a
    // production-only "Server Components render" error. Log only the database
    // error code/message; no leave notes or employee data are included.
    if (error) {
      console.warn("Leave cancellation RPC failed.", {
        code: error.code,
        message: error.message,
      });
      return { ok: false, message: CANCEL_ERROR } satisfies CancelLeaveResult;
    }

    const result = toCancellationResult(data);
    if (result.status !== "Cancelled") {
      console.warn("Leave cancellation RPC returned an unexpected status.", {
        status: result.status,
      });
      return { ok: false, message: CANCEL_ERROR } satisfies CancelLeaveResult;
    }

    scheduleLeaveNotifications(result.id);
    revalidatePath("/");
    return { ok: true, id: result.id, status: "Cancelled" } satisfies CancelLeaveResult;
  } catch (error) {
    console.warn("Leave cancellation action failed.", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return { ok: false, message: CANCEL_ERROR } satisfies CancelLeaveResult;
  }
}

/**
 * Super Admin Change Profile cancellation. The target person is resolved by
 * the database from its active employee/account link; the browser never sends
 * an Auth user ID and the real System Admin remains the audit actor.
 */
export async function cancelSelectedEmployeeLeaveRequest(
  personId: string,
  input: CancelLeaveInput,
) {
  try {
    const checkedPersonId = selectedPersonId(personId);
    const checked = normaliseCancelInput(input);
    const supabase = await requireLeaveSession();
    const { data, error } = await supabase.rpc("cancel_selected_employee_approved_leave_request", {
      p_person_id: checkedPersonId,
      p_request_id: checked.requestId,
    });

    if (error) {
      console.warn("Selected employee leave cancellation RPC failed.", {
        code: error.code,
        message: error.message,
      });
      return { ok: false, message: CANCEL_ERROR } satisfies CancelLeaveResult;
    }

    const result = toCancellationResult(data);
    if (result.status !== "Cancelled") {
      console.warn("Selected employee leave cancellation RPC returned an unexpected status.", {
        status: result.status,
      });
      return { ok: false, message: CANCEL_ERROR } satisfies CancelLeaveResult;
    }

    scheduleLeaveNotifications(result.id);
    revalidatePath("/");
    return { ok: true, id: result.id, status: "Cancelled" } satisfies CancelLeaveResult;
  } catch (error) {
    console.warn("Selected employee leave cancellation action failed.", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return { ok: false, message: CANCEL_ERROR } satisfies CancelLeaveResult;
  }
}

export async function prepareLeaveRequestAttachmentUpload(input: PrepareLeaveAttachmentInput) {
  const checked = normalisePrepareAttachmentInput(input);
  const supabase = await requireLeaveSession();
  const { data, error } = await supabase.rpc("prepare_my_leave_request_attachment_upload", {
    p_request_id: checked.requestId,
    p_file_name: checked.fileName,
    p_mime_type: checked.mimeType,
    p_size_bytes: checked.sizeBytes,
  });
  if (error) throw new Error(userFacingAttachmentError(error));
  const result = toAttachmentUploadPlan(data);
  if (result.fileName !== checked.fileName || result.mimeType !== checked.mimeType || result.sizeBytes !== checked.sizeBytes) {
    throw new Error(ATTACHMENT_ERROR);
  }
  return result;
}

export async function discardLeaveRequestAttachmentUpload(input: CompleteLeaveAttachmentInput) {
  const checked = normaliseCompleteAttachmentInput(input);
  const supabase = await requireLeaveSession();
  const { error } = await supabase.rpc("discard_my_leave_request_attachment_upload", {
    p_storage_path: checked.storagePath,
  });
  if (error) throw new Error(ATTACHMENT_ERROR);
}

export async function completeLeaveRequestAttachmentUpload(input: CompleteLeaveAttachmentInput) {
  const checked = normaliseCompleteAttachmentInput(input);
  const supabase = await requireLeaveSession();
  const { data, error } = await supabase.rpc("complete_my_leave_request_attachment_upload", {
    p_storage_path: checked.storagePath,
  });
  if (error) throw new Error(userFacingAttachmentError(error));
  const rows = Array.isArray(data) ? data : [];
  const attachment = toLeaveAttachment(rows[0], ATTACHMENT_ERROR);
  revalidatePath("/");
  return attachment;
}

export async function deleteLeaveRequestAttachment(input: DeleteLeaveAttachmentInput) {
  const checked = normaliseDeleteAttachmentInput(input);
  const supabase = await requireLeaveSession();
  const { data, error } = await supabase.rpc("delete_my_leave_request_attachment", {
    p_attachment_id: checked.attachmentId,
  });
  if (error) throw new Error(ATTACHMENT_DELETE_ERROR);

  const row = (Array.isArray(data) ? data[0] : null) as {
    attachment_id?: unknown;
    storage_path?: unknown;
  } | null;
  const attachmentId = requireText(row?.attachment_id, ATTACHMENT_DELETE_ERROR);
  const storagePath = requireText(row?.storage_path, ATTACHMENT_DELETE_ERROR);
  if (
    attachmentId !== checked.attachmentId
    || !UUID_PATTERN.test(attachmentId)
    || !ATTACHMENT_STORAGE_PATH_PATTERN.test(storagePath)
  ) throw new Error(ATTACHMENT_DELETE_ERROR);

  // The authorised RPC removes the public metadata first, making the object
  // immediately inaccessible. Storage cleanup is best-effort here; the
  // existing bounded orphan job removes any object left by a provider outage.
  try {
    const admin = createAdminClient();
    const { error: removalError } = await admin.storage
      .from("leave-evidence")
      .remove([storagePath]);
    if (removalError) throw removalError;
  } catch {
    console.warn("Leave attachment bytes were queued for orphan cleanup after metadata deletion.");
  }

  revalidatePath("/");
  return { id: attachmentId };
}
