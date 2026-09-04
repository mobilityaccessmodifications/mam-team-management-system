import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { EmployeeWorkingWeekday } from "@/lib/employee-directory-types";
import type {
  WorkScheduleHistoryItem,
  WorkScheduleReviewItem,
  WorkScheduleWorkspace,
} from "@/lib/work-schedule-types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOAD_ERROR = "Work schedule details could not be loaded. Refresh and try again.";
const SAVE_ERROR = "The work schedule request could not be saved. Refresh and try again.";
const DECISION_ERROR = "The work schedule request could not be updated. Refresh and try again.";
const SAFE_DATABASE_MESSAGES = new Set([
  "Choose at least one work day.",
  "Choose a work schedule that is different from the current schedule.",
  "This employee profile is unavailable.",
  "Choose Approve or Decline.",
  "This work-schedule request is unavailable.",
  "This work-schedule request has already been reviewed.",
  "This employee profile is no longer active.",
  "This employee work schedule is unavailable.",
  "The work schedule changed after this request was sent. Refresh and review it again.",
  "Reason must contain between 1 and 1,000 characters.",
  "Decision reason must contain between 1 and 1,000 characters.",
]);

type RpcError = { code?: string; message?: string } | null;
type WorkScheduleErrorKind = "access" | "target" | "data" | "transient";

export class WorkSchedulePublicError extends Error {
  constructor(
    message: string,
    readonly kind: WorkScheduleErrorKind = "data",
  ) {
    super(message);
    this.name = "WorkSchedulePublicError";
  }
}

function loadErrorKind(error: RpcError): WorkScheduleErrorKind {
  if (error?.code === "42501") return "access";
  if (error?.code === "23503") return "target";
  if (
    error?.code?.startsWith("08")
    || ["53300", "57014", "57P01", "PGRST000", "PGRST001", "PGRST002", "PGRST003"].includes(error?.code ?? "")
  ) return "transient";
  return "data";
}

function isRetryableAuthError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; status?: unknown };
  return candidate.name === "AuthRetryableFetchError"
    || (typeof candidate.status === "number" && candidate.status >= 500);
}

function safeMessage(error: RpcError, fallback: string) {
  const message = error?.message?.trim() ?? "";
  if (error?.code === "42501") return "You do not have permission to do that.";
  if (error?.code === "23505") return "There is already a work schedule request waiting for review.";
  if (
    ["22023", "22004", "23503", "40001"].includes(error?.code ?? "")
    && SAFE_DATABASE_MESSAGES.has(message)
  ) {
    return message;
  }
  return fallback;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkSchedulePublicError(LOAD_ERROR);
  return value as Record<string, unknown>;
}

function text(value: unknown, required = false) {
  const result = typeof value === "string" ? value : "";
  if (required && !result.trim()) throw new WorkSchedulePublicError(LOAD_ERROR);
  return result;
}

function nullableText(value: unknown) {
  return value === null || value === undefined ? null : text(value, true);
}

function weekdays(value: unknown, allowNull: true): EmployeeWorkingWeekday[] | null;
function weekdays(value: unknown, allowNull?: false): EmployeeWorkingWeekday[];
function weekdays(value: unknown, allowNull = false) {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw new WorkSchedulePublicError(LOAD_ERROR);
  }
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > 7
    || value.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
    || new Set(value).size !== value.length
  ) throw new WorkSchedulePublicError(LOAD_ERROR);
  return [...value].sort((first, second) => Number(first) - Number(second)) as EmployeeWorkingWeekday[];
}

function status(value: unknown) {
  if (
    value === "submitted"
    || value === "approved"
    || value === "declined"
    || value === "cancelled"
  ) return value;
  throw new WorkSchedulePublicError(LOAD_ERROR);
}

function historyItem(value: unknown): WorkScheduleHistoryItem {
  const row = record(value);
  return {
    id: text(row.id, true),
    originalWorkingWeekdays: weekdays(row.original_working_weekdays, true),
    requestedWorkingWeekdays: weekdays(row.requested_working_weekdays),
    requestReason: text(row.request_reason, true),
    submittedByName: text(row.submitted_by_name, true),
    status: status(row.status),
    submittedAt: text(row.submitted_at, true),
    decidedAt: nullableText(row.decided_at),
    reviewerName: nullableText(row.reviewer_name),
    decisionReason: nullableText(row.decision_reason),
  };
}

function reviewItem(value: unknown): WorkScheduleReviewItem {
  const row = record(value);
  return {
    ...historyItem(row),
    personId: text(row.person_id, true),
    employeeName: text(row.employee_name, true),
  };
}

function parseWorkspace(value: unknown): WorkScheduleWorkspace {
  const row = record(value);
  const rawHistory = Array.isArray(row.history) ? row.history : [];
  const rawReviews = Array.isArray(row.reviews) ? row.reviews : [];
  return {
    activePersonId: nullableText(row.active_person_id),
    activePersonName: nullableText(row.active_person_name),
    workingWeekdays: weekdays(row.working_weekdays, true),
    canRequestChange: row.can_request_change === true,
    isProfilePreview: row.is_profile_preview === true,
    history: rawHistory.map(historyItem),
    reviews: rawReviews.map(reviewItem),
  };
}

async function authenticatedClient(transientMessage: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error && isRetryableAuthError(error)) {
    throw new WorkSchedulePublicError(transientMessage, "transient");
  }
  if (error || !data.user) {
    throw new WorkSchedulePublicError("Your session has expired. Sign in again.", "access");
  }
  return supabase;
}

export async function getEmployeeWorkScheduleWorkspace(previewPersonId?: string) {
  const supabase = await authenticatedClient(LOAD_ERROR);
  if (previewPersonId && !UUID_PATTERN.test(previewPersonId)) throw new WorkSchedulePublicError(LOAD_ERROR);
  const { data, error } = previewPersonId
    ? await supabase.rpc("get_selected_employee_work_schedule_workspace", { p_person_id: previewPersonId })
    : await supabase.rpc("get_my_employee_work_schedule_workspace");
  if (error) throw new WorkSchedulePublicError(safeMessage(error, LOAD_ERROR), loadErrorKind(error));
  return parseWorkspace(data);
}

export async function submitEmployeeWorkScheduleChange(input: {
  workingWeekdays: EmployeeWorkingWeekday[];
  reason: string;
  previewPersonId?: string;
}) {
  const supabase = await authenticatedClient(SAVE_ERROR);
  if (input.previewPersonId && !UUID_PATTERN.test(input.previewPersonId)) throw new WorkSchedulePublicError(SAVE_ERROR);
  const { error } = input.previewPersonId
    ? await supabase.rpc("submit_selected_employee_work_schedule_change_request", {
        p_person_id: input.previewPersonId,
        p_requested_working_weekdays: input.workingWeekdays,
        p_reason: input.reason,
      })
    : await supabase.rpc("submit_my_employee_work_schedule_change_request", {
        p_requested_working_weekdays: input.workingWeekdays,
        p_reason: input.reason,
      });
  if (error) throw new WorkSchedulePublicError(safeMessage(error, SAVE_ERROR));
}

export async function decideEmployeeWorkScheduleChange(input: {
  requestId: string;
  decision: "approved" | "declined";
  reason: string;
}) {
  const supabase = await authenticatedClient(DECISION_ERROR);
  if (!UUID_PATTERN.test(input.requestId)) throw new WorkSchedulePublicError(DECISION_ERROR);
  const { error } = await supabase.rpc("decide_employee_work_schedule_change_request", {
    p_request_id: input.requestId,
    p_decision: input.decision,
    p_reason: input.reason,
  });
  if (error) throw new WorkSchedulePublicError(safeMessage(error, DECISION_ERROR));
}
