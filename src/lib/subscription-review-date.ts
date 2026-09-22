/** Compare date-only review schedules in the business timezone, not the device timezone. */
export function subscriptionReviewWindow(nextReviewOn: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)!.value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  if (nextReviewOn <= today) return "due";

  // UTC is only used for calendar arithmetic on the Melbourne date. Adding
  // milliseconds to an instant would make DST and the device timezone matter.
  const horizon = new Date(`${today}T00:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + 30);
  return nextReviewOn <= horizon.toISOString().slice(0, 10) ? "next30" : "later";
}
