import type { PerformanceInvitationStatusResult, PerformanceLoadResult } from "@/lib/performance-review-types";

export async function loadPerformanceReviews(previewPersonId?: string): Promise<PerformanceLoadResult> {
  const query = previewPersonId === undefined ? "" : "?" + new URLSearchParams({ previewPersonId });
  const response = await fetch("/api/performance-reviews/workspace" + query, {
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { Accept: "application/json" },
  });
  const result: PerformanceLoadResult = await response.json();
  if (typeof result?.ok !== "boolean" || (!response.ok && result.ok)) throw new Error("Reviews could not be loaded.");
  return result;
}

export async function loadPerformanceReviewMeetingInvitationStatus(reviewId: string, previewPersonId?: string): Promise<PerformanceInvitationStatusResult> {
  const query = new URLSearchParams({ reviewId });
  if (previewPersonId !== undefined) query.set("previewPersonId", previewPersonId);
  const response = await fetch("/api/performance-reviews/meeting-invitation-status?" + query, {
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { Accept: "application/json" },
  });
  const result: PerformanceInvitationStatusResult = await response.json();
  if (typeof result?.ok !== "boolean" || (!response.ok && result.ok)
    || (result.ok && (result.reviewId !== reviewId || typeof result.sent !== "boolean"))) throw new Error("Invitation status could not be loaded.");
  return result;
}
