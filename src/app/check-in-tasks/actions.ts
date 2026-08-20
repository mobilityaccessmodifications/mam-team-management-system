"use server";

import { revalidatePath } from "next/cache";

import {
  completeMyEmployeeCheckInTask as completeTask,
  getMyEmployeeCheckInTasks as getTasks,
} from "@/lib/check-in-tasks";
import type { CheckInTasksData } from "@/lib/check-in-tasks-types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkedReminderId(value: unknown) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("This check-in task is invalid. Refresh and try again.");
  }
  return value;
}

/**
 * Manager-safe action. The DAL and the database function both re-authorise
 * the signed-in caller; a client-rendered task list never grants access.
 */
export async function getMyEmployeeCheckInTasks(): Promise<CheckInTasksData> {
  return getTasks();
}

export async function completeMyEmployeeCheckInTask(reminderId: string) {
  await completeTask(checkedReminderId(reminderId));
  revalidatePath("/");
  return { ok: true };
}
