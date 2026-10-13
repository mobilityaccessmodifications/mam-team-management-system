"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { parseSubscriptionReviewTasks, SUBSCRIPTION_REVIEW_UUID, type SubscriptionReviewTask } from "@/lib/subscription-review-tasks";

type CompletionResult = { ok: true; task?: SubscriptionReviewTask; warning?: string } | { ok: false; error: string };
const FAILED = "The subscription review could not be recorded. Refresh and try again.";
const RECORDED = "The review was recorded. Refresh to load the updated task.";

export async function completeMySubscriptionReviewTask(input: {
  subscriptionId: string;
  version: number;
  previewPersonId?: string;
}): Promise<CompletionResult> {
  if (!input || input.previewPersonId !== undefined) return { ok: false, error: "Change profile is read-only for subscription reviews." };
  if (typeof input.subscriptionId !== "string" || !SUBSCRIPTION_REVIEW_UUID.test(input.subscriptionId)
    || !Number.isSafeInteger(input.version) || input.version < 1) {
    return { ok: false, error: "This subscription review task is invalid. Refresh and try again." };
  }
  let task: SubscriptionReviewTask;
  try {
    const supabase = await createClient();
    const { data: auth, error: authError } = await supabase.auth.getUser();
    if (authError || !auth.user) return { ok: false, error: "Your session has expired. Sign in again." };
    const { data, error } = await supabase.rpc("complete_my_subscription_review_task", {
      p_subscription_id: input.subscriptionId, p_expected_version: input.version,
    });
    if (error) return { ok: false, error: error.code === "40001"
      ? "This subscription has changed. Refresh it, then try again."
      : error.code === "42501" ? "You do not have permission to complete this subscription review yet." : FAILED };
    try {
      [task] = parseSubscriptionReviewTasks([data]);
      if (task.subscriptionId !== input.subscriptionId || task.version !== input.version + 1) return { ok: true, warning: RECORDED };
    } catch {
      return { ok: true, warning: RECORDED };
    }
  } catch {
    return { ok: false, error: FAILED };
  }
  try {
    revalidatePath("/");
  } catch {
    return { ok: true, task, warning: RECORDED };
  }
  return { ok: true, task };
}
