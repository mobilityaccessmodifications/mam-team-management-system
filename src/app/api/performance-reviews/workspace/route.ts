import { loadPerformanceReviews } from "@/app/performance-reviews/actions";
import type { PerformanceLoadResult } from "@/lib/performance-review-types";

export const dynamic = "force-dynamic";

function respond(result: PerformanceLoadResult) {
  const status = result.ok ? 200 : result.code === "unauthenticated" ? 401 : result.code === "forbidden" ? 403 : result.code === "invalid" ? 400 : 503;
  return Response.json(result, { status, headers: { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" } });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (Array.from(params.keys()).some(key => key !== "previewPersonId") || params.getAll("previewPersonId").length > 1) {
    return respond({ ok: false, code: "invalid", uncertain: false, message: "Check the review fields." });
  }
  try {
    return respond(await loadPerformanceReviews(params.get("previewPersonId") ?? undefined));
  } catch {
    return respond({ ok: false, code: "unavailable", uncertain: false, message: "Performance reviews are not available." });
  }
}
