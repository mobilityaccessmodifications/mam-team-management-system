"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { SUBSCRIPTION_PASSWORD_UUID } from "@/lib/subscription-password-tasks";

type CompletionResult = { ok: true; warning?: string } | { ok: false; error: string };
const FAILED = "The password change could not be recorded. Refresh and try again.";
const RECORDED = "The password change was recorded. Refresh to load the updated tasks.";

export async function completeMySubscriptionPasswordTask(input: {
  taskId: string;
  version: number;
  passwordChanged: true;
  previewPersonId?: string;
}): Promise<CompletionResult> {
  if (!input || input.previewPersonId !== undefined) return { ok: false, error: "Change profile is read-only for subscription passwords." };
  if (typeof input.taskId !== "string" || !SUBSCRIPTION_PASSWORD_UUID.test(input.taskId)
    || !Number.isSafeInteger(input.version) || input.version < 1 || input.version >= Number.MAX_SAFE_INTEGER || input.passwordChanged !== true) {
    return { ok: false, error: "Confirm the subscription password has been changed and refresh before trying again." };
  }
  try {
    const supabase = await createClient();
    const { data: auth, error: authError } = await supabase.auth.getUser();
    if (authError || !auth.user) return { ok: false, error: "Your session has expired. Sign in again." };
    const { data, error } = await supabase.rpc("complete_my_subscription_password_task", {
      p_task_id: input.taskId, p_expected_version: input.version, p_password_changed: true,
    });
    if (error) return { ok: false, error: error.code === "40001"
      ? "This password task has changed. Refresh it, then try again."
      : error.code === "42501" ? "You do not have permission to complete this password task." : FAILED };
    if (!data || data.task_id !== input.taskId || data.version !== input.version + 1 || data.completed !== true) return { ok: true, warning: RECORDED };
  } catch {
    return { ok: false, error: FAILED };
  }
  try { revalidatePath("/"); } catch { return { ok: true, warning: RECORDED }; }
  return { ok: true };
}
