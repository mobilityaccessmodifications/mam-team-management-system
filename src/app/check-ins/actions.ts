"use server";

import { revalidatePath } from "next/cache";

import {
  completeCheckInReminderForHr,
  completeVisibleCheckInReminder as completeVisibleCheckInReminderForWorkspace,
} from "@/lib/check-in-register";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkedId(value: unknown) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("This check-in record is invalid. Refresh and try again.");
  }
  return value;
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
