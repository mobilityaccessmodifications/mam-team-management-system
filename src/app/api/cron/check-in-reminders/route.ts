import { timingSafeEqual } from "node:crypto";

import { getCheckInResourceLinks } from "@/lib/check-in-register";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const DELIVERY_BATCH_LIMIT = 10;

type ClaimedReminder = {
  reminder_id: string;
  claim_token: string;
};

type PreparedReminder = {
  reminder_id: string;
  employee_first_name: string;
  employee_last_name: string;
  employee_work_email: string | null;
  employee_personal_email: string | null;
  role: string;
  department: string;
  manager_name: string;
  manager_email: string;
  milestone: string;
  reminder_sequence: string;
  due_date: string;
  notify_date: string;
};

type DeliveryMode = "test" | "live";

type DeliveryConfiguration = {
  webhookUrl: URL;
  webhookSecret: string;
  mode: DeliveryMode;
  resources: {
    managerGuideUrl: string;
    checkInFormUrl: string;
    probationTemplatesUrl: string;
  };
};

function configuredDeliveryMode(): DeliveryMode | null {
  const configured = process.env.CHECK_IN_EMAIL_MODE?.trim().toLowerCase();
  if (configured === "marketing-test") return "test";
  if (configured === "live") return "live";
  return null;
}

function safeExactOrigin(value: string | undefined) {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function safeWebhookUrl(value: string | undefined, allowedOrigin: string | null) {
  const candidate = value?.trim();
  if (!candidate || !allowedOrigin) return null;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:"
      || url.origin !== allowedOrigin
      || url.username
      || url.password
      || url.search
      || url.hash
      || url.pathname === "/"
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function workflowMilestone(value: string) {
  const labels: Record<string, string> = {
    "2_week": "2-week",
    "1_month": "1-month",
    "2_month": "2-month",
    "3_month": "3-month",
    "5_month": "5-month",
  };
  return labels[value] ?? null;
}

function deliveryConfiguration(mode: DeliveryMode): DeliveryConfiguration | null {
  const webhookSecret = process.env.N8N_CHECKIN_REMINDER_WEBHOOK_SECRET?.trim();
  const webhookOrigin = safeExactOrigin(process.env.N8N_CHECKIN_REMINDER_WEBHOOK_ORIGIN);
  const webhookUrl = safeWebhookUrl(process.env.N8N_CHECKIN_REMINDER_WEBHOOK_URL, webhookOrigin);
  const resources = getCheckInResourceLinks();

  if (
    !webhookSecret
    || !webhookUrl
    || !resources.managerGuideUrl
    || !resources.checkInFormUrl
    || !resources.probationTemplatesUrl
  ) {
    return null;
  }

  return {
    webhookUrl,
    webhookSecret,
    mode,
    resources: {
      managerGuideUrl: resources.managerGuideUrl,
      checkInFormUrl: resources.checkInFormUrl,
      probationTemplatesUrl: resources.probationTemplatesUrl,
    },
  };
}

function normalizedEmail(value: unknown) {
  if (value === null) return null;
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email) return null;
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

function hasValidCronSecret(request: Request, secret: string) {
  const candidate = request.headers.get("authorization");
  const expected = `Bearer ${secret}`;
  if (!candidate) return false;
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}

function isWithinMelbourneDeliveryWindow(now = new Date()) {
  const hour = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now).find((part) => part.type === "hour")?.value;
  const numericHour = Number(hour);
  // The daily scheduler runs at 08:00 Melbourne time. Keep claims inside the
  // local 08:00–16:59 delivery window so a missed run can be retried safely
  // later that same business day.
  return Number.isInteger(numericHour) && numericHour >= 8 && numericHour < 17;
}

function isClaimedReminder(value: unknown): value is ClaimedReminder {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.reminder_id === "string"
    && typeof row.claim_token === "string"
    && UUID_PATTERN.test(row.reminder_id)
    && UUID_PATTERN.test(row.claim_token);
}

function preparedReminder(value: unknown): PreparedReminder | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const employeeWorkEmail = normalizedEmail(row.employee_work_email);
  const employeePersonalEmail = normalizedEmail(row.employee_personal_email);
  if (
    typeof row.reminder_id !== "string"
    || !UUID_PATTERN.test(row.reminder_id)
    || typeof row.employee_first_name !== "string"
    || typeof row.employee_last_name !== "string"
    || typeof row.role !== "string"
    || typeof row.department !== "string"
    || typeof row.manager_name !== "string"
    || typeof row.manager_email !== "string"
    || typeof row.milestone !== "string"
    || typeof row.reminder_sequence !== "string"
    || typeof row.due_date !== "string"
    || typeof row.notify_date !== "string"
  ) return null;
  if (["2_week", "1_month", "2_month", "3_month"].includes(row.milestone) && !employeeWorkEmail && !employeePersonalEmail) return null;
  if (
    !row.employee_first_name.trim()
    || !row.employee_last_name.trim()
    || !row.role.trim()
    || !row.department.trim()
    || !row.manager_name.trim()
    || !row.manager_email.trim()
  ) return null;

  return {
    reminder_id: row.reminder_id,
    employee_first_name: row.employee_first_name,
    employee_last_name: row.employee_last_name,
    employee_work_email: employeeWorkEmail,
    employee_personal_email: employeePersonalEmail,
    role: row.role,
    department: row.department,
    manager_name: row.manager_name,
    manager_email: row.manager_email,
    milestone: row.milestone,
    reminder_sequence: row.reminder_sequence,
    due_date: row.due_date,
    notify_date: row.notify_date,
  };
}

function providerFailureCode(response: Response) {
  if (response.status === 408 || response.status === 504) return "provider_timeout";
  if (response.status >= 400 && response.status < 500) return "provider_rejected";
  return "network_error";
}

async function markFailed(
  supabase: ReturnType<typeof createAdminClient>,
  reminderId: string,
  claimToken: string,
  code: "network_error" | "provider_timeout" | "provider_rejected" | "invalid_response" | "configuration_error",
) {
  const result = await supabase.rpc("fail_employee_check_in_reminder_delivery", {
    p_reminder_id: reminderId,
    p_claim_token: claimToken,
    p_error_code: code,
  });
  if (result.error) throw new Error("Reminder retry could not be recorded.");
}

/**
 * A CRON_SECRET-gated, fail-closed dispatcher. Database functions claim and
 * revalidate each delivery; this handler never queries private HR tables or
 * accepts a recipient/email body from the request.
 */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret || !hasValidCronSecret(request, cronSecret)) {
    return Response.json({ ok: false, code: "unauthorized" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  if (!isWithinMelbourneDeliveryWindow()) {
    return Response.json({ ok: true, code: "outside_delivery_window", claimed: 0, sent: 0, failed: 0 }, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const deliveryMode = configuredDeliveryMode();
  if (!deliveryMode) {
    return Response.json({ ok: true, code: "delivery_disabled", claimed: 0, sent: 0, failed: 0 }, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const configuration = deliveryConfiguration(deliveryMode);
  if (!configuration) {
    return Response.json({ ok: false, code: "not_configured" }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const supabase = createAdminClient();
  const { data: claimedData, error: claimError } = await supabase
    // Deliver a bounded batch concurrently. Each claim is token-bound and the
    // provider request is idempotent, so one slow receiver does not throttle
    // every other reminder in the backlog.
    .rpc("claim_due_employee_check_in_reminders", { p_limit: DELIVERY_BATCH_LIMIT });
  if (claimError || !Array.isArray(claimedData)) {
    return Response.json({ ok: false, code: "claim_failed" }, {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }

  let sent = 0;
  let failed = 0;
  let acceptedPendingFinalisation = 0;

  const outcomes = await Promise.allSettled(claimedData.map(async (candidate) => {
    if (!isClaimedReminder(candidate)) {
      failed += 1;
      return;
    }

    // Preparation re-resolves the latest manager and creates the immutable,
    // short-lived authorization snapshot for this claimed delivery. Database
    // sync intentionally preserves that token until finalisation or timeout.
    const { data: preparedData, error: preparedError } = await supabase
      .rpc("prepare_employee_check_in_reminder_delivery", {
        p_reminder_id: candidate.reminder_id,
        p_claim_token: candidate.claim_token,
      });
    const payload = Array.isArray(preparedData) ? preparedReminder(preparedData[0]) : null;
    if (preparedError || !payload) {
      // A valid-but-now-stale claim is transitioned to needs_review by the
      // token-bound prepare RPC. If an unexpected malformed DTO or RPC
      // failure occurs, release the matching claim through the same
      // allow-listed failure path rather than leaving it stranded for 30 min.
      await markFailed(supabase, candidate.reminder_id, candidate.claim_token, "configuration_error");
      failed += 1;
      return;
    }

    const milestone = workflowMilestone(payload.milestone);
    if (!milestone || (payload.reminder_sequence !== "initial" && payload.reminder_sequence !== "final")) {
      await markFailed(supabase, payload.reminder_id, candidate.claim_token, "configuration_error");
      failed += 1;
      return;
    }

    let response: Response;
    const deliveryId = `checkin:${payload.reminder_id}:${milestone}:${payload.reminder_sequence}:${configuration.mode}`;
    try {
      response = await fetch(configuration.webhookUrl, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          "Content-Type": "application/json",
          "X-MAM-Check-In-Webhook-Secret": configuration.webhookSecret,
          // Stable across stale-claim recovery; it is never the random claim token.
          "Idempotency-Key": deliveryId,
        },
        body: JSON.stringify({
          version: 1,
          event: "checkin-reminder",
          mode: configuration.mode,
          deliveryId,
          employee: {
            firstName: payload.employee_first_name,
            lastName: payload.employee_last_name,
            role: payload.role,
            department: payload.department,
            workEmail: payload.employee_work_email,
            personalEmail: payload.employee_personal_email,
          },
          manager: {
            name: payload.manager_name,
            email: payload.manager_email,
          },
          milestone,
          dueDate: payload.due_date,
          reminder: payload.reminder_sequence,
          resources: configuration.resources,
        }),
      });
    } catch (error) {
      const code = error instanceof DOMException && error.name === "TimeoutError"
        ? "provider_timeout"
        : "network_error";
      await markFailed(supabase, payload.reminder_id, candidate.claim_token, code);
      failed += 1;
      return;
    }

    if (!response.ok) {
      await markFailed(supabase, payload.reminder_id, candidate.claim_token, providerFailureCode(response));
      failed += 1;
      return;
    }

    const responseBody = await response.json().catch(() => null) as unknown;
    const result = responseBody && typeof responseBody === "object" && !Array.isArray(responseBody)
      ? responseBody as Record<string, unknown>
      : null;
    const accepted = result?.ok === true
      && result.deliveryId === deliveryId
      && (result.sent === true || result.alreadySent === true);
    if (!accepted) {
      await markFailed(supabase, payload.reminder_id, candidate.claim_token, "invalid_response");
      failed += 1;
      return;
    }

    const { data: completionData, error: completionError } = await supabase.rpc("complete_employee_check_in_reminder_delivery", {
      p_reminder_id: payload.reminder_id,
      p_claim_token: candidate.claim_token,
      // n8n's durable delivery ID is the idempotency key. The database keeps
      // no provider response body or recipient metadata.
      p_provider_delivery_id: deliveryId,
    });
    if (completionError || completionData !== true) {
      // n8n has accepted the deterministic ID. Keep the claim for stale-claim
      // recovery so the provider deduplicates instead of sending a duplicate.
      acceptedPendingFinalisation += 1;
    } else {
      sent += 1;
    }
  }));

  failed += outcomes.filter((outcome) => outcome.status === "rejected").length;
  const ok = failed === 0 && acceptedPendingFinalisation === 0;
  return Response.json({
    ok,
    claimed: claimedData.length,
    sent,
    failed,
    acceptedPendingFinalisation,
    backlogLikely: claimedData.length === DELIVERY_BATCH_LIMIT,
  }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
