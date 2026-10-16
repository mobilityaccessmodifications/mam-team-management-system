import "server-only";
import { timingSafeEqual } from "node:crypto";
import { dispatchPerformanceReviewMailOutbox, performanceReviewMailReadiness, performanceMailUuid } from "@/lib/performance-review-mail";
import { createAdminClient } from "@/lib/supabase/admin";
import { closed } from "@/lib/performance-review-rules";
import { performanceMailBudget, performanceReviewMailEnabled, performanceReviewMailTarget, readPerformanceMailJson, performanceMailRpcSucceeded } from "@/lib/performance-review-mail-policy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function reply(body: object, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function authenticates(supplied: string | null, expected: string | undefined) {
  if (!expected || !supplied || supplied.length > 512) return false;
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function routeUrl(request: Request) {
  const url = new URL(request.url);
  const origin = process.env.NEXT_PUBLIC_APP_URL;
  if (!origin || url.origin !== origin || url.pathname !== "/api/performance-reviews/mail" || url.username || url.password || url.hash
    || (request.headers.has("origin") && request.headers.get("origin") !== origin)) throw new Error("invalid_request");
  return url;
}

export async function GET(request: Request) {
  const expiresAt = Date.now() + 25_000;
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || !authenticates(request.headers.get("authorization"), `Bearer ${secret}`)) return reply({ ok: false, code: "unauthorized" }, 401);
  let url: URL;
  try { url = routeUrl(request); } catch { return reply({ ok: false, code: "invalid_request" }, 400); }
  if (url.search && url.search !== "?readiness=1") return reply({ ok: false, code: "invalid_request" }, 400);
  try {
    if (url.search === "?readiness=1") {
      const result = await performanceReviewMailReadiness(expiresAt);
      return reply({ ok: result.ready, ...result }, result.ready ? 200 : 503);
    }
    const result = await dispatchPerformanceReviewMailOutbox(null, expiresAt);
    return reply(result, result.ok ? 200 : 503);
  } catch { return reply({ ok: false, code: "unavailable" }, 503); }
}

export async function POST(request: Request) {
  const budget = performanceMailBudget();
  if (!authenticates(request.headers.get("X-MAM-Performance-Secret"), process.env.MAM_N8N_PERFORMANCE_WEBHOOK_SECRET)) return reply({ ok: false, code: "unauthorized" }, 401);
  try { if (routeUrl(request).search) throw new Error("invalid_request"); } catch { return reply({ ok: false, code: "invalid_request" }, 400); }
  try {
    if (!performanceReviewMailEnabled()) throw new Error("disabled");
    performanceReviewMailTarget();
  } catch { return reply({ ok: false, code: "unavailable" }, 503); }
  let body: Record<string, unknown>;
  try {
    const raw = await budget.run(signal => readPerformanceMailJson(request, 1_024, signal));
    const phase = raw && typeof raw === "object" ? Object.getOwnPropertyDescriptor(raw, "phase")?.value : undefined;
    body = closed(raw, phase === "readiness" ? ["phase"] : phase === "begin" ? ["phase", "deliveryId", "claimToken", "attachmentSha256"] : ["phase", "deliveryId", "claimToken", "attachmentSha256", "outcome"]);
    if (phase !== "readiness" && (!["begin", "finish"].includes(phase) || !performanceMailUuid(body.deliveryId) || !performanceMailUuid(body.claimToken)
      || typeof body.attachmentSha256 !== "string" || !/^[0-9a-f]{64}$/.test(body.attachmentSha256)
      || (phase === "finish" && !["provider_accepted", "unknown", "rejected"].includes(body.outcome as string)))) throw new Error("invalid_request");
  } catch { return reply({ ok: false, code: "invalid_request" }, 400); }
  try {
    if (!performanceReviewMailEnabled()) throw new Error("disabled");
    const target = performanceReviewMailTarget();
    if (!authenticates(request.headers.get("X-MAM-Performance-Secret"), target.secret)) throw new Error("configuration_changed");
    if (body.phase === "readiness") return reply({ ok: true, ready: true });
    const admin = createAdminClient();
    const result = await budget.run(signal => body.phase === "begin"
      ? admin.rpc("begin_performance_review_mail", { p_delivery_id: body.deliveryId, p_claim_token: body.claimToken, p_attachment_sha256: body.attachmentSha256 }).retry(false).abortSignal(signal)
      : admin.rpc("finish_performance_review_mail", { p_delivery_id: body.deliveryId, p_claim_token: body.claimToken, p_attachment_sha256: body.attachmentSha256, p_outcome: body.outcome }).retry(false).abortSignal(signal));
    if (!performanceMailRpcSucceeded(result) || typeof result.data !== "boolean") throw new Error("invalid_result");
    return reply({ ok: true, [body.phase === "begin" ? "allowed" : "recorded"]: result.data });
  } catch { return reply({ ok: false, code: "unavailable" }, 503); }
}
