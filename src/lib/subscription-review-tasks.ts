export type SubscriptionReviewTask = {
  subscriptionId: string;
  serviceName: string;
  nextReviewOn: string;
  status: "active" | "paused";
  version: number;
  canComplete: boolean;
};

export const SUBSCRIPTION_REVIEW_LOAD_ERROR = "Subscription review tasks could not be loaded. Refresh and try again.";
export const SUBSCRIPTION_REVIEW_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSubscriptionReviewTasks(data: unknown, now = new Date()): SubscriptionReviewTask[] {
  if (!Array.isArray(data)) throw new Error(SUBSCRIPTION_REVIEW_LOAD_ERROR);
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  const seen = new Set<string>();
  return data.map((value: unknown): SubscriptionReviewTask => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(SUBSCRIPTION_REVIEW_LOAD_ERROR);
    const row = value as Record<string, unknown>;
    if (typeof row.subscription_id !== "string" || !SUBSCRIPTION_REVIEW_UUID.test(row.subscription_id)
      || seen.has(row.subscription_id)
      || typeof row.service_name !== "string" || !row.service_name.trim()
      || typeof row.next_review_on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.next_review_on)
      || !Number.isSafeInteger(row.version) || (row.version as number) < 1
      || (row.subscription_status !== "active" && row.subscription_status !== "paused")) {
      throw new Error(SUBSCRIPTION_REVIEW_LOAD_ERROR);
    }
    const date = new Date(`${row.next_review_on}T12:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== row.next_review_on) throw new Error(SUBSCRIPTION_REVIEW_LOAD_ERROR);
    seen.add(row.subscription_id);
    return {
      subscriptionId: row.subscription_id, serviceName: row.service_name, nextReviewOn: row.next_review_on,
      status: row.subscription_status, version: row.version as number, canComplete: row.next_review_on <= today,
    };
  }).sort((a, b) => a.nextReviewOn.localeCompare(b.nextReviewOn) || a.serviceName.localeCompare(b.serviceName));
}
