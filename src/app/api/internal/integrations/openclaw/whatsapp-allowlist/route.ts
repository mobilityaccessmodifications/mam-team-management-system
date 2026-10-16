import { isUatMode } from "@/lib/uat-safety";
import { allowlistAuthorization, allowlistSnapshot } from "@/lib/openclaw-allowlist";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  "Vary": "Authorization",
  "X-Content-Type-Options": "nosniff",
};

export async function GET(request: Request) {
  if (isUatMode()) return Response.json({ error: "This operation is unavailable in UAT." }, { status: 403 });
  const status = allowlistAuthorization(request, process.env.MAM_OPENCLAW_ALLOWLIST_SECRET);
  if (status !== 200) {
    return Response.json({ code: status === 401 ? "unauthorized" : "unavailable" }, { status, headers });
  }
  // No filters, pagination, query-string secrets or caller-selected company.
  if (new URL(request.url).search) {
    return Response.json({ code: "invalid_request" }, { status: 400, headers });
  }
  try {
    // Timestamp precedes the query so a slow request cannot rejuvenate old data.
    const generatedAt = new Date().toISOString();
    const { data, error } = await createAdminClient()
      .rpc("openclaw_whatsapp_allowlist_snapshot_v2")
      .abortSignal(AbortSignal.timeout(8000));
    if (error) throw new Error("Snapshot unavailable");
    return Response.json(allowlistSnapshot(data, generatedAt), { headers });
  } catch {
    // Never send DB details, source rows, or a success-shaped empty fallback.
    return Response.json({ code: "unavailable" }, { status: 503, headers });
  }
}
