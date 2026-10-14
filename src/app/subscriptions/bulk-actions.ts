"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { subscriptionPatchValues, type SubscriptionBulkPatch } from "@/lib/subscription-bulk";

export async function patchSubscription(input: { id: string; version: number; patch: SubscriptionBulkPatch }): Promise<void> {
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error("Your session has expired. Sign in again.");
  const { data: allowed, error: permissionError } = await supabase.rpc("can_manage_subscriptions");
  if (permissionError?.code === "42501" || (!permissionError && allowed === false)) throw new Error("You do not have permission to manage subscriptions.");
  if (permissionError || allowed !== true) throw new Error("This subscription could not be updated. Refresh and try again.");
  if (!input || typeof input.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id)
    || !Number.isSafeInteger(input.version) || input.version < 1) throw new Error("The subscription record is invalid.");
  const patch = subscriptionPatchValues(input.patch);
  const { error } = await supabase.rpc("patch_subscription_v1", {
    p_subscription_id: input.id,
    p_expected_version: input.version,
    p_patch: patch,
  });
  if (error) {
    if (error.code === "40001") throw new Error("This subscription has changed. Refresh it, then try again.");
    if (error.code === "23503") throw new Error("Choose an active responsible employee.");
    if (error.code === "42501") throw new Error("You do not have permission to manage subscriptions.");
    throw new Error("This subscription could not be updated. Refresh and try again.");
  }
  revalidatePath("/");
}
