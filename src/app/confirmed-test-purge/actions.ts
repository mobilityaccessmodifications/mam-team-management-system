"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runConfirmedTestIdentityPurge, type ConfirmedTestPurgeInput } from "@/lib/confirmed-test-identity-purge";

export async function confirmedTestIdentityPurge(input: ConfirmedTestPurgeInput) {
  const result = await runConfirmedTestIdentityPurge(await createClient(), input?.authUserId === null ? null : createAdminClient(), input);
  if (result?.phase === "complete") revalidatePath("/");
  return result;
}
