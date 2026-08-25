import type {
  CheckInTask,
  CheckInTaskCompany,
  CheckInTaskMilestone,
  CheckInTasksData,
  CheckInTaskStatus,
} from "@/lib/check-in-tasks-types";

type CheckInTaskReminderRpcRow = {
  id?: unknown;
  milestone?: unknown;
  sequence?: unknown;
  dueDate?: unknown;
  status?: unknown;
  needsReviewReason?: unknown;
};

type CheckInTaskRpcRow = {
  person_id?: unknown;
  full_name?: unknown;
  position_title?: unknown;
  company_key?: unknown;
  reminders?: unknown;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CHECK_IN_TASK_LOAD_ERROR = "Check-in tasks could not be loaded. Refresh and try again.";

function requiredText(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new Error(CHECK_IN_TASK_LOAD_ERROR);
  return value.trim();
}

function optionalText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function uuid(value: unknown) {
  const result = requiredText(value);
  if (!UUID_PATTERN.test(result)) throw new Error(CHECK_IN_TASK_LOAD_ERROR);
  return result;
}

function isoDate(value: unknown) {
  const result = requiredText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Error(CHECK_IN_TASK_LOAD_ERROR);
  const parsed = new Date(`${result}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new Error(CHECK_IN_TASK_LOAD_ERROR);
  }
  return result;
}

function company(value: unknown): CheckInTaskCompany {
  if (value === "mam" || value === "equipsy") return value;
  throw new Error(CHECK_IN_TASK_LOAD_ERROR);
}

function milestone(value: unknown): CheckInTaskMilestone {
  if (value === "2_week" || value === "1_month" || value === "3_month" || value === "5_month") return value;
  throw new Error(CHECK_IN_TASK_LOAD_ERROR);
}

function status(value: unknown): CheckInTaskStatus | "completed" | "cancelled" | "superseded" {
  if (
    value === "scheduled"
    || value === "claimed"
    || value === "delivered"
    || value === "needs_review"
    || value === "completed"
    || value === "cancelled"
    || value === "superseded"
  ) {
    return value;
  }
  throw new Error(CHECK_IN_TASK_LOAD_ERROR);
}

function todayIsoDate() {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (!year || !month || !day) throw new Error(CHECK_IN_TASK_LOAD_ERROR);
  return `${year}-${month}-${day}`;
}

function canCompleteTask(dueDate: string, taskStatus: CheckInTaskStatus) {
  return dueDate <= todayIsoDate()
    && (taskStatus === "scheduled" || taskStatus === "delivered" || taskStatus === "needs_review");
}

function tasksForRow(row: CheckInTaskRpcRow): CheckInTask[] {
  const personId = uuid(row.person_id);
  const employeeName = requiredText(row.full_name);
  const positionTitle = optionalText(row.position_title);
  const taskCompany = company(row.company_key);
  if (!Array.isArray(row.reminders)) throw new Error(CHECK_IN_TASK_LOAD_ERROR);

  return row.reminders.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(CHECK_IN_TASK_LOAD_ERROR);
    const reminder = value as CheckInTaskReminderRpcRow;
    const sequence = reminder.sequence;
    const taskStatus = status(reminder.status);

    if (
      sequence !== "initial"
      || taskStatus === "completed"
      || taskStatus === "cancelled"
      || taskStatus === "superseded"
    ) {
      return [];
    }

    const dueDate = isoDate(reminder.dueDate);
    return [{
      reminderId: uuid(reminder.id),
      personId,
      employeeName,
      positionTitle,
      company: taskCompany,
      dueDate,
      milestone: milestone(reminder.milestone),
      status: taskStatus,
      needsReviewReason: optionalText(reminder.needsReviewReason) || null,
      canComplete: canCompleteTask(dueDate, taskStatus),
    }];
  });
}

/** Validates the narrow, manager-safe RPC projection in either browser or server code. */
export function parseCheckInTasks(data: unknown): CheckInTasksData {
  if (!Array.isArray(data)) throw new Error(CHECK_IN_TASK_LOAD_ERROR);
  return {
    tasks: (data as CheckInTaskRpcRow[])
      .flatMap(tasksForRow)
      .sort((first, second) => {
        const due = first.dueDate.localeCompare(second.dueDate);
        if (due) return due;
        const employee = first.employeeName.localeCompare(second.employeeName);
        return employee || first.milestone.localeCompare(second.milestone);
      }),
  };
}
