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

export type LeaveWorkspaceData = {
  requests: LeaveWorkspaceRequest[];
  attachments: LeaveAttachment[];
  calendarEntries: LeaveCalendarEntry[];
  birthdayEntries: BirthdayCalendarEntry[];
  checkInEntries: CheckInCalendarEntry[];
  /**
   * A capability asserted by the database for the authenticated session.
   * This intentionally remains separate from per-request `canDecide`, so an
   * authorised reviewer still receives an empty Approvals workspace when no
   * request is pending.
   */
  canReviewLeave: boolean;
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

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:(?:0[6-9]|1[0-7]):(?:00|15|30|45)|18:00)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ATTACHMENT_STORAGE_PATH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:pdf|heic|heif|jpg|png|webp)$/i;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const LEAVE_TYPES = new Set([
  "Annual leave",
  "Sick leave",
  "Carer's leave",
  "Unpaid leave",
]);
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

/**
 * Leave submission is routed to the request's assigned manager. Other leave
 * lifecycle events keep the Marketing test route until the HR templates are
 * approved. The browser never supplies a recipient, and a delivery failure
 * cannot roll back a leave decision already recorded in Supabase.
 */
async function deliverLeaveNotification(
  supabase: Awaited<ReturnType<typeof createClient>>,
  event: LeaveNotificationEvent,
  requestId: string,
  fallback: LeaveNotificationFallback = {},
) {
  const webhookUrl = process.env.MAM_N8N_LEAVE_WEBHOOK_URL?.trim();
  const webhookSecret = process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET?.trim();
  if (!webhookUrl || !webhookSecret) return;

  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    return;
  }
  if (url.protocol !== "https:" || url.hostname !== "n8n.srv1866578.hstgr.cloud" || url.pathname !== "/webhook/mam-people-system-leave-hr-v1") return;

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
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-MAM-Notification-Secret": webhookSecret },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    const result = text.length <= 4096 ? JSON.parse(text) as { ok?: boolean; sent?: boolean; alreadySent?: boolean; actualRecipient?: string } : {};
    const expectedRecipient = event === "leave-submitted" && managerEmail
      ? managerEmail
      : "marketing@mobilityaccess.com.au";
    if (!response.ok || result.ok !== true || (result.sent !== true && result.alreadySent !== true) || result.actualRecipient !== expectedRecipient) {
      console.warn("Leave notification delivery was not confirmed.", { event, requestId, status: response.status, expectedRecipient });
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
  ) {
    return message;
  }
  return SAVE_ERROR;
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

export async function getLeaveWorkspaceData(previewPersonId?: string): Promise<LeaveWorkspaceData> {
  const supabase = await requireLeaveSession();
  const checkedPreviewPersonId = previewPersonId ? selectedPersonId(previewPersonId) : null;

  if (checkedPreviewPersonId) {
    const { data: canChangeProfile, error: previewPermissionError } = await supabase.rpc("can_change_employee_view");
    if (previewPermissionError || canChangeProfile !== true) {
      throw new Error(SELECTED_PROFILE_SUBMIT_ERROR);
    }
  }

  const [
    { data: workspaceData, error: workspaceError },
    { data: calendarData, error: calendarError },
    { data: birthdayData, error: birthdayError },
    { data: checkInData, error: checkInError },
    { data: canReviewLeave, error: canReviewError },
    { data: attachmentData, error: attachmentError },
  ] = await Promise.all([
    supabase.rpc("list_leave_workspace_requests"),
    supabase.rpc("list_leave_calendar_entries"),
    supabase.rpc("list_calendar_birthdays"),
    checkedPreviewPersonId
      ? supabase.rpc("list_employee_check_in_calendar_entries_for_preview", { p_person_id: checkedPreviewPersonId })
      : supabase.rpc("list_employee_check_in_calendar_entries"),
    supabase.rpc("can_review_leave_workspace"),
    supabase.rpc("list_leave_workspace_attachments"),
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
  const calendar = parseOptionalProjection(calendarData, calendarError, toCalendarEntry);
  const birthdays = parseOptionalProjection(birthdayData, birthdayError, toBirthdayCalendarEntry);
  const checkIns = parseOptionalProjection(checkInData, checkInError, toCheckInCalendarEntry);
  // Supporting files are a Leave-detail capability, not a calendar projection.
  // Keep attachment capability failures out of the global notice so a missing
  // optional attachment RPC cannot make Calendar look unhealthy or block the
  // otherwise usable leave workspace.
  const unavailable = [
    !calendar.available ? "leave calendar" : "",
    !birthdays.available ? "birthdays" : "",
    !checkIns.available ? "check-ins" : "",
  ].filter(Boolean);

  return {
    requests,
    attachments: attachments.rows,
    calendarEntries: calendar.rows,
    birthdayEntries: birthdays.rows,
    checkInEntries: checkIns.rows,
    canReviewLeave,
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
 * Cancels only a future approved request owned by the authenticated employee.
 * The RPC re-checks ownership, active linked-employee state, status and the
 * Melbourne start-date rule inside one locked database transaction.
 */
export async function cancelMyApprovedLeaveRequest(input: CancelLeaveInput) {
  const checked = normaliseCancelInput(input);
  const supabase = await requireLeaveSession();
  const { data, error } = await supabase.rpc("cancel_my_approved_leave_request", {
    p_request_id: checked.requestId,
  });

  if (error) throw new Error(CANCEL_ERROR);
  const result = toCancellationResult(data);
  if (result.status !== "Cancelled") throw new Error(CANCEL_ERROR);
  await deliverLeaveNotification(supabase, "leave-cancelled", result.id, { status: "Cancelled" });
  revalidatePath("/");
  return result;
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
