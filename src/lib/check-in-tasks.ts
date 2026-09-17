import "server-only";

import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS_ERROR = "You do not have permission to view check-in tasks.";
const SESSION_ERROR = "Your session has expired. Sign in again.";

async function requireAuthenticatedClient() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error(SESSION_ERROR);
  return supabase;
}

/** Completes one task after both application and database scope checks. */
export async function completeMyEmployeeCheckInTask(reminderId: string) {
  if (!UUID_PATTERN.test(reminderId)) throw new Error("This check-in task is invalid. Refresh and try again.");

  const supabase = await requireAuthenticatedClient();
  const { error } = await supabase.rpc("complete_my_employee_check_in_task", {
    p_reminder_id: reminderId,
  });
  if (error) {
    if (error.code === "42501") throw new Error(ACCESS_ERROR);
    throw new Error("The check-in task could not be marked complete. Refresh and try again.");
  }
}
