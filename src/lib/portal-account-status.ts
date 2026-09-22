import "server-only";

import type { createAdminClient } from "@/lib/supabase/admin";
import type { createClient } from "@/lib/supabase/server";

type AdminClient = ReturnType<typeof createAdminClient>;
type ServerClient = Awaited<ReturnType<typeof createClient>>;
type StatusInput = { personId: string; userId: string; enabled: boolean; accountVersion: number };
type CompletionInput = { personId: string; userId: string; changeToken: string };
const UNRESOLVED = "The account change is pending or needs provider reconciliation. Refresh before trying again.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function firstRow(data: unknown): Record<string, unknown> | null {
  return Array.isArray(data) && data[0] && typeof data[0] === "object" ? data[0] : null;
}

/** Prepare the exact status operation, calling Auth at most once across requests.
 * Callers must complete their domain work before finalising. On failure, retain
 * the claim: never compensate or cancel after an external write was attempted.
 */
export async function preparePortalAccountStatusChange(
  supabase: ServerClient,
  admin: AdminClient,
  input: StatusInput,
): Promise<{ changeToken: string }> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error("Your session has expired. Sign in again.");
  const args = {
    p_person_id: input.personId,
    p_auth_user_id: input.userId,
    p_enabled: input.enabled,
    p_expected_account_version: input.accountVersion,
  };
  let claim: Record<string, unknown> | null = null;
  try {
    const { data, error } = await supabase.rpc("begin_portal_account_status_change", args);
    if (!error) claim = firstRow(data);
  } catch {
    // A lost begin response may have reserved a claim. Inspect before taking
    // its executor; the reservation alone never permits an Auth mutation.
  }
  if (!claim) {
    try {
      const { data, error } = await supabase.rpc("inspect_portal_account_status_request", args);
      if (!error) claim = firstRow(data);
    } catch { /* Keep unresolved when read-back is unavailable. */ }
  }
  const changeToken = claim?.change_token;
  if (typeof changeToken !== "string" || !UUID.test(changeToken)) throw new Error(UNRESOLVED);

  const executorToken = crypto.randomUUID();
  // Do not retry this grant, including with the same UUID: a lost response is
  // not permission to execute. An executing claim has no automatic takeover.
  let execution: unknown;
  try {
    const { data, error } = await admin.rpc("claim_portal_account_status_execution", {
      p_auth_user_id: input.userId,
      p_change_token: changeToken,
      p_actor_user_id: userData.user.id,
      p_executor_token: executorToken,
    });
    if (!error) execution = data;
  } catch { /* An unknown grant outcome must not call Auth. */ }
  if (execution === "succeeded" || execution === "finalised") return { changeToken };
  if (execution !== "execute") throw new Error(UNRESOLVED);

  let succeeded = false;
  try {
    const { data, error } = await admin.auth.admin.updateUserById(input.userId, {
      ban_duration: input.enabled ? "none" : "876000h",
    });
    succeeded = !error && data.user?.id === input.userId;
  } catch {
    // A timeout can outlive this request. Never retry Auth, restore the prior
    // state, release the claim, or infer completion from a subsequent read.
  }

  let recorded = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { data, error } = await admin.rpc("record_portal_account_status_execution", {
        p_auth_user_id: input.userId,
        p_change_token: changeToken,
        p_executor_token: executorToken,
        p_succeeded: succeeded,
      });
      if (!error && data === true) { recorded = true; break; }
    } catch { /* Only this durable receipt, never Auth, may be retried. */ }
  }
  if (!succeeded || !recorded) throw new Error(UNRESOLVED);
  return { changeToken };
}

/** Safe after a confirmed provider receipt, including from another request. */
export async function finalisePortalAccountStatusChange(
  supabase: ServerClient,
  input: CompletionInput,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { data, error } = await supabase.rpc("finalise_portal_account_status_change", {
        p_person_id: input.personId,
        p_auth_user_id: input.userId,
        p_change_token: input.changeToken,
      });
      const row = firstRow(data);
      if (!error && row?.person_id === input.personId && row.auth_user_id === input.userId) return;
    } catch { /* Token-fenced database completion is safe to retry. */ }
  }
  try {
    const { data, error } = await supabase.rpc("inspect_portal_account_status_change", {
      p_auth_user_id: input.userId,
      p_change_token: input.changeToken,
    });
    const row = firstRow(data);
    if (!error && row?.person_id === input.personId && row.auth_user_id === input.userId
      && row.claim_status === "finalised") return;
  } catch { /* Preserve the claim for a database-only completion retry. */ }
  throw new Error(UNRESOLVED);
}

/** For archive retries after the person already became inactive. This path
 * only reads the original receipt and finalises Postgres; it cannot call Auth,
 * acquire an executor, cancel a claim or start a new operation.
 */
export async function recoverPortalAccountStatusChange(
  supabase: ServerClient,
  input: StatusInput,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("inspect_portal_account_status_request", {
    p_person_id: input.personId,
    p_auth_user_id: input.userId,
    p_enabled: input.enabled,
    p_expected_account_version: input.accountVersion,
  });
  if (error) throw new Error(UNRESOLVED);
  const row = firstRow(data);
  if (!row || row.provider_status !== "succeeded"
    || !["pending", "finalised"].includes(String(row.claim_status))) return false;
  if (typeof row.change_token !== "string" || !UUID.test(row.change_token)) throw new Error(UNRESOLVED);
  await finalisePortalAccountStatusChange(supabase, { personId: input.personId, userId: input.userId, changeToken: row.change_token });
  return true;
}
