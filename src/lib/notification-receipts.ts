import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

export const NOTIFICATION_RECEIPTS_PATH = "/api/internal/integrations/notifications/receipts";
const LIMIT = 16_384;
const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID = new RegExp(`^${UUID_SOURCE}$`);
const LEAVE = new RegExp(`^leave:(${UUID_SOURCE}):(leave-submitted|leave-approved|leave-declined|leave-cancelled|leave-conditionally-approved|leave-reminder|team-birthday):[0-9a-f]{24}$`);
const PAYROLL = new RegExp(`^payroll-balance:${UUID_SOURCE}:[0-9]{4}-(0[1-9]|1[0-2])$`);
const COMPARISON = new RegExp(`^payroll-comparison:${UUID_SOURCE}$`);
const NEW_STARTER = new RegExp(`^new-starter:${UUID_SOURCE}:day-one:(test|live)$`);
const CHECK_IN = new RegExp(`^checkin:${UUID_SOURCE}:(2-week|1-month|2-month|3-month|5-month|6-month|6-month-casual):initial:(test|live)$`);
const CHECK_IN_REVIEW = new RegExp(`^checkin-review:${UUID_SOURCE}:hr:[1-9][0-9]*:(test|live)$`);
const ONBOARDING_CREDENTIAL = new RegExp(`^onboarding-credential:${UUID_SOURCE}$`);
const SUBSCRIPTION_REQUEST = new RegExp(`^subscription-request:${UUID_SOURCE}:[1-9][0-9]*$`);
const SUBSCRIPTION_REVIEW = new RegExp(`^subscription-review:${UUID_SOURCE}:[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01]):(upcoming|due)$`);
const PERFORMANCE_REVIEW = new RegExp(`^performance-review:${UUID_SOURCE}:(started|self-submitted|manager-invited)$`);
const LIFECYCLE = new RegExp(`^employee-lifecycle:${UUID_SOURCE}:(onboarding|offboarding)$`);
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const headers = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff" };

type RpcName = "reserve_employee_lifecycle_mail" | "reserve_performance_review_notification_mail" | "reserve_notification_delivery" | "reserve_subscription_request_mail" | "reserve_subscription_review_mail" | "confirm_notification_delivery" | "notification_delivery_store_status";
export type ReceiptRpc = (name: RpcName, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
type ProviderReceipt = { accepted: true; messageId: string | null; requestId: string | null; statusCode: number | null };
type DeliveryInput = { eventKey: string; recipient: string; cc: string } & (
  { action: "reserve"; legacyEventKey: string | null; claimToken: string | null }
  | { action: "confirm"; deliveryToken: string; providerReceipt: ProviderReceipt }
);

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join(",") === keys.sort().join(",");
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });
const error = (code: string, status: number) => reply({ ok: false, code }, status);
const eventKey = (value: unknown): value is string => typeof value === "string" && value.length <= 256
  && (LEAVE.test(value) || PAYROLL.test(value) || COMPARISON.test(value) || NEW_STARTER.test(value)
    || CHECK_IN.test(value) || CHECK_IN_REVIEW.test(value) || ONBOARDING_CREDENTIAL.test(value) || SUBSCRIPTION_REQUEST.test(value) || SUBSCRIPTION_REVIEW.test(value) || PERFORMANCE_REVIEW.test(value) || LIFECYCLE.test(value));

/** Do not silently drop malformed addresses: that would change the send intent. */
function recipients(value: unknown, required: boolean): string | null {
  if (typeof value !== "string" || value.length > 8192 || CONTROL.test(value)) return null;
  if (value === "") return required ? null : "";
  const parts = value.split(",").map((part) => part.trim().toLowerCase());
  if (parts.length > 32 || parts.some((part) => part.length > 254 || !EMAIL.test(part))) return null;
  return [...new Set(parts)].sort().join(",");
}

function providerReceipt(value: unknown): value is ProviderReceipt {
  if (!object(value) || !exactKeys(value, ["accepted", "messageId", "requestId", "statusCode"]) || value.accepted !== true) return false;
  const identifier = (item: unknown) => item === null || (typeof item === "string" && item.length > 0 && item.length <= 1024 && !CONTROL.test(item));
  return identifier(value.messageId) && identifier(value.requestId)
    && (value.statusCode === null || (Number.isInteger(value.statusCode) && Number(value.statusCode) >= 200 && Number(value.statusCode) <= 299));
}

function parseInput(value: unknown): DeliveryInput | null {
  if (!object(value) || !eventKey(value.eventKey)) return null;
  const recipient = recipients(value.recipient, true);
  const cc = recipients(value.cc, false);
  if (recipient === null || cc === null) return null;
  if (value.action === "reserve" && exactKeys(value, ["action", "eventKey", "recipient", "cc", "legacyEventKey", ...((PERFORMANCE_REVIEW.test(value.eventKey) || LIFECYCLE.test(value.eventKey)) ? ["claimToken"] : [])])) {
    const claimToken = (PERFORMANCE_REVIEW.test(value.eventKey) || LIFECYCLE.test(value.eventKey)) ? value.claimToken : null;
    if ((PERFORMANCE_REVIEW.test(value.eventKey) || LIFECYCLE.test(value.eventKey)) && (typeof claimToken !== "string" || !UUID.test(claimToken))) return null;
    const legacy = value.legacyEventKey;
    if (legacy !== null) {
      const own = LEAVE.exec(value.eventKey);
      const previous = typeof legacy === "string" ? LEAVE.exec(legacy) : null;
      if (!own || !previous || own[1] !== previous[1] || own[2] !== "leave-submitted"
        || previous[2] !== "leave-submitted" || legacy === value.eventKey) return null;
    }
    return { action: "reserve", eventKey: value.eventKey, recipient, cc, legacyEventKey: legacy as string | null, claimToken: claimToken as string | null };
  }
  if (value.action === "confirm" && exactKeys(value, ["action", "eventKey", "recipient", "cc", "deliveryToken", "providerReceipt"])
    && typeof value.deliveryToken === "string" && UUID.test(value.deliveryToken) && providerReceipt(value.providerReceipt)) {
    return { action: "confirm", eventKey: value.eventKey, recipient, cc, deliveryToken: value.deliveryToken, providerReceipt: value.providerReceipt };
  }
  return null;
}

function authenticate(request: Request, secret: string | undefined): number {
  const expected = secret?.trim();
  if (!expected || expected.length < 32 || expected.length > 512 || CONTROL.test(expected)) return 503;
  const actual = request.headers.get("x-mam-notification-secret");
  if (!actual || actual.length > 512) return 401;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(expected), hash(actual)) ? 200 : 401;
}

async function readBody(request: Request): Promise<{ data?: unknown; status?: number }> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > LIMIT)) return { status: 413 };
  if (!request.body) return { status: 400 };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMIT) { await reader.cancel(); return { status: 413 }; }
      chunks.push(value);
    }
    return { data: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) };
  } catch { return { status: 400 }; }
  finally { reader.releaseLock(); }
}

/** Whitelist the response too: neither database errors nor arbitrary HR fields escape. */
function deliveryResponse(data: unknown, input: DeliveryInput): Response {
  if (!object(data) || data.eventKey !== input.eventKey) return error("unavailable", 503);
  if (input.action === "reserve" && data.outcome === "send"
    && exactKeys(data, ["outcome", "eventKey", "deliveryToken"])
    && typeof data.deliveryToken === "string" && UUID.test(data.deliveryToken)) {
    return reply({ outcome: "send", eventKey: input.eventKey, deliveryToken: data.deliveryToken });
  }
  const recipient = recipients(data.actualRecipient, true);
  const cc = recipients(data.actualCcRecipients, false);
  const hasEvidence = recipient !== null && cc !== null && providerReceipt(data.providerReceipt);
  if (data.ok === true && hasEvidence && recipient === input.recipient && cc === input.cc
    && ((input.action === "reserve" && data.outcome === "duplicate" && data.sent === false && data.alreadySent === true)
      || (input.action === "confirm" && data.sent === true && data.alreadySent === false))) {
    if (input.action === "confirm" && ["messageId", "requestId", "statusCode"].some((key) =>
      (data.providerReceipt as ProviderReceipt)[key as keyof ProviderReceipt] !== input.providerReceipt[key as keyof ProviderReceipt])) return error("unavailable", 503);
    return reply({ ...(input.action === "reserve" ? { outcome: "duplicate" } : {}), ok: true,
      sent: input.action === "confirm", alreadySent: input.action === "reserve", eventKey: input.eventKey,
      actualRecipient: recipient, actualCcRecipients: cc, providerReceipt: data.providerReceipt });
  }
  if (data.outcome === "rejected" && data.ok === false && data.sent === false && data.alreadySent === false
    && typeof data.rejectionCode === "string" && /^[a-z][a-z-]{0,79}$/.test(data.rejectionCode)
    && typeof data.reconciliationRequired === "boolean") {
    return reply({ outcome: "rejected", ok: false, sent: false, alreadySent: false, eventKey: input.eventKey,
      rejectionCode: data.rejectionCode, reconciliationRequired: data.reconciliationRequired,
      ...(eventKey(data.receiptEventKey) ? { receiptEventKey: data.receiptEventKey } : {}),
      ...(hasEvidence ? { actualRecipient: recipient, actualCcRecipients: cc, providerReceipt: data.providerReceipt } : {}),
    }, data.rejectionCode === "receipt-store-not-ready" ? 503 : 200);
  }
  return error("unavailable", 503);
}

/** A bounded server-to-server bridge, not an email sender or a browser/admin API.
 * An uncertain reserve is never retried here. Only the DB can grant one send.
 */
export async function handleNotificationReceipts(request: Request, secret: string | undefined, rpc: ReceiptRpc): Promise<Response> {
  const authorization = authenticate(request, secret);
  if (authorization !== 200) return error(authorization === 401 ? "unauthorized" : "unavailable", authorization);
  const url = new URL(request.url);
  if (url.pathname !== NOTIFICATION_RECEIPTS_PATH || url.search || request.headers.has("origin") || request.headers.has("cookie")) return error("invalid_request", 400);
  if (request.method === "GET") {
    try {
      const { data, error: failure } = await rpc("notification_delivery_store_status", {});
      if (failure || !object(data) || data.version !== 1 || typeof data.ready !== "boolean") return error("unavailable", 503);
      return reply({ version: 1, ready: data.ready });
    } catch { return error("unavailable", 503); }
  }
  if (request.method !== "POST") return error("method_not_allowed", 405);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return error("invalid_request", 400);
  const body = await readBody(request);
  if (body.status) return error("invalid_request", body.status);
  const input = parseInput(body.data);
  if (!input) return error("invalid_request", 400);
  try {
    const reserveRpc = LIFECYCLE.test(input.eventKey) ? "reserve_employee_lifecycle_mail" : PERFORMANCE_REVIEW.test(input.eventKey) ? "reserve_performance_review_notification_mail" : SUBSCRIPTION_REQUEST.test(input.eventKey) ? "reserve_subscription_request_mail"
      : SUBSCRIPTION_REVIEW.test(input.eventKey) ? "reserve_subscription_review_mail" : "reserve_notification_delivery";
    const { data, error: failure } = await rpc(input.action === "reserve" ? reserveRpc : "confirm_notification_delivery", {
      p_event_key: input.eventKey, p_recipient: input.recipient, p_cc: input.cc,
      ...(input.action === "reserve" ? { p_legacy_event_key: input.legacyEventKey, ...((PERFORMANCE_REVIEW.test(input.eventKey) || LIFECYCLE.test(input.eventKey)) ? { p_claim_token: input.claimToken } : {}) }
        : { p_delivery_token: input.deliveryToken, p_provider_receipt: input.providerReceipt }),
    });
    if (failure) return error("unavailable", 503);
    return deliveryResponse(data, input);
  } catch { return error("unavailable", 503); }
}
