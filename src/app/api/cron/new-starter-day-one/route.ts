import { isUatMode } from "@/lib/uat-safety";
import { timingSafeEqual } from "node:crypto";

import { readCheckInDeliveryAck } from "@/lib/check-in-delivery-ack";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const DELIVERY_BATCH_LIMIT = 10;

type ClaimedReminder = { reminder_id: string; claim_token: string };
type DeliveryMode = "test" | "live";
type PreparedReminder = {
  reminder_id: string;
  employee_first_name: string;
  employee_work_email: string | null;
  employee_personal_email: string | null;
  role: string;
  company_key: "mam" | "equipsy";
  manager_first_name: string;
  manager_email: string;
  commencement_date: string;
  notify_date: string;
};
type DeliveryConfiguration = { webhookUrl: URL; webhookSecret: string; mode: DeliveryMode };

function safeExactOrigin(value: string | undefined) {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

function safeWebhookUrl(value: string | undefined, allowedOrigin: string | null) {
  const candidate = value?.trim();
  if (!candidate || !allowedOrigin) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.origin !== allowedOrigin || url.username || url.password
      || url.search || url.hash || url.pathname === "/") return null;
    return url;
  } catch { return null; }
}

function configuredDeliveryMode(): DeliveryMode | null {
  const configured = process.env.NEW_STARTER_DAY_ONE_EMAIL_MODE?.trim().toLowerCase();
  if (configured === "marketing-test") return "test";
  if (configured === "live") return "live";
  return null;
}

function deliveryConfiguration(mode: DeliveryMode): DeliveryConfiguration | null {
  const webhookSecret = process.env.N8N_CHECKIN_REMINDER_WEBHOOK_SECRET?.trim();
  const origin = safeExactOrigin(process.env.N8N_NEW_STARTER_WEBHOOK_ORIGIN);
  const webhookUrl = safeWebhookUrl(process.env.N8N_NEW_STARTER_WEBHOOK_URL, origin);
  if (!webhookSecret || webhookSecret.length < 32 || !webhookUrl) return null;
  return { webhookUrl, webhookSecret, mode };
}

function hasValidCronSecret(request: Request, secret: string) {
  const expected = Buffer.from(`Bearer ${secret}`);
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isWithinMelbourneDeliveryWindow(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now).find((part) => part.type === "hour")?.value);
  return Number.isInteger(hour) && hour >= 8 && hour < 17;
}

function isClaimedReminder(value: unknown): value is ClaimedReminder {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.reminder_id === "string" && UUID_PATTERN.test(row.reminder_id)
    && typeof row.claim_token === "string" && UUID_PATTERN.test(row.claim_token);
}

function normalizedEmail(value: unknown, required = false) {
  if (value === null && !required) return null;
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email && !required) return null;
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

function preparedReminder(value: unknown): PreparedReminder | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const work = normalizedEmail(row.employee_work_email);
  const personal = normalizedEmail(row.employee_personal_email);
  const manager = normalizedEmail(row.manager_email, true);
  if (typeof row.reminder_id !== "string" || !UUID_PATTERN.test(row.reminder_id)
    || typeof row.employee_first_name !== "string" || !row.employee_first_name.trim()
    || typeof row.role !== "string" || !row.role.trim()
    || (row.company_key !== "mam" && row.company_key !== "equipsy")
    || typeof row.manager_first_name !== "string" || !row.manager_first_name.trim()
    || (!work && !personal) || !manager
    || typeof row.commencement_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.commencement_date)
    || typeof row.notify_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.notify_date)) return null;
  return {
    reminder_id: row.reminder_id,
    employee_first_name: row.employee_first_name.trim(),
    employee_work_email: work,
    employee_personal_email: personal,
    role: row.role.trim(), company_key: row.company_key,
    manager_first_name: row.manager_first_name.trim(), manager_email: manager,
    commencement_date: row.commencement_date, notify_date: row.notify_date,
  };
}

function providerFailureCode(response: Response) {
  if (response.status === 408 || response.status === 504) return "provider_timeout" as const;
  if (response.status >= 400 && response.status < 500) return "provider_rejected" as const;
  return "network_error" as const;
}

async function markFailed(
  supabase: ReturnType<typeof createAdminClient>, reminderId: string, claimToken: string,
  code: "network_error" | "provider_timeout" | "provider_rejected" | "invalid_response" | "configuration_error",
) {
  const result = await supabase.rpc("fail_new_starter_day_one_delivery", {
    p_reminder_id: reminderId, p_claim_token: claimToken, p_error_code: code,
  });
  if (result.error || result.data !== true) throw new Error("Day 1 reminder retry could not be recorded.");
}

export async function GET(request: Request) {
  if (isUatMode()) return Response.json({ error: "This operation is unavailable in UAT." }, { status: 403 });
  const headers = { "Cache-Control": "no-store" };
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret || !hasValidCronSecret(request, cronSecret)) {
    return Response.json({ ok: false, code: "unauthorized" }, { status: 401, headers });
  }
  const deliveryMode = configuredDeliveryMode();
  if (!deliveryMode) {
    return Response.json({ ok: true, code: "delivery_disabled", claimed: 0, sent: 0, failed: 0 }, { headers });
  }
  if (!isWithinMelbourneDeliveryWindow()) {
    return Response.json({ ok: true, code: "outside_delivery_window", claimed: 0, sent: 0, failed: 0 }, { headers });
  }
  const configuration = deliveryConfiguration(deliveryMode);
  if (!configuration) return Response.json({ ok: false, code: "not_configured" }, { status: 503, headers });

  const supabase = createAdminClient();
  const claimedResult = await supabase.rpc("claim_due_new_starter_day_one_reminders", { p_limit: DELIVERY_BATCH_LIMIT });
  if (claimedResult.error || !Array.isArray(claimedResult.data)) {
    return Response.json({ ok: false, code: "claim_failed" }, { status: 500, headers });
  }

  let sent = 0;
  let failed = 0;
  const outcomes = await Promise.allSettled(claimedResult.data.map(async (candidate) => {
    if (!isClaimedReminder(candidate)) { failed += 1; return; }
    const preparedResult = await supabase.rpc("prepare_new_starter_day_one_delivery", {
      p_reminder_id: candidate.reminder_id, p_claim_token: candidate.claim_token,
    });
    const prepared = !preparedResult.error && Array.isArray(preparedResult.data)
      ? preparedReminder(preparedResult.data[0]) : null;
    if (!prepared) {
      // An empty result means the claim is already released (moved to review)
      // or no longer ours. A returned row that fails local validation still
      // holds the claim, so release it through the counted retry path instead
      // of letting it expire and be reclaimed without a recorded failure.
      const releasedByPrepare = !preparedResult.error && Array.isArray(preparedResult.data) && preparedResult.data.length === 0;
      if (!releasedByPrepare) await markFailed(supabase,candidate.reminder_id,candidate.claim_token,"configuration_error");
      failed += 1;
      return;
    }

    const deliveryId = `new-starter:${prepared.reminder_id}:day-one:${configuration.mode}`;
    let response: Response;
    try {
      response = await fetch(configuration.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mam-check-in-webhook-secret": configuration.webhookSecret },
        body: JSON.stringify({
          version: 1, event: "new-starter-day-one", mode: configuration.mode, deliveryId,
          employee: {
            firstName: prepared.employee_first_name, role: prepared.role, company: prepared.company_key,
            workEmail: prepared.employee_work_email, personalEmail: prepared.employee_personal_email,
          },
          manager: { firstName: prepared.manager_first_name, email: prepared.manager_email },
          commencementDate: prepared.commencement_date,
        }),
        redirect: "error", signal: AbortSignal.timeout(20_000), cache: "no-store",
      });
    } catch {
      await markFailed(supabase,candidate.reminder_id,candidate.claim_token,"network_error");
      failed += 1;
      return;
    }
    if (!response.ok) {
      await markFailed(supabase,candidate.reminder_id,candidate.claim_token,providerFailureCode(response));
      failed += 1;
      return;
    }
    const ack = await readCheckInDeliveryAck(response, deliveryId);
    if (!ack) {
      await markFailed(supabase,candidate.reminder_id,candidate.claim_token,"invalid_response");
      failed += 1;
      return;
    }
    const completed = await supabase.rpc("complete_new_starter_day_one_delivery", {
      p_reminder_id: candidate.reminder_id, p_claim_token: candidate.claim_token,
    });
    if (completed.error || completed.data !== true) throw new Error("Day 1 reminder could not be finalised.");
    sent += 1;
  }));

  const incomplete = failed > 0 || outcomes.some((outcome) => outcome.status === "rejected");
  if (incomplete) return Response.json({ ok: false, code: "delivery_incomplete", claimed: claimedResult.data.length, sent, failed }, { status: 503, headers });
  return Response.json({ ok: true, claimed: claimedResult.data.length, sent, failed,
    backlogLikely: claimedResult.data.length === DELIVERY_BATCH_LIMIT }, { headers });
}
