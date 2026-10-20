import type { PerformanceLoadResult } from "@/lib/performance-review-types";

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
