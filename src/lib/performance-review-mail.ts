import "server-only";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildPerformanceReviewDownload } from "@/lib/performance-review-document";
import { closed, parseDocument, meetingEndMillis, REQUIRED_ANSWERS, RATING_INDICES } from "@/lib/performance-review-rules";
import { Temporal } from "temporal-polyfill";
import { performanceReviewMailEnabled, performanceReviewMailTarget, performanceMailBudget, readPerformanceMailJson, performanceMailRpcSucceeded, PERFORMANCE_MAIL_ORIGIN, PERFORMANCE_MAIL_READY_PATH } from "@/lib/performance-review-mail-policy";

const CAREERS = "careers@mobilityaccess.com.au";
const MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function performanceMailUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

export function validatePerformanceReviewMailPayload(raw: unknown): void {
  const v = closed(raw, ["version", "event", "eventKey", "deliveryId", "reviewId", "reviewCode", "claimToken", "employeeName", "managerName", "finalisedAt", "recipient", "managerNote", "attachment"]);
  const a = closed(v.attachment, ["fileName", "mimeType", "contentBase64", "sha256"]);
  const text = (value: unknown) => typeof value === "string" && value.length <= 8000 && Boolean(value.trim())
    && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/.test(value);
  if (v.version !== 1 || v.event !== "performance-review-finalised" || !performanceMailUuid(v.reviewId)
    || !performanceMailUuid(v.deliveryId) || !performanceMailUuid(v.claimToken)
    || v.eventKey !== `performance-review:${v.reviewId}:finalised` || v.recipient !== CAREERS
    || typeof v.reviewCode !== "string" || !/^PR-[0-9]{4}-[1-9][0-9]*$/.test(v.reviewCode)
    || !text(v.employeeName) || !text(v.managerName) || !text(v.managerNote)
    || typeof v.finalisedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v.finalisedAt)
    || a.fileName !== `${v.reviewCode}-manager.docx` || a.mimeType !== MIME
    || typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256)
    || typeof a.contentBase64 !== "string" || a.contentBase64.length > Math.ceil(2 * 1024 * 1024 / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(a.contentBase64)) throw new Error("invalid_payload");
  try { Temporal.Instant.from(v.finalisedAt); } catch { throw new Error("invalid_payload"); }
  const bytes = Buffer.from(a.contentBase64, "base64");
  if (!bytes.length || bytes.length > 2 * 1024 * 1024 || bytes.toString("base64") !== a.contentBase64
    || createHash("sha256").update(bytes).digest("hex") !== a.sha256) throw new Error("invalid_payload");
}

function payloadForClaim(raw: unknown, reviewId: string | null) {
  const row = closed(raw, ["delivery_id", "review_id", "claim_token", "payload"]);
  if (!performanceMailUuid(row.delivery_id) || !performanceMailUuid(row.review_id) || !performanceMailUuid(row.claim_token)
    || (reviewId !== null && row.review_id !== reviewId)) throw new Error("invalid_claim");
  const payload = closed(row.payload, ["reviewId", "reviewCode", "finalisedAt", "managerNote", "document"]);
  const document = parseDocument(payload.document);
  if (document.audience !== "manager" || document.code !== payload.reviewCode || payload.reviewId !== row.review_id
    || !performanceMailUuid(document.employee.id) || !performanceMailUuid(document.manager.id)
    || !document.meeting || !document.summary.trim() || !document.overallRating
    || REQUIRED_ANSWERS.some(i => !document.selfAnswers[i].trim() || !document.managerAnswers[i].trim())
    || RATING_INDICES.some(i => !document.ratings[i])
    || typeof payload.managerNote !== "string" || !payload.managerNote.trim() || payload.managerNote.length > 8000
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/.test(payload.managerNote)
    || typeof payload.finalisedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(payload.finalisedAt)
    || Temporal.Instant.from(payload.finalisedAt).epochMilliseconds < meetingEndMillis(document.meeting)) throw new Error("invalid_snapshot");
  const download = buildPerformanceReviewDownload(document);
  const bytes = Buffer.from(download.bytes);
  if (download.fileName !== `${document.code}-manager.docx` || download.mimeType !== MIME || bytes.length === 0 || bytes.length > 2 * 1024 * 1024) throw new Error("invalid_attachment");
  return {
    version: 1, event: "performance-review-finalised", eventKey: `performance-review:${row.review_id}:finalised`,
    deliveryId: row.delivery_id, reviewId: row.review_id, reviewCode: document.code, claimToken: row.claim_token,
    employeeName: document.employee.name, managerName: document.manager.name, finalisedAt: payload.finalisedAt,
    recipient: CAREERS, managerNote: payload.managerNote,
    attachment: { fileName: download.fileName, mimeType: MIME, contentBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") },
  };
}

export async function dispatchPerformanceReviewMailOutbox(reviewId: string | null = null, expiresAt = Date.now() + 25_000) {
  const empty = { claimed: 0, providerAccepted: 0, held: 0 };
  const budget = performanceMailBudget(expiresAt);
  if (!performanceReviewMailEnabled()) return { ok: true, code: "disabled", ...empty };
  if (reviewId !== null && !performanceMailUuid(reviewId)) return { ok: false, code: "invalid_review", ...empty };
  let target: ReturnType<typeof performanceReviewMailTarget>;
  try { target = performanceReviewMailTarget(); } catch { return { ok: false, code: "invalid_configuration", ...empty }; }
  if (budget.remaining() < 22_000) return { ok: false, code: "deadline", ...empty };
  let admin: ReturnType<typeof createAdminClient>;
  let rows: unknown[];
  try {
    admin = createAdminClient();
    const claimed = await budget.run(signal => admin.rpc("claim_performance_review_mail", { p_review_id: reviewId, p_limit: 1 }).retry(false).abortSignal(signal));
    if (!performanceMailRpcSucceeded(claimed) || !Array.isArray(claimed.data) || claimed.data.length > 1) throw new Error("invalid_claims");
    rows = claimed.data;
    const deliveries = new Set(), reviews = new Set();
    for (const raw of rows) {
      const row = raw as Record<string, unknown> | null;
      const delivery = Object.getOwnPropertyDescriptor(row ?? {}, "delivery_id")?.value;
      const review = Object.getOwnPropertyDescriptor(row ?? {}, "review_id")?.value;
      if ((delivery !== undefined && deliveries.has(delivery)) || (review !== undefined && reviews.has(review))) throw new Error("duplicate_claim");
      deliveries.add(delivery); reviews.add(review);
    }
  } catch { return { ok: false, code: "claim_failed", ...empty }; }
  let providerAccepted = 0;
  for (const row of rows) {
    let payload: ReturnType<typeof payloadForClaim>;
    try { payload = payloadForClaim(row, reviewId); } catch { continue; }
    let accepted = false;
    try {
      validatePerformanceReviewMailPayload(payload);
      if (!performanceReviewMailEnabled() || performanceReviewMailTarget().secret !== target.secret) break;
      accepted = await budget.run(async signal => {
        const response = await fetch(target.url, {
          method: "POST", redirect: "error", cache: "no-store", signal,
          headers: { "Content-Type": "application/json", "X-MAM-Performance-Secret": target.secret },
          body: JSON.stringify(payload),
        });
        if (response.status !== 200 || response.redirected || (response.url && response.url !== target.url)) throw new Error("invalid_response");
        const receipt = closed(await readPerformanceMailJson(response, 16_384, signal), ["ok", "status", "deliveryId", "eventKey", "actualRecipients", "attachmentSha256"]);
        return receipt.ok === true && receipt.status === "provider_accepted" && receipt.deliveryId === payload.deliveryId
          && receipt.eventKey === payload.eventKey && receipt.attachmentSha256 === payload.attachment.sha256
          && Array.isArray(receipt.actualRecipients) && receipt.actualRecipients.length === 1 && receipt.actualRecipients[0] === CAREERS;
      }, Math.min(15_000, budget.remaining() - 2_000));
    } catch { accepted = false; }
    try {
      const finished = await budget.run(signal => admin.rpc("finish_performance_review_mail", {
        p_delivery_id: payload.deliveryId, p_claim_token: payload.claimToken, p_outcome: accepted ? "provider_accepted" : "unknown", p_attachment_sha256: payload.attachment.sha256,
      }).retry(false).abortSignal(signal));
      if (accepted && performanceMailRpcSucceeded(finished) && finished.data === true) providerAccepted++;
    } catch { continue; }
  }
  return { ok: providerAccepted === rows.length, code: "processed", claimed: rows.length, providerAccepted, held: rows.length - providerAccepted };
}

export async function performanceReviewMailReadiness(expiresAt = Date.now() + 25_000) {
  let configured = false;
  try {
    if (!performanceReviewMailEnabled()) return { configured, ready: false };
    const target = performanceReviewMailTarget();
    configured = true;
    const budget = performanceMailBudget(expiresAt);
    const url = PERFORMANCE_MAIL_ORIGIN + PERFORMANCE_MAIL_READY_PATH;
    const ready = await budget.run(async signal => {
      const response = await fetch(url, { method: "GET", redirect: "error", cache: "no-store", signal, headers: { "X-MAM-Performance-Secret": target.secret } });
      if (response.status !== 200 || response.redirected || (response.url && response.url !== url)) return false;
      const receipt = closed(await readPerformanceMailJson(response, 1_024, signal), ["ok", "ready"]);
      return receipt.ok === true && receipt.ready === true;
    }, 15_000);
    return { configured, ready };
  } catch { return { configured, ready: false }; }
}

export async function dispatchPerformanceReviewMailForReview(reviewId: string): Promise<void> {
  if (!performanceMailUuid(reviewId)) return;
  try { await dispatchPerformanceReviewMailOutbox(reviewId); } catch { return; }
}
