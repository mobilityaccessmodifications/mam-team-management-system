import { loadPerformanceReviewMeetingInvitationStatus } from "@/app/performance-reviews/actions";
import type { PerformanceInvitationStatusResult } from "@/lib/performance-review-types";

export const dynamic = "force-dynamic";

function respond(result: PerformanceInvitationStatusResult) {
  const status = result.ok ? 200 : result.code === "unauthenticated" ? 401 : result.code === "forbidden" ? 403 : result.code === "invalid" ? 400 : 503;
  return Response.json(result, { status, headers: { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" } });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (Array.from(params.keys()).some(key => !["reviewId", "previewPersonId"].includes(key))
    || params.getAll("reviewId").length !== 1 || params.getAll("previewPersonId").length > 1) {
    return respond({ ok: false, code: "invalid", uncertain: false, message: "Check the review fields." });
  }
  try {
    return respond(await loadPerformanceReviewMeetingInvitationStatus(params.get("reviewId")!, params.get("previewPersonId") ?? undefined));
  } catch {
    return respond({ ok: false, code: "unavailable", uncertain: false, message: "Performance reviews are not available." });
  }
}
