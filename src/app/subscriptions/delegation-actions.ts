"use server";
import { revalidatePath } from "next/cache";
import { requirePortalRoleActor } from "@/lib/portal-role-access";
import type { SubscriptionCredentialAccessGrant } from "@/lib/subscription-credential-types";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOAD_ERROR = "Subscription management access could not be loaded. Refresh and try again.";
const SAVE_ERROR = "Subscription management access could not be saved. Refresh and try again.";
async function requireManagementGrantAdministrator() {
  const { supabase, capabilities } = await requirePortalRoleActor();
  if (!capabilities.is_super_admin || !capabilities.can_manage_subscription_management_grants) throw new Error(SAVE_ERROR);
  return supabase;
}
export async function listSubscriptionManagementDelegates(): Promise<
  { ok: true; delegates: SubscriptionCredentialAccessGrant[] } | { ok: false; message: string }
> {
  try {
    const supabase = await requireManagementGrantAdministrator();
    const { data, error } = await supabase.rpc("list_subscription_management_delegates");
    if (error || !Array.isArray(data)) throw new Error(LOAD_ERROR);
    const delegates = data.map(row => {
      if (!row || typeof row.person_id !== "string" || !UUID_PATTERN.test(row.person_id)
        || typeof row.full_name !== "string" || !row.full_name.trim() || typeof row.position_title !== "string" || !row.position_title.trim()) throw new Error(LOAD_ERROR);
      return { personId: row.person_id, fullName: row.full_name, positionTitle: row.position_title };
    });
    return { ok: true, delegates };
  } catch { return { ok: false, message: LOAD_ERROR }; }
}
export async function replaceSubscriptionManagementDelegates(personIds: string[]): Promise<
  { ok: true } | { ok: false; message: string; committed?: boolean }
> {
  let committed = false;
  try {
    if (!Array.isArray(personIds) || personIds.length > 24 || new Set(personIds).size !== personIds.length
      || personIds.some(id => typeof id !== "string" || !UUID_PATTERN.test(id))) return { ok: false, message: "Choose a valid unique list of active Managers." };
    const supabase = await requireManagementGrantAdministrator();
    const { error } = await supabase.rpc("replace_subscription_management_delegates", { p_person_ids: personIds });
    if (error) throw new Error(SAVE_ERROR);
    committed = true;
    revalidatePath("/");
    return { ok: true };
  } catch {
    return committed ? { ok: false, committed: true, message: "Subscription management access was saved, but could not be refreshed. Refresh before saving again." } : { ok: false, message: SAVE_ERROR };
  }
}
