"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

export type LeaveStatus = "Pending" | "Approved" | "Declined" | "Cancelled";

export type LeaveWorkspaceRequest = {
  id: string;
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
  employeeNote?: string;
  managerNote?: string;
};

export type LeaveCalendarEntry = Pick<
  LeaveWorkspaceRequest,
  | "id"
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

type WorkspaceRpcRow = {
  id: string;
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
  employee_note: string | null;
  manager_note: string | null;
};

type CalendarRpcRow = Omit<
  WorkspaceRpcRow,
  "approval_required" | "submitted_at" | "assigned_reviewer_label" | "can_decide" | "can_cancel" | "employee_note" | "manager_note"
>;

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

type SubmitRpcRow = {
  id: string;
  status: string;
  approval_required: boolean;
  assigned_reviewer_label: string | null;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:(?:0[6-9]|1[0-7]):(?:00|15|30|45)|18:00)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEAVE_TYPES = new Set([
  "Annual leave",
  "Sick leave",
  "Carer's leave",
  "Unpaid leave",
]);

const LOAD_ERROR = "Leave records could not be loaded. Refresh and try again.";
const SAVE_ERROR = "The leave request could not be saved. Refresh and try again.";
const DECISION_ERROR = "The leave decision could not be saved. Refresh and try again.";
const CANCEL_ERROR = "The leave request could not be cancelled. Refresh and try again.";

function requireText(value: unknown, errorMessage: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(errorMessage);
  return value.trim();
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
    employeeNote: optionalText(row.employee_note),
    managerNote: optionalText(row.manager_note),
  };
}

function toCalendarEntry(value: unknown): LeaveCalendarEntry {
  const row = value as CalendarRpcRow;
  const id = requireText(row?.id, LOAD_ERROR);
  if (!UUID_PATTERN.test(id)) throw new Error(LOAD_ERROR);

  return {
    id,
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

export async function getLeaveWorkspaceData(): Promise<LeaveWorkspaceData> {
  const supabase = await requireLeaveSession();
  const [
    { data: workspaceData, error: workspaceError },
    { data: calendarData, error: calendarError },
    { data: birthdayData, error: birthdayError },
    { data: checkInData, error: checkInError },
    { data: canReviewLeave, error: canReviewError },
  ] = await Promise.all([
    supabase.rpc("list_leave_workspace_requests"),
    supabase.rpc("list_leave_calendar_entries"),
    supabase.rpc("list_calendar_birthdays"),
    supabase.rpc("list_employee_check_in_calendar_entries"),
    supabase.rpc("can_review_leave_workspace"),
  ]);

  if (
    workspaceError
    || calendarError
    || birthdayError
    || checkInError
    || canReviewError
    || !Array.isArray(workspaceData)
    || !Array.isArray(calendarData)
    || !Array.isArray(birthdayData)
    || !Array.isArray(checkInData)
    || typeof canReviewLeave !== "boolean"
  ) {
    throw new Error(LOAD_ERROR);
  }

  try {
    return {
      requests: workspaceData.map(toWorkspaceRequest),
      calendarEntries: calendarData.map(toCalendarEntry),
      birthdayEntries: birthdayData.map(toBirthdayCalendarEntry),
      checkInEntries: checkInData.map(toCheckInCalendarEntry),
      canReviewLeave,
    };
  } catch {
    throw new Error(LOAD_ERROR);
  }
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
  revalidatePath("/");
  return result;
}
