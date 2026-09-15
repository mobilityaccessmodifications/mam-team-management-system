import { createHash, timingSafeEqual } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PAYROLL_BATCH_LIMIT = 10;

type AdminClient = ReturnType<typeof createAdminClient>;
type WebhookConfiguration = { url: URL; secret: string };
type DeliverySummary = {
  ok: boolean;
  claimed: number;
  sent: number;
  failed: number;
  code?: "claim_failed";
  notRequired?: number;
  acceptedPendingFinalisation?: number;
};

type ClaimedPayrollReminder = {
  reminder_id: string;
  claim_token: string;
};

type PreparedPayrollReminder = {
  reminder_id: string;
  delivery_required: boolean;
  recipient_name: string | null;
  recipient_email: string | null;
  reminder_month: string;
  missing_companies: ("mam" | "equipsy")[];
};

function response(body: object, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function hasValidCronSecret(request: Request, secret: string) {
  const expected = Buffer.from(`Bearer ${secret}`);
  const provided = Buffer.from(request.headers.get("authorization") ?? "");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function isWithinMelbourneDeliveryWindow(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    hour: "numeric",
    hourCycle: "h23",
  }).format(now));
  return Number.isInteger(hour) && hour >= 7 && hour < 17;
}

function webhookConfiguration(): WebhookConfiguration | null {
  const secret = process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET?.trim();
  try {
    const url = new URL(process.env.MAM_N8N_LEAVE_WEBHOOK_URL ?? "");
    const origin = new URL(process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN ?? "");
    if (
      !secret
      || url.protocol !== "https:"
      || url.origin !== origin.origin
      || origin.pathname !== "/"
      || origin.username
      || origin.password
      || origin.search
      || origin.hash
      || url.username
      || url.password
      || url.search
      || url.hash
      || url.pathname === "/"
    ) return null;
    return { url, secret };
  } catch {
    return null;
  }
}

function isClaimedPayrollReminder(value: unknown): value is ClaimedPayrollReminder {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.reminder_id === "string"
    && typeof row.claim_token === "string"
    && UUID_PATTERN.test(row.reminder_id)
    && UUID_PATTERN.test(row.claim_token);
}

function preparedPayrollReminder(value: unknown): PreparedPayrollReminder | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const missingCompanies = row.missing_companies;
  if (
    typeof row.reminder_id !== "string"
    || !UUID_PATTERN.test(row.reminder_id)
    || typeof row.delivery_required !== "boolean"
    || typeof row.reminder_month !== "string"
    || !DATE_PATTERN.test(row.reminder_month)
    || !row.reminder_month.endsWith("-01")
    || !Array.isArray(missingCompanies)
    || missingCompanies.some((company) => company !== "mam" && company !== "equipsy")
    || new Set(missingCompanies).size !== missingCompanies.length
  ) return null;

  if (!row.delivery_required) {
    if (missingCompanies.length !== 0) return null;
    return {
      reminder_id: row.reminder_id,
      delivery_required: false,
      recipient_name: null,
      recipient_email: null,
      reminder_month: row.reminder_month,
      missing_companies: [],
    };
  }

  if (
    typeof row.recipient_name !== "string"
    || row.recipient_name !== row.recipient_name.trim()
    || !row.recipient_name
    || row.recipient_name.length > 80
    || /[\u0000-\u001f\u007f]/.test(row.recipient_name)
    || typeof row.recipient_email !== "string"
    || row.recipient_email !== row.recipient_email.trim().toLowerCase()
    || row.recipient_email.length > 254
    || !EMAIL_PATTERN.test(row.recipient_email)
    || missingCompanies.length < 1
    || missingCompanies.length > 2
  ) return null;

  return {
    reminder_id: row.reminder_id,
    delivery_required: true,
    recipient_name: row.recipient_name,
    recipient_email: row.recipient_email,
    reminder_month: row.reminder_month,
    missing_companies: missingCompanies,
  };
}

function providerFailureCode(providerResponse: Response) {
  if (providerResponse.status === 408 || providerResponse.status === 504) return "provider_timeout";
  if (providerResponse.status >= 400 && providerResponse.status < 500) return "provider_rejected";
  return "network_error";
}

async function markPayrollReminderFailed(
  admin: AdminClient,
  reminderId: string,
  claimToken: string,
  code: "network_error" | "provider_timeout" | "provider_rejected" | "invalid_response" | "configuration_error",
) {
  await admin.rpc("fail_payroll_balance_email_reminder_delivery", {
    p_reminder_id: reminderId,
    p_claim_token: claimToken,
    p_error_code: code,
  });
}

async function dispatchLeavePriorityReminders(
  admin: AdminClient,
  configuration: WebhookConfiguration,
): Promise<DeliverySummary> {
  const { data, error } = await admin.rpc("claim_leave_priority_reminders", { p_limit: 100 });
  if (error || !Array.isArray(data)) {
    return { ok: false, code: "claim_failed", claimed: 0, sent: 0, failed: 1 };
  }

  let sent = 0;
  let failed = 0;
  // Bounded groups avoid overloading the provider while keeping the daily run short.
  for (let offset = 0; offset < data.length; offset += 10) {
    await Promise.all(data.slice(offset, offset + 10).map(async (reminder) => {
      if (
        typeof reminder.manager_email !== "string"
        || !reminder.manager_email
        || reminder.manager_email.split(",").length > 10
        || !reminder.manager_email.split(",").every((email: string) => email.length <= 254 && EMAIL_PATTERN.test(email))
      ) {
        failed += 1;
        return;
      }
      const eventKey = `leave:${reminder.source_id}:${reminder.event}:${createHash("sha256").update(reminder.delivery_id).digest("hex").slice(0, 24)}`;
      try {
        const providerResponse = await fetch(configuration.url, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: {
            "Content-Type": "application/json",
            "X-MAM-Notification-Secret": configuration.secret,
          },
          body: JSON.stringify({
            version: 1,
            event: reminder.event,
            eventKey,
            requestId: reminder.source_id,
            employeeName: reminder.employee_name,
            employeeEmail: null,
            employeeEmails: [],
            company: reminder.company,
            leaveType: reminder.leave_type,
            startDate: reminder.start_date,
            endDate: reminder.end_date,
            startTime: null,
            endTime: null,
            days: null,
            hours: null,
            status: reminder.status,
            employeeNote: null,
            managerNote: null,
            managerEmail: reminder.manager_email,
            ccEmails: reminder.event === "leave-reminder" ? [] : ["hr@mobilityaccess.com.au"],
            wasApproved: false,
          }),
        });
        const receipt = await providerResponse.json().catch(() => null) as Record<string, unknown> | null;
        if (
          !providerResponse.ok
          || receipt?.ok !== true
          || !(receipt.sent === true || receipt.alreadySent === true)
          || receipt.eventKey !== eventKey
          || String(receipt.actualRecipient).toLowerCase() !== reminder.manager_email.toLowerCase()
        ) {
          failed += 1;
          return;
        }
        const finished = await admin.rpc("complete_leave_priority_reminder", {
          p_delivery_id: reminder.delivery_id,
          p_claim_token: reminder.claim_token,
        });
        if (finished.error || finished.data !== true) failed += 1;
        else sent += 1;
      } catch {
        failed += 1;
      }
    }));
  }
  return { ok: failed === 0, claimed: data.length, sent, failed };
}

async function dispatchPayrollBalanceEmailReminders(
  admin: AdminClient,
  configuration: WebhookConfiguration,
): Promise<DeliverySummary> {
  const { data, error } = await admin.rpc("claim_due_payroll_balance_email_reminders", {
    p_limit: PAYROLL_BATCH_LIMIT,
  });
  if (error || !Array.isArray(data)) {
    return { ok: false, code: "claim_failed", claimed: 0, sent: 0, failed: 1, notRequired: 0, acceptedPendingFinalisation: 0 };
  }

  let sent = 0;
  let failed = 0;
  let notRequired = 0;
  let acceptedPendingFinalisation = 0;

  await Promise.all(data.map(async (candidate) => {
    if (!isClaimedPayrollReminder(candidate)) {
      failed += 1;
      return;
    }

    const { data: preparedData, error: preparedError } = await admin.rpc(
      "prepare_payroll_balance_email_reminder_delivery",
      {
        p_reminder_id: candidate.reminder_id,
        p_claim_token: candidate.claim_token,
      },
    );
    const payload = Array.isArray(preparedData) ? preparedPayrollReminder(preparedData[0]) : null;
    if (preparedError || !payload) {
      await markPayrollReminderFailed(admin, candidate.reminder_id, candidate.claim_token, "configuration_error");
      failed += 1;
      return;
    }
    if (!payload.delivery_required) {
      notRequired += 1;
      return;
    }

    const eventKey = `payroll-balance:${payload.reminder_id}:${payload.reminder_month.slice(0, 7)}`;
    let providerResponse: Response;
    try {
      providerResponse = await fetch(configuration.url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          "Content-Type": "application/json",
          "X-MAM-Notification-Secret": configuration.secret,
          "Idempotency-Key": eventKey,
        },
        body: JSON.stringify({
          version: 1,
          event: "payroll-balance-reminder",
          eventKey,
          requestId: payload.reminder_id,
          recipientName: payload.recipient_name,
          recipientEmail: payload.recipient_email,
          reminderMonth: payload.reminder_month,
          missingCompanies: payload.missing_companies,
        }),
      });
    } catch (providerError) {
      const code = providerError instanceof DOMException && providerError.name === "TimeoutError"
        ? "provider_timeout"
        : "network_error";
      await markPayrollReminderFailed(admin, payload.reminder_id, candidate.claim_token, code);
      failed += 1;
      return;
    }

    if (!providerResponse.ok) {
      await markPayrollReminderFailed(
        admin,
        payload.reminder_id,
        candidate.claim_token,
        providerFailureCode(providerResponse),
      );
      failed += 1;
      return;
    }

    const responseBody = await providerResponse.json().catch(() => null) as unknown;
    const receipt = responseBody && typeof responseBody === "object" && !Array.isArray(responseBody)
      ? responseBody as Record<string, unknown>
      : null;
    if (
      receipt?.ok !== true
      || !(receipt.sent === true || receipt.alreadySent === true)
      || receipt.eventKey !== eventKey
      || String(receipt.actualRecipient).toLowerCase() !== payload.recipient_email
    ) {
      await markPayrollReminderFailed(admin, payload.reminder_id, candidate.claim_token, "invalid_response");
      failed += 1;
      return;
    }

    const completion = await admin.rpc("complete_payroll_balance_email_reminder_delivery", {
      p_reminder_id: payload.reminder_id,
      p_claim_token: candidate.claim_token,
      p_provider_delivery_id: eventKey,
    });
    if (completion.error || completion.data !== true) {
      // Keep the claim: the 30-minute n8n scheduler retry reuses eventKey, so
      // the receiver acknowledges the duplicate and the database can finish.
      acceptedPendingFinalisation += 1;
      failed += 1;
    } else {
      sent += 1;
    }
  }));

  return {
    ok: failed === 0,
    claimed: data.length,
    sent,
    failed,
    notRequired,
    acceptedPendingFinalisation,
  };
}

/**
 * The MAM n8n scheduler calls this route at 07:00 and 08:00 Melbourne time.
 * SQL enforces each leave/birthday window and the payroll outbox enforces the
 * first calendar day, current importer authority and month-level deduplication.
 */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret || !hasValidCronSecret(request, cronSecret)) {
    return response({ ok: false }, 401);
  }
  if (!isWithinMelbourneDeliveryWindow()) {
    return response({ ok: true, code: "outside_delivery_window" });
  }

  const configuration = webhookConfiguration();
  if (!configuration) {
    return response({ ok: false, code: "not_configured" }, 503);
  }

  const admin = createAdminClient();
  const leavePriority = await dispatchLeavePriorityReminders(admin, configuration);
  const payrollBalanceEmail = await dispatchPayrollBalanceEmailReminders(admin, configuration);
  const claimed = leavePriority.claimed + payrollBalanceEmail.claimed;
  const sent = leavePriority.sent + payrollBalanceEmail.sent;
  const failed = leavePriority.failed + payrollBalanceEmail.failed;
  const ok = leavePriority.ok && payrollBalanceEmail.ok;

  return response({
    ok,
    claimed,
    sent,
    failed,
    leavePriority,
    payrollBalanceEmail,
  }, ok ? 200 : 502);
}
