import "server-only";

import {
  CHECK_IN_TASK_LOAD_ERROR,
  parseCheckInTasks,
} from "@/lib/check-in-tasks-data";
import { createClient } from "@/lib/supabase/server";
import type { CheckInTasksData } from "@/lib/check-in-tasks-types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS_ERROR = "You do not have permission to view check-in tasks.";

/** Returns the minimal, current-user-scoped check-in task list. */
export async function getMyEmployeeCheckInTasks(): Promise<CheckInTasksData> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_my_employee_check_in_tasks");
  if (error) {
    if (error.code === "42501") throw new Error(ACCESS_ERROR);
    throw new Error(CHECK_IN_TASK_LOAD_ERROR);
  }
  return parseCheckInTasks(data);
}

/** Read-only Change view projection; the RPC is Super Admin-only. */
export async function getEmployeeCheckInTasksForPreview(personId: string): Promise<CheckInTasksData> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_employee_check_in_tasks_for_preview", {
    p_person_id: personId,
  });
  if (error) throw new Error(CHECK_IN_TASK_LOAD_ERROR);
  return parseCheckInTasks(data);
}

/** Completes one task after both application and database scope checks. */
export async function completeMyEmployeeCheckInTask(reminderId: string) {
  if (!UUID_PATTERN.test(reminderId)) throw new Error("This check-in task is invalid. Refresh and try again.");

  const supabase = await createClient();
  const { error } = await supabase.rpc("complete_my_employee_check_in_task", {
    p_reminder_id: reminderId,
  });
  if (error) {
    if (error.code === "42501") throw new Error(ACCESS_ERROR);
    throw new Error("The check-in task could not be marked complete. Refresh and try again.");
  }
}
