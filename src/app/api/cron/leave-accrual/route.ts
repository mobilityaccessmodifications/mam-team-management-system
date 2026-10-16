import { isUatMode } from "@/lib/uat-safety";
import { timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** Daily private checkpoint; no email dispatch and no client-selected dates. */
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
    const { data, error } = await createAdminClient().rpc("refresh_employee_leave_accrual");
    if (error || !Number.isInteger(data) || data < 0) throw new Error("Checkpoint failed");
    return Response.json({ ok: true, recorded: data }, { headers });
  } catch {
    return Response.json({ ok: false, code: "accrual_failed" }, { status: 500, headers });
  }
}
