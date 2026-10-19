import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import target from "../../deploy/n8n/performance-review-master-sync-v1/target.json";
import { closed, array, uuid, validateBinding, validateJob, bindingFingerprint, TARGET_KEY } from "../../deploy/n8n/performance-review-master-sync-v1/validate-job.mjs";

type MasterRequest = Record<string, unknown> & { phase: string };
const SHA = /^[0-9a-f]{64}$/;

export function masterConfigured() {
  if (process.env.MAM_SANDBOX_E2E?.trim().toLowerCase() === "true"
    || process.env.PERFORMANCE_REVIEW_MASTER_SYNC_MODE !== "live"
    || target.enabled !== true || target.singleWriterAdmitted !== true || target.binding === null) return false;
  try { validateBinding(target.binding); return true; } catch { return false; }
}

export function parseMasterRequest(raw: unknown): MasterRequest {
  const phase = raw && typeof raw === "object" ? Object.getOwnPropertyDescriptor(raw, "phase")?.value : undefined;
  const keys = phase === "readiness" || phase === "claim" ? ["phase"]
    : phase === "reconcile" ? ["phase", "jobId", "claimToken"]
    : phase === "begin" ? ["phase", "jobId", "claimToken", "revision", "projectionSha256", "targetFingerprint"]
    : phase === "finish" ? ["phase", "jobId", "claimToken", "revision", "projectionSha256", "outcome", "receipt"] : [];
  const v = closed(raw, keys) as MasterRequest;
  if (!["readiness", "claim", "begin", "finish", "reconcile"].includes(v.phase)) throw Error("invalid_request");
  if (v.phase === "readiness" || v.phase === "claim") return v;
  if (!uuid(v.jobId) || !uuid(v.claimToken)) throw Error("invalid_request");
  if (v.phase === "reconcile") return v;
  if (!Number.isSafeInteger(v.revision) || (v.revision as number) < 1 || typeof v.projectionSha256 !== "string" || !SHA.test(v.projectionSha256)) throw Error("invalid_request");
  if (v.phase === "begin") {
    if (typeof v.targetFingerprint !== "string" || !SHA.test(v.targetFingerprint)) throw Error("invalid_request");
    return v;
  }
  if (!["verified", "prewrite_failed", "unknown", "readback_pending"].includes(v.outcome as string)) throw Error("invalid_request");
  if (v.outcome !== "verified") {
    if (v.receipt !== null) throw Error("invalid_request");
    return v;
  }
  const r = closed(v.receipt, ["targetFingerprint", "reviewId", "revision", "projectionSha256", "range", "values"]);
  if (!uuid(r.reviewId) || r.revision !== v.revision || r.projectionSha256 !== v.projectionSha256
    || typeof r.targetFingerprint !== "string" || !SHA.test(r.targetFingerprint)
    || typeof r.range !== "string" || !/^[A-Z]{1,3}[1-9][0-9]{0,6}:[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(r.range)
    || array(r.values, 53).some((x: unknown, i: number) => !(typeof x === "string" && x.length <= 8000) && !(i === 15 && Number.isInteger(x) && (x as number) >= 5 && (x as number) <= 480))) throw Error("invalid_request");
  return v;
}

export async function runMasterPhase(body: MasterRequest) {
  if (body.phase === "readiness") return { ok: true, ready: masterConfigured() };
  if (!masterConfigured()) throw Error("disabled");
  const fingerprint = bindingFingerprint(target.binding);
  if (body.phase === "begin" && body.targetFingerprint !== fingerprint) throw Error("invalid_request");
  if (body.phase === "finish" && body.outcome === "verified" && (body.receipt as Record<string, unknown>).targetFingerprint !== fingerprint) throw Error("invalid_request");
  const admin = createAdminClient();
  const args = body.phase === "claim" ? { p_target_key: TARGET_KEY, p_limit: 1 }
    : body.phase === "reconcile" ? { p_job_id: body.jobId, p_claim_token: body.claimToken }
    : body.phase === "begin" ? { p_job_id: body.jobId, p_claim_token: body.claimToken, p_revision: body.revision, p_projection_sha256: body.projectionSha256, p_target_fingerprint: body.targetFingerprint }
    : { p_job_id: body.jobId, p_claim_token: body.claimToken, p_revision: body.revision, p_projection_sha256: body.projectionSha256, p_outcome: body.outcome, p_receipt: body.receipt };
  const signal = AbortSignal.timeout(10_000);
  const result = await admin.rpc(body.phase === "claim" ? "claim_performance_review_master_sync" : body.phase === "begin" ? "begin_performance_review_master_sync" : body.phase === "finish" ? "finish_performance_review_master_sync" : "reconcile_performance_review_master_sync", args).retry(false).abortSignal(signal);
  if (result.error !== null || signal.aborted) throw Error("unavailable");
  if (body.phase === "claim") {
    if (!Array.isArray(result.data) || result.data.length > 1) throw Error("invalid_result");
    for (const job of result.data) validateJob(job, target.binding);
    return { ok: true, jobs: result.data };
  }
  if (body.phase === "reconcile") {
    const decision = closed(result.data, ["decision"]);
    if (!["settled", "read_only", "hold", "denied"].includes(decision.decision)) throw Error("invalid_result");
    return { ok: true, ...decision };
  }
  if (typeof result.data !== "boolean") throw Error("invalid_result");
  return { ok: true, [body.phase === "begin" ? "allowed" : "recorded"]: result.data };
}
