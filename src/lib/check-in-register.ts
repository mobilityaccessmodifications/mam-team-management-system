import "server-only";

import { requireEmployeeDirectoryManager } from "@/lib/employee-directory";
import { parseCheckInWorkspaceRecords } from "@/lib/check-in-workspace-data";
import { createClient } from "@/lib/supabase/server";
import type {
  CheckInEnrolmentMode,
  CheckInRegisterData,
  CheckInRegisterRecord,
  CheckInReminder,
  CheckInReminderStatus,
  CheckInResourceLinks,
  CheckInWorkspaceData,
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
};

type CheckInRegisterRpcRow = {
  person_id: unknown;
  company_key: unknown;
  first_name: unknown;
  last_name: unknown;
  role: unknown;
  department: unknown;
  manager_name: unknown;
  address: unknown;
  date_of_birth: unknown;
  mobile: unknown;
  email: unknown;
  start_date: unknown;
  recipient_email: unknown;
  recipient_source: unknown;
  enrolment_mode: unknown;
  reminders: unknown;
};

const LOAD_ERROR = "Employee check-in records could not be loaded. Refresh and try again.";
const SESSION_ERROR = "Your session has expired. Sign in again.";

async function requireAuthenticatedClient() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error(SESSION_ERROR);
  return supabase;
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function emailText(value: unknown) {
  // Email addresses cannot contain whitespace. Remove accidental line breaks
  // from imported records so neither the display nor reminder recipient splits.
  return text(value).replace(/\s+/g, "");
}

function nullableText(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function requiredText(value: unknown) {
  const result = text(value);
  if (!result) throw new Error(LOAD_ERROR);
  return result;
}

function company(value: unknown): CheckInRegisterRecord["company"] {
  if (value === "mam" || value === "equipsy") return value;
  throw new Error(LOAD_ERROR);
}

function enrolmentMode(value: unknown): CheckInEnrolmentMode {
  if (value === "automatic" || value === "needs_review") return value;
  throw new Error(LOAD_ERROR);
}

function reminderStatus(value: unknown): CheckInReminderStatus {
  if (value === "scheduled" || value === "claimed" || value === "delivered" || value === "completed" || value === "needs_review") {
    return value;
  }
  throw new Error(LOAD_ERROR);
}

function reminder(row: CheckInReminderRpcRow): CheckInReminder {
  const milestone = row.milestone;
  const sequence = row.sequence;
  if (!["2_week", "1_month", "3_month", "5_month"].includes(String(milestone))) throw new Error(LOAD_ERROR);
  if (sequence !== "initial" && sequence !== "final") throw new Error(LOAD_ERROR);

  return {
    id: requiredText(row.id),
    milestone: milestone as CheckInReminder["milestone"],
    sequence,
    dueDate: requiredText(row.dueDate),
    notifyDate: requiredText(row.notifyDate),
    status: reminderStatus(row.status),
    deliveredAt: nullableText(row.deliveredAt),
    completedAt: nullableText(row.completedAt),
    lastDeliveryErrorAt: nullableText(row.lastDeliveryErrorAt),
    needsReviewReason: nullableText(row.needsReviewReason),
  };
}

function reminders(value: unknown) {
  if (!Array.isArray(value)) throw new Error(LOAD_ERROR);
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(LOAD_ERROR);
    return reminder(item as CheckInReminderRpcRow);
  });
}

function toRecord(row: CheckInRegisterRpcRow): CheckInRegisterRecord {
  const recipientSource = row.recipient_source;
  if (recipientSource !== "manager_work_email" && recipientSource !== "missing") throw new Error(LOAD_ERROR);
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
    email: emailText(row.email),
    startDate: text(row.start_date),
    recipientEmail: emailText(row.recipient_email),
    recipientSource,
    enrolmentMode: enrolmentMode(row.enrolment_mode),
    reminders: reminders(row.reminders),
  };
}

function safeHttpsUrl(value: string | undefined) {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeUrlAtOrigin(value: string | undefined, origin: string | null) {
  if (!origin) return null;
  const candidate = safeHttpsUrl(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.origin === origin
      && !url.username
      && !url.password
      && !url.port
      ? candidate
      : null;
  } catch {
    return null;
  }
}

function safeExactHttpsOrigin(value: string | undefined) {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function configuredCheckInWebhook() {
  const origin = safeExactHttpsOrigin(process.env.N8N_CHECKIN_REMINDER_WEBHOOK_ORIGIN);
  const webhook = safeHttpsUrl(process.env.N8N_CHECKIN_REMINDER_WEBHOOK_URL);
  if (!origin || !webhook) return null;
  try {
    const url = new URL(webhook);
    return url.origin === origin && !url.username && !url.password && !url.search && !url.hash && url.pathname !== "/"
      ? url
      : null;
  } catch {
    return null;
  }
}

/** Safe HR-facing links; values are not secrets and remain access-controlled by SharePoint. */
export function getCheckInResourceLinks(): CheckInResourceLinks {
  // These direct links are emailed to managers. The deployment supplies one
  // exact trusted origin so tenant moves do not require a source-code change.
  const resourceOrigin = safeExactHttpsOrigin(process.env.CHECK_IN_RESOURCE_ORIGIN);
  const managerGuideUrl = safeUrlAtOrigin(process.env.CHECK_IN_MANAGER_GUIDE_URL, resourceOrigin);
  const checkInFormUrl = safeUrlAtOrigin(process.env.CHECK_IN_FORM_URL, resourceOrigin);
  const probationTemplatesUrl = safeUrlAtOrigin(process.env.CHECK_IN_PROBATION_TEMPLATES_URL, resourceOrigin);
  const legacyFormsFolderUrl = safeUrlAtOrigin(process.env.CHECK_IN_LEGACY_FORMS_FOLDER_URL, resourceOrigin);
  const deliveryConfigured = Boolean(
    managerGuideUrl
    && checkInFormUrl
    && probationTemplatesUrl
    && configuredCheckInWebhook()
    && process.env.N8N_CHECKIN_REMINDER_WEBHOOK_SECRET?.trim()
    && process.env.CRON_SECRET?.trim(),
  );

  return {
    managerGuideUrl,
    checkInFormUrl,
    probationTemplatesUrl,
    legacyFormsFolderUrl,
    deliveryConfigured,
  };
}

export async function getCheckInRegisterForHr(): Promise<CheckInRegisterData> {
  const { supabase } = await requireEmployeeDirectoryManager();
  const { data, error } = await supabase.rpc("list_employee_check_in_register");
  if (error || !Array.isArray(data)) throw new Error(LOAD_ERROR);

  return {
    records: (data as CheckInRegisterRpcRow[])
      .map(toRecord)
      .sort((first, second) => `${first.lastName} ${first.firstName}`.localeCompare(`${second.lastName} ${second.firstName}`)),
    resources: getCheckInResourceLinks(),
  };
}

export async function completeCheckInReminderForHr(reminderId: string) {
  const { supabase } = await requireEmployeeDirectoryManager();
  const { error } = await supabase.rpc("complete_employee_check_in_reminder", { p_reminder_id: reminderId });
  if (error) throw new Error("The check-in could not be marked complete. Refresh and try again.");
}

export async function getVisibleCheckInWorkspace(): Promise<CheckInWorkspaceData> {
  const supabase = await requireAuthenticatedClient();
  const { data, error } = await supabase.rpc("list_employee_check_in_workspace");
  if (error || !Array.isArray(data)) throw new Error(LOAD_ERROR);

  const resources = getCheckInResourceLinks();
  return {
    records: parseCheckInWorkspaceRecords(data),
    resources: {
      managerGuideUrl: resources.managerGuideUrl,
      checkInFormUrl: resources.checkInFormUrl,
      probationTemplatesUrl: resources.probationTemplatesUrl,
    },
  };
}

/**
 * Change Profile projection. The database requires the caller to be the real
 * System Admin and evaluates the selected person's live manager/global scope;
 * any later mutation is independently authorised as that System Admin.
 */
export async function getVisibleCheckInWorkspaceForPreview(personId: string): Promise<CheckInWorkspaceData> {
  const supabase = await requireAuthenticatedClient();
  const { data, error } = await supabase.rpc("list_employee_check_in_workspace_for_preview", {
    p_person_id: personId,
  });
  if (error || !Array.isArray(data)) throw new Error(LOAD_ERROR);

  const resources = getCheckInResourceLinks();
  return {
    records: parseCheckInWorkspaceRecords(data),
    resources: {
      managerGuideUrl: resources.managerGuideUrl,
      checkInFormUrl: resources.checkInFormUrl,
      probationTemplatesUrl: resources.probationTemplatesUrl,
    },
  };
}

export async function completeVisibleCheckInReminder(reminderId: string) {
  const supabase = await requireAuthenticatedClient();
  const { error } = await supabase.rpc("complete_visible_employee_check_in_reminder", {
    p_reminder_id: reminderId,
  });
  if (error) throw new Error("The check-in could not be marked complete. Refresh and try again.");
}
