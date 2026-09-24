import "server-only";

import { requireEmployeeDirectoryManager } from "@/lib/employee-directory";
import { createClient } from "@/lib/supabase/server";
import type { CheckInResourceLinks } from "@/lib/check-in-register-types";

const SESSION_ERROR = "Your session has expired. Sign in again.";

async function requireAuthenticatedClient() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error(SESSION_ERROR);
  return supabase;
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
    canApproveEmploymentDecisions: false,
  };
}

export async function completeCheckInReminderForHr(reminderId: string) {
  const { supabase } = await requireEmployeeDirectoryManager();
  const { error } = await supabase.rpc("complete_employee_check_in_reminder", { p_reminder_id: reminderId });
  if (error) throw new Error("The check-in could not be marked complete. Refresh and try again.");
}

export async function completeVisibleCheckInReminder(reminderId: string) {
  const supabase = await requireAuthenticatedClient();
  const { error } = await supabase.rpc("complete_visible_employee_check_in_reminder", {
    p_reminder_id: reminderId,
  });
  if (error) throw new Error("The check-in could not be marked complete. Refresh and try again.");
}

export type RecordCheckInReviewInput = {
  reminderId: string;
  outcome: "on_track" | "follow_up_required" | "hr_review_required" | "probation_extension_pending_hr" | "non_confirmation_pending_hr";
  reviewDate: string;
  notes: string;
  expectedVersion: number | null;
};

export async function recordVisibleEmployeeCheckInReview(input: RecordCheckInReviewInput) {
  const supabase = await requireAuthenticatedClient();
  const { error } = await supabase.rpc("record_employee_check_in_review", {
    p_reminder_id: input.reminderId,
    p_outcome_code: input.outcome,
    p_review_date: input.reviewDate,
    p_notes: input.notes,
    p_expected_version: input.expectedVersion,
  });
  if (!error) return;
  if (error.code === "40001") throw new Error("This outcome was updated elsewhere. Refresh and try again.");
  if (error.code === "42501") throw new Error("You no longer have access to update this check-in.");
  if (error.code === "22023" || error.code === "22001") throw new Error(error.message);
  throw new Error("The review outcome could not be saved. Refresh and try again.");
}

export async function approveVisibleEmployeeCheckInEmploymentDecision(input: {
  reminderId: string;
  expectedVersion: number;
}) {
  const supabase = await requireAuthenticatedClient();
  const { error } = await supabase.rpc("approve_employee_check_in_employment_decision", {
    p_reminder_id: input.reminderId,
    p_expected_review_version: input.expectedVersion,
  });
  if (!error) return;
  if (error.code === "40001") throw new Error("This review changed. Refresh and try again.");
  if (error.code === "42501") throw new Error("Only People & Culture can approve this employment decision.");
  if (error.code === "22023") throw new Error(error.message);
  throw new Error("The employment decision could not be approved. Refresh and try again.");
}
