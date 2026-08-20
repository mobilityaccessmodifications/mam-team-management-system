"use server";

import { revalidatePath } from "next/cache";

import {
  completeCheckInReminderForHr,
  completeVisibleCheckInReminder as completeVisibleCheckInReminderForWorkspace,
  getCheckInRegisterForHr,
  getVisibleCheckInWorkspace,
} from "@/lib/check-in-register";
import type {
  CheckInRegisterData,
  CheckInWorkspaceData,
} from "@/lib/check-in-register-types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkedId(value: unknown) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("This check-in record is invalid. Refresh and try again.");
  }
  return value;
}

/** HR-only data action. The DAL and database RPC both re-authorise the caller. */
export async function getCheckInRegister(): Promise<CheckInRegisterData> {
  return getCheckInRegisterForHr();
}

export async function completeCheckInReminder(reminderId: string) {
  await completeCheckInReminderForHr(checkedId(reminderId));
  revalidatePath("/");
  return { ok: true };
}

/**
 * Minimal manager/global-reviewer action. The database resolves the caller's
 * live reporting-line scope and re-authorises the selected reminder.
 */
export async function getCheckInWorkspace(): Promise<CheckInWorkspaceData> {
  return getVisibleCheckInWorkspace();
}

export async function completeVisibleCheckInReminder(reminderId: string) {
  await completeVisibleCheckInReminderForWorkspace(checkedId(reminderId));
  revalidatePath("/");
  return { ok: true };
}
