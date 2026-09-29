import { timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type Candidate = { person_id: string; auth_user_id: string | null; is_active: boolean };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
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
        if (candidate.auth_user_id) {
          const { data: banned, error: banError } = await admin.auth.admin.updateUserById(candidate.auth_user_id, { ban_duration: "876000h" });
          if (banError || banned.user?.id !== candidate.auth_user_id) throw new Error("Auth ban unconfirmed");
          const { data: verified, error: verifyError } = await admin.auth.admin.getUserById(candidate.auth_user_id);
          if (verifyError || verified.user?.id !== candidate.auth_user_id
            || !verified.user.banned_until || Date.parse(verified.user.banned_until) <= Date.now()) {
            throw new Error("Auth ban not verified");
          }
        }
        const result = await admin.rpc("confirm_scheduled_offboarding_auth_ban", { p_person_id: candidate.person_id });
        if (result.error) throw new Error("Confirmation failed");
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
