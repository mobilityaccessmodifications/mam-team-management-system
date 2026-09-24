"use server";

import { revalidatePath } from "next/cache";

import {
  completeCheckInReminderForHr,
  completeVisibleCheckInReminder as completeVisibleCheckInReminderForWorkspace,
  recordVisibleEmployeeCheckInReview,
  approveVisibleEmployeeCheckInEmploymentDecision,
  type RecordCheckInReviewInput,
} from "@/lib/check-in-register";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkedId(value: unknown) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("This check-in record is invalid. Refresh and try again.");
  }
  return value;
}

function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function checkedReviewInput(value: RecordCheckInReviewInput): RecordCheckInReviewInput {
  const outcome = value?.outcome;
  const reviewDate = typeof value?.reviewDate === "string" ? value.reviewDate : "";
  const notes = typeof value?.notes === "string" ? value.notes.trim() : "";
  const expectedVersion = value?.expectedVersion;
  if (
    !value
    || !UUID_PATTERN.test(value.reminderId)
    || (outcome !== "on_track" && outcome !== "follow_up_required" && outcome !== "hr_review_required"
      && outcome !== "probation_extension_pending_hr" && outcome !== "non_confirmation_pending_hr")
    || !isCalendarDate(reviewDate)
    || notes.length > 2000
    || (outcome !== "on_track" && !notes)
    || (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1))
  ) {
    throw new Error("Enter a valid review outcome and try again.");
  }
  return { reminderId: value.reminderId, outcome, reviewDate, notes, expectedVersion };
}

export async function approveCheckInEmploymentDecision(input: { reminderId: string; expectedVersion: number }) {
  const reminderId = checkedId(input?.reminderId);
  const expectedVersion = input?.expectedVersion;
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error("This review is invalid. Refresh and try again.");
  }
  await approveVisibleEmployeeCheckInEmploymentDecision({ reminderId, expectedVersion });
  revalidatePath("/");
  return { ok: true };
}

export async function completeCheckInReminder(reminderId: string) {
  await completeCheckInReminderForHr(checkedId(reminderId));
  revalidatePath("/");
  return { ok: true };
}

export async function completeVisibleCheckInReminder(reminderId: string) {
  await completeVisibleCheckInReminderForWorkspace(checkedId(reminderId));
  revalidatePath("/");
  return { ok: true };
}

export async function recordCheckInReview(input: RecordCheckInReviewInput) {
  await recordVisibleEmployeeCheckInReview(checkedReviewInput(input));
  revalidatePath("/");
  return { ok: true };
}
