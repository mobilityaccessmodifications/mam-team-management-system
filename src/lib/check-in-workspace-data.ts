import type {
  CheckInWorkspaceData,
  CheckInWorkspaceRecord,
  CheckInWorkspaceReminder,
} from "@/lib/check-in-register-types";

type CheckInWorkspaceReminderRpcRow = {
  id?: unknown;
  milestone?: unknown;
  sequence?: unknown;
  dueDate?: unknown;
  status?: unknown;
};

type CheckInWorkspaceRpcRow = {
  person_id?: unknown;
  full_name?: unknown;
  position_title?: unknown;
  company_key?: unknown;
  start_date?: unknown;
  reminders?: unknown;
};

export const CHECK_IN_WORKSPACE_LOAD_ERROR = "Check-ins could not be loaded. Refresh and try again.";

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function requiredText(value: unknown) {
  const result = text(value).trim();
  if (!result) throw new Error(CHECK_IN_WORKSPACE_LOAD_ERROR);
  return result;
}

function company(value: unknown): CheckInWorkspaceRecord["company"] {
  if (value === "mam" || value === "equipsy") return value;
  throw new Error(CHECK_IN_WORKSPACE_LOAD_ERROR);
}

function reminderStatus(value: unknown): CheckInWorkspaceReminder["status"] {
  if (value === "scheduled" || value === "claimed" || value === "delivered" || value === "completed" || value === "needs_review") {
    return value;
  }
  throw new Error(CHECK_IN_WORKSPACE_LOAD_ERROR);
}

function workspaceReminders(value: unknown): CheckInWorkspaceReminder[] {
  if (!Array.isArray(value)) throw new Error(CHECK_IN_WORKSPACE_LOAD_ERROR);
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(CHECK_IN_WORKSPACE_LOAD_ERROR);
    const row = item as CheckInWorkspaceReminderRpcRow;
    if (
      row.milestone !== "2_week"
      && row.milestone !== "1_month"
      && row.milestone !== "3_month"
      && row.milestone !== "5_month"
    ) {
      throw new Error(CHECK_IN_WORKSPACE_LOAD_ERROR);
    }
    if (row.sequence !== "initial" && row.sequence !== "final") throw new Error(CHECK_IN_WORKSPACE_LOAD_ERROR);
    return {
      id: requiredText(row.id),
      milestone: row.milestone as CheckInWorkspaceReminder["milestone"],
      sequence: row.sequence,
      dueDate: requiredText(row.dueDate),
      status: reminderStatus(row.status),
    };
  });
}

function toWorkspaceRecord(row: CheckInWorkspaceRpcRow): CheckInWorkspaceRecord {
  return {
    personId: requiredText(row.person_id),
    fullName: requiredText(row.full_name),
    positionTitle: text(row.position_title),
    company: company(row.company_key),
    startDate: text(row.start_date),
    reminders: workspaceReminders(row.reminders),
  };
}

/** Validates the manager-safe Check-in projection in browser or server code. */
export function parseCheckInWorkspaceRecords(data: unknown): CheckInWorkspaceData["records"] {
  if (!Array.isArray(data)) throw new Error(CHECK_IN_WORKSPACE_LOAD_ERROR);
  return (data as CheckInWorkspaceRpcRow[])
    .map(toWorkspaceRecord)
    .sort((first, second) => first.fullName.localeCompare(second.fullName));
}
