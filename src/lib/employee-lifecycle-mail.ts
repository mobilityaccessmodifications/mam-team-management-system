import "server-only";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { performanceMailBudget, performanceMailRpcSucceeded, readPerformanceMailJson } from "@/lib/performance-review-mail-policy";

export const LIFECYCLE_ORIGIN = "https://n8n.srv1866578.hstgr.cloud";
export const LIFECYCLE_PATH = "/webhook/mam-people-hub-employee-lifecycle-v1";
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
function closed(v: unknown, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join(",") !== [...keys].sort().join(",")) throw Error("invalid_shape");
  return v as Record<string, unknown>;
}
function target() {
  const secret = process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET;
  if (process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN !== LIFECYCLE_ORIGIN || !secret || secret.length < 32 || secret.length > 512 || /[\u0000-\u001f\u007f]/.test(secret)) throw Error("not_configured");
  return { url: LIFECYCLE_ORIGIN + LIFECYCLE_PATH, secret };
}
export function lifecycleMailEnabled() {
  return process.env.VERCEL_ENV === "production" && process.env.MAM_SANDBOX_E2E?.trim().toLowerCase() !== "true";
}
export function lifecycleClaim(raw: unknown, personId: string | null) {
  const r = closed(raw, ["delivery_id", "person_id", "claim_token", "payload"]);
  const p = closed(r.payload, ["event", "eventKey", "personId", "recipient", "employee"]);
  const e = closed(p.employee, ["name", "company", "role", "department", "location", "employmentType", "startDate", "endDate"]);
  const addresses = typeof p.recipient === "string" ? p.recipient.split(",") : [];
  const text = (v: unknown) => typeof v === "string" && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v);
  const date = (v: unknown) => {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const d = new Date(v + "T12:00:00Z");
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  };
  if (!uuid(r.delivery_id) || !uuid(r.person_id) || !uuid(r.claim_token) || (personId !== null && personId !== r.person_id)
    || p.personId !== r.person_id || !["onboarding", "offboarding"].includes(p.event as string)
    || p.eventKey !== `employee-lifecycle:${r.delivery_id}:${p.event}`
    || addresses.length < 5 || addresses.length > 6 || p.recipient !== [...new Set(addresses)].sort().join(",")
    || addresses.some(a => a !== a.toLowerCase().trim() || a.length > 254 || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(a) || /[\u0000-\u001f\u007f]/.test(a))
    || ![e.name,e.company,e.role,e.department,e.location,e.employmentType].every(text) || !(e.name as string).trim()
    || !["MAM", "Equipsy"].includes(e.company as string)
    || !date(p.event === "onboarding" ? e.startDate : e.endDate)
    || (e.startDate !== null && !date(e.startDate)) || (e.endDate !== null && !date(e.endDate))) throw Error("invalid_claim");
  return { deliveryId: r.delivery_id, claimToken: r.claim_token, recipient: p.recipient, eventKey: p.eventKey,
    payload: { version: 1, ...p, deliveryId: r.delivery_id, claimToken: r.claim_token } };
}
export async function dispatchEmployeeLifecycleMail(personId: string | null = null, expiresAt = Date.now() + 50_000) {
  const empty = { claimed: 0, sent: 0, held: 0 };
  if (!lifecycleMailEnabled()) return { ok: true, code: "disabled", ...empty };
  if (personId !== null && !uuid(personId)) return { ok: false, code: "invalid_person", ...empty };
  const budget = performanceMailBudget(expiresAt);
  let receiver: ReturnType<typeof target>;
  try { receiver = target(); } catch { return { ok: false, code: "not_configured", ...empty }; }
  const admin = createAdminClient();
  const limit = personId === null ? 10 : 1;
  let rows: unknown[];
  try {
    const result = await budget.run(signal => admin.rpc("claim_employee_lifecycle_mail", { p_person_id: personId, p_limit: limit }).retry(false).abortSignal(signal));
    if (!performanceMailRpcSucceeded(result) || !Array.isArray(result.data) || result.data.length > limit) throw Error("invalid_claim");
    rows = result.data;
  } catch { return { ok: false, code: "claim_failed", ...empty }; }
  let sent = 0;
  await Promise.all(rows.map(async row => {
    let claim: ReturnType<typeof lifecycleClaim>;
    try { claim = lifecycleClaim(row, personId); } catch { return; }
    let delivered = false;
    try {
      if (!lifecycleMailEnabled() || target().secret !== receiver.secret) return;
      delivered = await budget.run(async signal => {
        const response = await fetch(receiver.url, { method: "POST", redirect: "error", cache: "no-store", signal,
          headers: { "Content-Type": "application/json", "X-MAM-Notification-Secret": receiver.secret }, body: JSON.stringify(claim.payload) });
        if (response.status !== 200 || response.redirected || (response.url && response.url !== receiver.url)) return false;
        const r = closed(await readPerformanceMailJson(response, 4096, signal), ["ok", "sent", "alreadySent", "eventKey", "actualRecipient", "actualCcRecipients", "providerReceipt"]);
        const evidence = closed(r.providerReceipt, ["accepted", "messageId", "requestId", "statusCode"]);
        return r.ok === true && ((r.sent === true && r.alreadySent === false) || (r.sent === false && r.alreadySent === true))
          && r.eventKey === claim.eventKey && r.actualRecipient === claim.recipient && r.actualCcRecipients === ""
          && evidence.accepted === true && evidence.statusCode === 202 && evidence.messageId === null && evidence.requestId === null;
      }, Math.min(35_000, budget.remaining() - 5_000));
    } catch { delivered = false; }
    try {
      const result = await budget.run(signal => admin.rpc("finish_employee_lifecycle_mail", {
        p_delivery_id: claim.deliveryId, p_claim_token: claim.claimToken, p_delivered: delivered,
      }).retry(false).abortSignal(signal));
      if (delivered && performanceMailRpcSucceeded(result) && result.data === true) sent++;
    } catch { return; }
  }));
  return { ok: sent === rows.length, code: "processed", claimed: rows.length, sent, held: rows.length - sent };
}
export function scheduleEmployeeLifecycleMail(personId: string) {
  if (!lifecycleMailEnabled()) return;
  try { after(async () => { try { await dispatchEmployeeLifecycleMail(personId); } catch { return; } }); } catch { return; }
}
