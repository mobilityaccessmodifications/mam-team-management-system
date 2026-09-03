"use server";

import { createHash } from "node:crypto";

import { revalidatePath } from "next/cache";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type LeaveStatus = "Pending" | "Approved" | "Declined" | "Cancelled";

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
};

export type LeaveAttachment = {
  id: string;
  leaveRequestId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
};

export type LeaveCalendarEntry = Pick<
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
>;

/**
 * A deliberately minimal company-calendar birthday projection. It contains
 * neither a date of birth nor any private contact information: the calendar
 * only needs the employee's name and recurring month/day.
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
  milestone: "2_week" | "1_month" | "3_month" | "5_month";
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

export type LeaveWorkspaceData = {
  requests: LeaveWorkspaceRequest[];
  attachments: LeaveAttachment[];
  calendarEntries: LeaveCalendarEntry[];
  birthdayEntries: BirthdayCalendarEntry[];
  checkInEntries: CheckInCalendarEntry[];
  subscriptionReviewEntries: SubscriptionReviewCalendarEntry[];
  /** Current active profile may open the calendar for its own review dates. */
  canViewSubscriptionReviewCalendar: boolean;
  /**
   * A capability asserted by the database for the authenticated session.
   * This intentionally remains separate from per-request `canDecide`, so an
   * authorised reviewer still receives an empty Approvals workspace when no
   * request is pending.
   */
  canReviewLeave: boolean;
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
  leaveType: string;
  startDate: string;
  endDate: string;
  startTime?: string;
  endTime?: string;
  employeeNote?: string;
};

export type DecideLeaveInput = {
  requestId: string;
  status: "Approved" | "Declined";
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
  "approval_required" | "submitted_at" | "assigned_reviewer_label" | "can_decide" | "can_cancel" | "can_attach" | "employee_note" | "manager_note"
>;

type AttachmentRpcRow = {
  id: string;
  leave_request_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number | string;
  created_at: string;
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

type LeaveNotificationEvent = "leave-submitted" | "leave-approved" | "leave-declined" | "leave-cancelled";

type LeaveNotificationFallback = {
  leaveType?: string;
  startDate?: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  employeeNote?: string;
  managerNote?: string;
  managerEmail?: string;
  status?: LeaveStatus;
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
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HR_LEAVE_CC_EMAIL = "hr@mobilityaccess.com.au";
const MAM_ACCOUNTS_LEAVE_CC_EMAIL = "accounts@mobilityaccess.com.au";
const LEAVE_EVENTS_REQUIRING_ACCOUNTS_CC = new Set<LeaveNotificationEvent>([
  "leave-approved",
  "leave-cancelled",
]);
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
  if (value === "Pending" || value === "Approved" || value === "Declined" || value === "Cancelled") return value;
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
  };
}

function toCalendarEntry(value: unknown): LeaveCalendarEntry {
  const row = value as CalendarRpcRow;
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
    status: status(row.status, LOAD_ERROR),
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
  if (!["2_week", "1_month", "3_month", "5_month"].includes(String(row.milestone))) throw new Error(LOAD_ERROR);
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

  const leaveType = requireText(input.leaveType, "Choose a valid leave type.");
  if (!LEAVE_TYPES.has(leaveType)) throw new Error("Choose a valid leave type.");
  const startDate = requiredDate(input.startDate, "Choose a valid start date.");
  const endDate = requiredDate(input.endDate, "Choose a valid end date.");
  if (endDate < startDate) throw new Error("End date must be on or after start date.");

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

  return { leaveType, startDate, endDate, startTime, endTime, employeeNote };
}

function normaliseDecisionInput(input: DecideLeaveInput) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(DECISION_ERROR);
  const requestId = requireText(input.requestId, DECISION_ERROR);
  if (!UUID_PATTERN.test(requestId)) throw new Error(DECISION_ERROR);
  if (input.status !== "Approved" && input.status !== "Declined") throw new Error(DECISION_ERROR);
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

type LeaveNotificationManagerRow = {
  manager_user_id: string | null;
  manager_name: string | null;
  manager_email: string | null;
};

type LeaveNotificationEmployeeRow = {
  employee_work_email?: unknown;
  employee_personal_email?: unknown;
  employee_emails?: unknown;
};

type LeaveNotificationEmployeeRecipients = {
  workEmail?: string;
  personalEmail?: string;
  emails: string[];
};

/**
 * Resolve the employee's nearest active reporting manager on the server. The
 * notification recipient is the HR-recorded work email, never the portal
 * login email (which may be an internal accounts alias). The browser never
 * supplies a recipient and the private work email is only included in the
 * signed n8n notification payload.
 */
async function resolveLeaveManagerEmail(requestId: string) {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("resolve_leave_notification_manager", {
      p_request_id: requestId,
    });
    if (error || !Array.isArray(data) || data.length !== 1) return undefined;

    const row = data[0] as LeaveNotificationManagerRow;
    const email = row?.manager_email?.trim().toLowerCase();
    return email && EMAIL_PATTERN.test(email) ? email : undefined;
  } catch {
    return undefined;
  }
}

function normaliseNotificationEmail(value: unknown) {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return EMAIL_PATTERN.test(email) ? email : undefined;
}

function notificationEmailList(value: unknown) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[;,]/) : [];
  return [...new Set(values.map(normaliseNotificationEmail).filter((email): email is string => Boolean(email)))];
}

function leaveNotificationCcEmails(event: LeaveNotificationEvent) {
  const addresses = [HR_LEAVE_CC_EMAIL];
  if (LEAVE_EVENTS_REQUIRING_ACCOUNTS_CC.has(event)) {
    addresses.push(MAM_ACCOUNTS_LEAVE_CC_EMAIL);
  }
  return addresses;
}

/**
 * Resolve the employee's HR-recorded work and personal emails on the server.
 * Both addresses are included only in the signed notification payload; they
 * are never returned to the browser or accepted from the leave form.
 */
async function resolveLeaveEmployeeRecipients(requestId: string): Promise<LeaveNotificationEmployeeRecipients> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("resolve_leave_notification_employee_recipients", {
      p_request_id: requestId,
    });
    if (error || !Array.isArray(data) || data.length !== 1) return { emails: [] };

    const row = data[0] as LeaveNotificationEmployeeRow;
    const workEmail = normaliseNotificationEmail(row.employee_work_email);
    const personalEmail = normaliseNotificationEmail(row.employee_personal_email);
    const emails = notificationEmailList(row.employee_emails);
    return {
      workEmail,
      personalEmail,
      emails: emails.length ? emails : [...new Set([workEmail, personalEmail].filter((email): email is string => Boolean(email)))],
    };
  } catch {
    return { emails: [] };
  }
}

/**
 * Leave submission and cancellation events are routed to the request's
 * nearest active manager/admin. Approval and decline events are routed to the
 * requesting employee. The browser never supplies a recipient, and a delivery
 * failure cannot roll back a leave decision already recorded in Supabase.
 */
async function deliverLeaveNotification(
  supabase: Awaited<ReturnType<typeof createClient>>,
  event: LeaveNotificationEvent,
  requestId: string,
  fallback: LeaveNotificationFallback = {},
) {
  const webhookUrl = process.env.MAM_N8N_LEAVE_WEBHOOK_URL?.trim();
  const webhookOrigin = process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN?.trim();
  const webhookSecret = process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET?.trim();
  if (!webhookUrl || !webhookOrigin || !webhookSecret) {
    // A leave mutation must remain durable even if the delivery integration is
    // incomplete. Log only which configuration fields are absent: URLs,
    // secrets, leave details and recipient details must never reach logs.
    console.warn("Leave notification delivery is not configured.", {
      hasWebhookUrl: Boolean(webhookUrl),
      hasWebhookOrigin: Boolean(webhookOrigin),
      hasWebhookSecret: Boolean(webhookSecret),
    });
    return;
  }

  let url: URL;
  let trustedOrigin: URL;
  try {
    url = new URL(webhookUrl);
    trustedOrigin = new URL(webhookOrigin);
  } catch {
    return;
  }
  if (
    url.protocol !== "https:"
    || trustedOrigin.protocol !== "https:"
    || trustedOrigin.pathname !== "/"
    || trustedOrigin.username
    || trustedOrigin.password
    || trustedOrigin.search
    || trustedOrigin.hash
    || url.origin !== trustedOrigin.origin
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname === "/"
  ) return;

  let request: LeaveWorkspaceRequest | undefined;
  try {
    const { data } = await supabase.rpc("list_leave_workspace_requests");
    if (Array.isArray(data)) {
      const row = data.find((candidate) => typeof candidate === "object" && candidate !== null && "id" in candidate && (candidate as { id?: unknown }).id === requestId);
      if (row) request = toWorkspaceRequest(row);
    }
  } catch {
    // The durable leave mutation already succeeded; fallback fields below are
    // still sufficient for the marketing test message.
  }

  const managerEmail = await resolveLeaveManagerEmail(requestId);
  const employeeRecipients = await resolveLeaveEmployeeRecipients(requestId);
  const employeeEmail = employeeRecipients.emails.join(",");
  const ccEmails = leaveNotificationCcEmails(event);

  const payload = {
    version: 1,
    event,
    eventKey: `leave:${requestId}:${event}:${createHash("sha256").update(JSON.stringify({
      event,
      requestId,
      status: request?.status ?? fallback.status ?? "Pending",
      startDate: request?.startDate ?? fallback.startDate ?? "",
      endDate: request?.endDate ?? fallback.endDate ?? "",
      managerNote: request?.managerNote ?? fallback.managerNote ?? "",
      managerEmail: managerEmail ?? fallback.managerEmail ?? "",
      employeeEmail,
      employeeEmails: employeeRecipients.emails,
      ccEmails,
    })).digest("hex").slice(0, 24)}`,
    requestId,
    employeeName: request?.employee ?? "Employee",
    company: request?.company ?? "mam",
    leaveType: request?.leaveType ?? fallback.leaveType ?? "Leave",
    startDate: request?.startDate ?? fallback.startDate ?? "",
    endDate: request?.endDate ?? fallback.endDate ?? "",
    startTime: request?.startTime ?? fallback.startTime ?? null,
    endTime: request?.endTime ?? fallback.endTime ?? null,
    days: request?.days ?? null,
    hours: request?.hours ?? null,
    status: request?.status ?? fallback.status ?? "Pending",
    employeeNote: request?.employeeNote ?? fallback.employeeNote ?? null,
    managerNote: request?.managerNote ?? fallback.managerNote ?? null,
    managerEmail: managerEmail ?? fallback.managerEmail ?? null,
    // Keep employeeEmail as a comma-separated value for the existing n8n
    // Outlook node, while also exposing typed fields for a receiver that
    // prefers an explicit list or separate work/personal mappings.
    employeeEmail: employeeEmail || null,
    employeeEmails: employeeRecipients.emails,
    employeeWorkEmail: employeeRecipients.workEmail ?? null,
    employeePersonalEmail: employeeRecipients.personalEmail ?? null,
    // The n8n receiver should map ccEmails to the email provider's CC field.
    // HR is included on every leave notification; MAM Accounts is included
    // when a leave request is approved or cancelled.
    ccEmails,
    ccEmail: ccEmails.join(","),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-MAM-Notification-Secret": webhookSecret },
      body: JSON.stringify(payload),
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    const responseText = await response.text();
    let result: { ok?: boolean; sent?: boolean; alreadySent?: boolean; actualRecipient?: unknown; actualRecipients?: unknown } = {};
    if (responseText && responseText.length <= 4096) {
      try {
        const parsed: unknown = JSON.parse(responseText);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) result = parsed;
      } catch {
        console.warn("Leave notification receiver returned invalid JSON.", { event, requestId, status: response.status });
      }
    }
    const expectedRecipients = event === "leave-submitted" || event === "leave-cancelled"
      ? managerEmail ? [managerEmail] : []
      : employeeRecipients.emails;
    const actualRecipients = notificationEmailList(result.actualRecipients ?? result.actualRecipient);
    const recipientsMatch = actualRecipients.length > 0
      ? actualRecipients.length === expectedRecipients.length && actualRecipients.every((email) => expectedRecipients.includes(email))
      : expectedRecipients.length === 0;
    if (!response.ok || result.ok !== true || (result.sent !== true && result.alreadySent !== true) || !recipientsMatch) {
      console.warn("Leave notification delivery was not confirmed.", { event, requestId, status: response.status, expectedRecipients });
    }
  } catch {
    console.warn("Leave notification delivery failed after the leave mutation.", { event, requestId });
  } finally {
    clearTimeout(timeout);
  }
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
    message === "Choose a valid leave type."
    || message === "End date must be on or after start date."
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
    warning: payload.is_truncated
      ? "Leave history is limited to the 1,000 most recent visible requests."
      : undefined,
  };
}

export async function getLeaveWorkspaceData(previewPersonId?: string): Promise<LeaveWorkspaceData> {
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
    const canViewPreviewTeamCalendar = preview.canReviewLeave;
    const [
      { data: birthdayData, error: birthdayError },
      { data: checkInData, error: checkInError },
      { data: subscriptionReviewData, error: subscriptionReviewError },
      { data: canViewSubscriptionReviewCalendar, error: subscriptionReviewCalendarPermissionError },
      { data: entitlementPolicyData, error: entitlementPolicyError },
    ] = await Promise.all([
      canViewPreviewTeamCalendar
        ? supabase.rpc("list_calendar_birthdays")
        : Promise.resolve({ data: [], error: null }),
      canViewPreviewTeamCalendar
        ? supabase.rpc("list_employee_check_in_calendar_entries_for_preview", { p_person_id: checkedPreviewPersonId })
        : Promise.resolve({ data: [], error: null }),
      supabase.rpc("list_subscription_review_calendar_entries_for_preview", { p_person_id: checkedPreviewPersonId }),
      supabase.rpc("can_view_subscription_review_calendar_for_preview", { p_person_id: checkedPreviewPersonId }),
      supabase.rpc("get_selected_employee_leave_entitlement_policy", { p_person_id: checkedPreviewPersonId }),
    ]);
    const birthdays = parseOptionalProjection(birthdayData, birthdayError, toBirthdayCalendarEntry);
    const checkIns = parseOptionalProjection(checkInData, checkInError, toCheckInCalendarEntry);
    const subscriptionReviews = parseOptionalProjection(subscriptionReviewData, subscriptionReviewError, toSubscriptionReviewCalendarEntry);
    const unavailable = [
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
      birthdayEntries: birthdays.rows,
      checkInEntries: checkIns.rows,
      subscriptionReviewEntries: subscriptionReviews.rows,
      canViewSubscriptionReviewCalendar: subscriptionReviewCalendarPermissionError
        ? false
        : canViewSubscriptionReviewCalendar === true,
      isProfilePreview: true,
      warning: warnings.length ? warnings.join(" ") : undefined,
    };
  }

  const [
    { data: workspaceData, error: workspaceError },
    { data: calendarData, error: calendarError },
    { data: birthdayData, error: birthdayError },
    { data: checkInData, error: checkInError },
    { data: subscriptionReviewData, error: subscriptionReviewError },
    { data: canViewSubscriptionReviewCalendar, error: subscriptionReviewCalendarPermissionError },
    { data: canViewTeamCalendar, error: teamCalendarPermissionError },
    { data: canReviewLeave, error: canReviewError },
    { data: attachmentData, error: attachmentError },
    { data: entitlementPolicyData, error: entitlementPolicyError },
  ] = await Promise.all([
    supabase.rpc("list_leave_workspace_requests"),
    supabase.rpc("list_leave_calendar_entries"),
    supabase.rpc("list_calendar_birthdays"),
    supabase.rpc("list_employee_check_in_calendar_entries"),
    supabase.rpc("list_subscription_review_calendar_entries"),
    supabase.rpc("can_view_subscription_review_calendar"),
    supabase.rpc("can_view_employee_check_in_workspace"),
    supabase.rpc("can_review_leave_workspace"),
    supabase.rpc("list_leave_workspace_attachments"),
    supabase.rpc("get_my_leave_entitlement_policy"),
  ]);

  if (workspaceError || canReviewError || !Array.isArray(workspaceData) || typeof canReviewLeave !== "boolean") {
    throw new Error(LOAD_ERROR);
  }

  let requests: LeaveWorkspaceRequest[];
  try {
    requests = workspaceData.map(toWorkspaceRequest);
  } catch {
    throw new Error(LOAD_ERROR);
  }

  const attachments = parseOptionalProjection(attachmentData, attachmentError, toLeaveAttachment);
  // An employee who becomes responsible for a subscription must not receive
  // team leave, birthdays or check-ins merely to view their own review date.
  // The same database capability that the page uses for the team calendar
  // governs which calendar DTOs can leave this server action.
  const canViewTeamCalendarScope = !teamCalendarPermissionError
    && canViewTeamCalendar === true;
  const calendar = canViewTeamCalendarScope
    ? parseOptionalProjection(calendarData, calendarError, toCalendarEntry)
    : { available: true, rows: [] as LeaveCalendarEntry[] };
  const birthdays = canViewTeamCalendarScope
    ? parseOptionalProjection(birthdayData, birthdayError, toBirthdayCalendarEntry)
    : { available: true, rows: [] as BirthdayCalendarEntry[] };
  const checkIns = canViewTeamCalendarScope
    ? parseOptionalProjection(checkInData, checkInError, toCheckInCalendarEntry)
    : { available: true, rows: [] as CheckInCalendarEntry[] };
  const subscriptionReviews = parseOptionalProjection(subscriptionReviewData, subscriptionReviewError, toSubscriptionReviewCalendarEntry);
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
  ].filter(Boolean);

  return {
    ...policy,
    requests,
    attachments: attachments.rows,
    calendarEntries: calendar.rows,
    birthdayEntries: birthdays.rows,
    checkInEntries: checkIns.rows,
    subscriptionReviewEntries: subscriptionReviews.rows,
    canViewSubscriptionReviewCalendar: subscriptionReviewCalendarPermissionError
      ? false
      : canViewSubscriptionReviewCalendar === true,
    canReviewLeave,
    isProfilePreview: false,
    warning: unavailable.length
      ? `Some optional data is temporarily unavailable (${unavailable.join(", ")}). Leave requests remain available.`
      : undefined,
  };
}

export async function submitLeaveRequest(input: SubmitLeaveInput) {
  const checked = normaliseLeaveInput(input);
  const supabase = await requireLeaveSession();
  const { data, error } = await supabase.rpc("submit_my_leave_request", {
    p_request_type_label: checked.leaveType,
    p_start_date: checked.startDate,
    p_end_date: checked.endDate,
    p_start_time: checked.startTime ?? null,
    p_end_time: checked.endTime ?? null,
    p_employee_note: checked.employeeNote ?? null,
  });

  if (error) throw new Error(userFacingSubmitError(error));
  const result = toSubmitResult(data);
  await deliverLeaveNotification(supabase, "leave-submitted", result.id, checked);
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
  const { data: allowed, error: permissionError } = await supabase.rpc("can_change_employee_view");
  if (permissionError || allowed !== true) throw new Error(SELECTED_PROFILE_SUBMIT_ERROR);

  const { data, error } = await supabase.rpc("submit_selected_employee_leave_request", {
    p_person_id: checkedPersonId,
    p_request_type_label: checked.leaveType,
    p_start_date: checked.startDate,
    p_end_date: checked.endDate,
    p_start_time: checked.startTime ?? null,
    p_end_time: checked.endTime ?? null,
    p_employee_note: checked.employeeNote ?? null,
  });

  if (error) throw new Error(userFacingSubmitError(error));
  const result = toSubmitResult(data);
  await deliverLeaveNotification(supabase, "leave-submitted", result.id, checked);
  revalidatePath("/");
  return result;
}

export async function decideLeaveRequest(input: DecideLeaveInput) {
  const checked = normaliseDecisionInput(input);
  const supabase = await requireLeaveSession();
  const { data, error } = await supabase.rpc("decide_my_managed_leave_request", {
    p_request_id: checked.requestId,
    p_status: checked.status,
    p_manager_note: checked.managerNote ?? null,
  });

  if (error) throw new Error(userFacingDecisionError(error));
  const result = toDecisionResult(data);
  await deliverLeaveNotification(supabase, checked.status === "Approved" ? "leave-approved" : "leave-declined", result.id, {
    status: checked.status,
    managerNote: checked.managerNote,
  });
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

    await deliverLeaveNotification(supabase, "leave-cancelled", result.id, { status: "Cancelled" });
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

    await deliverLeaveNotification(supabase, "leave-cancelled", result.id, { status: "Cancelled" });
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
