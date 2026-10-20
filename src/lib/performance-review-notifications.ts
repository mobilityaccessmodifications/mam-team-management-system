import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { closed } from "@/lib/performance-review-rules";
import { performanceMailUuid } from "@/lib/performance-review-mail";
import { PERFORMANCE_MAIL_ORIGIN, performanceReviewMailEnabled, performanceMailBudget, performanceMailRpcSucceeded, readPerformanceMailJson } from "@/lib/performance-review-mail-policy";

export const PERFORMANCE_NOTIFICATION_PATH = "/webhook/mam-people-hub-performance-review-notifications-v1";

function receiver() {
  const secret = process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET;
  if (process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN !== PERFORMANCE_MAIL_ORIGIN || !secret
    || secret.length < 32 || secret.length > 512 || /[\u0000-\u001f\u007f]/.test(secret)) throw Error("not_configured");
  return { url: PERFORMANCE_MAIL_ORIGIN + PERFORMANCE_NOTIFICATION_PATH, secret };
}

function claimedPayload(raw: unknown, reviewId: string | null) {
  const row = closed(raw, ["delivery_id", "review_id", "claim_token", "payload"]);
  const hasCc = row.payload !== null && typeof row.payload === "object" && Object.hasOwn(row.payload, "cc");
  const p = closed(row.payload, ["event", "eventKey", "reviewId", "reviewCode", "cycle", "dueDate", "recipient", "employeeName", "managerName", ...(hasCc ? ["cc"] : [])]);
  const cc = hasCc ? p.cc : "";
  const expectedCc = p.recipient === "careers@mobilityaccess.com.au" ? "" : "careers@mobilityaccess.com.au";
  const name = (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.length <= 8000 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/.test(v);
  if (!performanceMailUuid(row.delivery_id) || !performanceMailUuid(row.review_id) || !performanceMailUuid(row.claim_token)
    || (reviewId !== null && row.review_id !== reviewId) || p.reviewId !== row.review_id
    || !["started", "self-submitted"].includes(p.event as string) || p.eventKey !== `performance-review:${row.review_id}:${p.event}`
    || typeof p.reviewCode !== "string" || !/^PR-[0-9]{4}-[1-9][0-9]*$/.test(p.reviewCode)
    || typeof p.cycle !== "string" || !/^[0-9]{4}$/.test(p.cycle)
    || typeof p.dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.dueDate)
    || (hasCc && cc !== expectedCc)
    || !name(p.employeeName) || !name(p.managerName) || typeof p.recipient !== "string"
    || p.recipient !== p.recipient.trim().toLowerCase() || p.recipient.length > 254 || /[\u0000-\u001f\u007f\ufffe\uffff]/.test(p.recipient) || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(p.recipient)) throw Error("invalid_claim");
  return { deliveryId: row.delivery_id, claimToken: row.claim_token, payload: { version: 1, ...p, claimToken: row.claim_token }, recipient: p.recipient, cc, eventKey: p.eventKey };
}

export async function dispatchPerformanceReviewNotifications(reviewId: string | null = null, expiresAt = Date.now() + 25_000) {
  const empty = { claimed: 0, sent: 0, held: 0 };
  if (!performanceReviewMailEnabled()) return { ok: true, code: "disabled", ...empty };
  if (reviewId !== null && !performanceMailUuid(reviewId)) return { ok: false, code: "invalid_review", ...empty };
  const budget = performanceMailBudget(expiresAt);
  let target: ReturnType<typeof receiver>;
  try { target = receiver(); } catch { return { ok: false, code: "not_configured", ...empty }; }
  if (budget.remaining() < 22_000) return { ok: false, code: "deadline", ...empty };
  const admin = createAdminClient();
  let rows: unknown[];
  try {
    const result = await budget.run(signal => admin.rpc("claim_performance_review_notifications", { p_review_id: reviewId, p_limit: 1 }).retry(false).abortSignal(signal));
    if (!performanceMailRpcSucceeded(result) || !Array.isArray(result.data) || result.data.length > 1) throw Error("invalid_claim");
    rows = result.data;
  } catch { return { ok: false, code: "claim_failed", ...empty }; }
  let sent = 0;
  for (const row of rows) {
    let claim: ReturnType<typeof claimedPayload>;
    try { claim = claimedPayload(row, reviewId); } catch { continue; }
    let delivered = false;
    try {
      if (!performanceReviewMailEnabled() || receiver().secret !== target.secret) break;
      delivered = await budget.run(async signal => {
        const response = await fetch(target.url, { method: "POST", redirect: "error", cache: "no-store", signal,
          headers: { "Content-Type": "application/json", "X-MAM-Notification-Secret": target.secret }, body: JSON.stringify(claim.payload) });
        if (response.status !== 200 || response.redirected || (response.url && response.url !== target.url)) return false;
        const r = closed(await readPerformanceMailJson(response, 4096, signal), ["ok", "sent", "alreadySent", "eventKey", "actualRecipient", "actualCcRecipients", "providerReceipt"]);
        const evidence = closed(r.providerReceipt, ["accepted", "messageId", "requestId", "statusCode"]);
        const identifier = (v: unknown) => v === null || (typeof v === "string" && v.length > 0 && v.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(v));
        return r.ok === true && ((r.sent === true && r.alreadySent === false) || (r.sent === false && r.alreadySent === true))
          && r.eventKey === claim.eventKey && r.actualRecipient === claim.recipient && r.actualCcRecipients === claim.cc
          && evidence.accepted === true && evidence.statusCode === 202 && identifier(evidence.messageId) && identifier(evidence.requestId);
      }, Math.min(15_000, budget.remaining() - 2_000));
    } catch { delivered = false; }
    try {
      const result = await budget.run(signal => admin.rpc("finish_performance_review_notification", {
        p_delivery_id: claim.deliveryId, p_claim_token: claim.claimToken, p_delivered: delivered,
      }).retry(false).abortSignal(signal));
      if (delivered && performanceMailRpcSucceeded(result) && result.data === true) sent++;
    } catch { continue; }
  }
  return { ok: sent === rows.length, code: "processed", claimed: rows.length, sent, held: rows.length - sent };
}

export async function dispatchPerformanceReviewNotificationsForReview(reviewId: string): Promise<void> {
  try { await dispatchPerformanceReviewNotifications(reviewId); } catch { return; }
}
