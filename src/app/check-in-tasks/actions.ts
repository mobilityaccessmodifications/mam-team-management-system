"use server";

import { revalidatePath } from "next/cache";

import { completeMyEmployeeCheckInTask as completeTask } from "@/lib/check-in-tasks";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkedReminderId(value: unknown) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("This check-in task is invalid. Refresh and try again.");
  }
  return value;
}

export async function completeMyEmployeeCheckInTask(reminderId: string) {
  await completeTask(checkedReminderId(reminderId));
  revalidatePath("/");
  return { ok: true };
}
