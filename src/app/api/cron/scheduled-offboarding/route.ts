import { isUatMode } from "@/lib/uat-safety";
import { timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type Candidate = { person_id: string; auth_user_id: string | null; is_active: boolean };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  if (isUatMode()) return Response.json({ error: "This operation is unavailable in UAT." }, { status: 403 });
  const secret = process.env.CRON_SECRET?.trim();
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  const headers = { "Cache-Control": "no-store" };
  if (!secret || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return Response.json({ ok: false, code: "unauthorized" }, { status: 401, headers });
  }

  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("list_scheduled_employee_offboarding");
    if (error || !Array.isArray(data)) throw new Error("Schedule unavailable");
    let completed = 0;
    let failed = 0;
    for (const candidate of data as Candidate[]) {
      if (!candidate || !UUID.test(candidate.person_id) || (candidate.auth_user_id !== null && !UUID.test(candidate.auth_user_id))) {
        failed += 1;
        continue;
      }
      try {
        if (candidate.is_active) {
          const result = await admin.rpc("run_scheduled_employee_offboarding", { p_person_id: candidate.person_id });
          if (result.error) throw new Error("Archive failed");
          if (result.data !== true) continue;
        }
        const executorToken = randomUUID();
        const { data: claim, error: claimError } = await admin.rpc("claim_scheduled_offboarding_auth_ban", {
          p_person_id: candidate.person_id, p_executor_token: executorToken,
        });
        if (claimError || !claim || !["execute", "succeeded", "no_account"].includes(claim.state)
          || (claim.auth_user_id !== null && !UUID.test(claim.auth_user_id))
          || (claim.state === "no_account" && claim.auth_user_id !== null)
          || (claim.state !== "no_account" && !claim.auth_user_id)) throw new Error("Auth claim unresolved");
        if (claim.state === "execute") {
          let succeeded = false;
          try {
            const { data: banned, error: banError } = await admin.auth.admin.updateUserById(claim.auth_user_id, { ban_duration: "876000h" });
            if (!banError && banned.user?.id === claim.auth_user_id) {
              const { data: verified, error: verifyError } = await admin.auth.admin.getUserById(claim.auth_user_id);
              succeeded = !verifyError && verified.user?.id === claim.auth_user_id
                && !!verified.user.banned_until && Date.parse(verified.user.banned_until) > Date.now();
            }
          } catch { succeeded = false; }
          let recorded = false;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              const receipt = await admin.rpc("record_scheduled_offboarding_auth_ban", {
                p_person_id: candidate.person_id, p_auth_user_id: claim.auth_user_id,
                p_executor_token: executorToken, p_succeeded: succeeded,
              });
              if (!receipt.error && receipt.data === true) { recorded = true; break; }
            } catch { recorded = false; }
          }
          if (!succeeded || !recorded) throw new Error("Auth ban unresolved");
        }
        const result = await admin.rpc("confirm_scheduled_offboarding_auth_ban", { p_person_id: candidate.person_id });
        if (result.error || result.data !== true) throw new Error("Confirmation failed");
        completed += 1;
      } catch {
        failed += 1;
      }
    }
    return Response.json({ ok: failed === 0, completed, failed }, { status: failed ? 500 : 200, headers });
  } catch {
    return Response.json({ ok: false, code: "offboarding_failed" }, { status: 500, headers });
  }
}
