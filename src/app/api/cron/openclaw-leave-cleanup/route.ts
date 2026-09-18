import { timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };

/** Protocol-cache cleanup only; never deletes the HR leave/audit records. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const candidate = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  if (!secret || candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    return Response.json({ code: "unauthorized" }, { status: 401, headers });
  }
  // Deliberately independent of LEAVE_ENABLED so disabling submissions does
  // not strand old sensitive summaries. No request parameter controls scope.
  try {
    const client = createAdminClient();
    const deadline = Date.now() + 40_000;
    for (let batch = 0; batch < 100 && Date.now() < deadline; batch++) {
      const result = await client.rpc("prune_openclaw_leave_state").abortSignal(AbortSignal.timeout(5000));
      if (result.error || typeof result.data?.remaining !== "boolean") throw new Error("cleanup failed");
      if (!result.data.remaining) return Response.json({ code: "complete" }, { headers });
    }
    // A backlog must be observable, never silently reported as cleaned.
    return Response.json({ code: "cleanup_incomplete" }, { status: 503, headers });
  } catch {
    return Response.json({ code: "cleanup_failed" }, { status: 503, headers });
  }
}
