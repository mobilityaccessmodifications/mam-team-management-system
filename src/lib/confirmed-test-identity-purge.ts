import "server-only";

import type { createAdminClient } from "@/lib/supabase/admin";
import type { createClient } from "@/lib/supabase/server";

type SessionClient = Awaited<ReturnType<typeof createClient>>;
type AdminClient = ReturnType<typeof createAdminClient>;
type Identity = {
  personId: string;
  authUserId: string | null;
  companyKey: "mam" | "equipsy";
  fullName: string;
  loginName: string | null;
  personVersion: number;
  accountVersion: number | null;
};
export type ConfirmedTestPurgeInput =
  | (Identity & { mode: "preview" })
  | (Identity & { mode: "apply"; manifestHash: string; confirmTestOnly: true; destroyExclusiveHistory: true })
  | { mode: "reconcile"; personId: string; authUserId: string | null };
type Receipt = { id: string; person_id: string; auth_user_id: string | null; phase: "business_purged" | "auth_delete_started" | "complete"; manifest_hash: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PENDING = "Purge outcome requires reconciliation; do not retry Auth deletion.";

export async function runConfirmedTestIdentityPurge(session: SessionClient, admin: AdminClient | null, input: ConfirmedTestPurgeInput, options: { timeoutMs?: number } = {}) {
  const deadline = Date.now() + Math.min(15000, Math.max(1, options.timeoutMs ?? 15000));
  const bounded = async <T>(operation: () => PromiseLike<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(PENDING);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(PENDING)), remaining); })]);
    } finally { clearTimeout(timer); }
  };
  if (!input || !UUID.test(input.personId) || (input.authUserId !== null && !UUID.test(input.authUserId)) || !["preview", "apply", "reconcile"].includes(input.mode)) throw new Error("Invalid exact purge identity.");
  if (input.authUserId !== null && !admin) throw new Error("Auth administration service required.");
  if (input.mode !== "reconcile" && (!["mam", "equipsy"].includes(input.companyKey) || typeof input.fullName !== "string" || !input.fullName.trim() || input.fullName.length > 200 || !Number.isSafeInteger(input.personVersion) || input.personVersion < 1 || (input.authUserId === null ? input.loginName !== null || input.accountVersion !== null : typeof input.loginName !== "string" || !input.loginName || !Number.isSafeInteger(input.accountVersion) || input.accountVersion! < 1))) throw new Error("Invalid exact purge confirmation.");
  if (input.mode === "apply" && (input.confirmTestOnly !== true || input.destroyExclusiveHistory !== true || !/^[a-f0-9]{64}$/.test(input.manifestHash))) throw new Error("Explicit test-only and permanent history destruction confirmations required.");
  const { data: user, error: authError } = await bounded(() => session.auth.getUser());
  if (authError || !user.user || user.user.id === input.authUserId) throw new Error("An actual active System Admin session distinct from the target is required.");
  const { data: allowed, error: permissionError } = await bounded(() => session.rpc("can_change_employee_view"));
  if (permissionError || allowed !== true) throw new Error("Active System Admin required.");
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await bounded(() => session.rpc(name, args));
    if (error) throw new Error(["23503", "23514", "40001", "55000", "42501"].includes(error.code) ? error.message : PENDING);
    return data;
  };
  const identityArgs = input.mode === "reconcile" ? {} : {
    p_person_id: input.personId, p_auth_user_id: input.authUserId, p_company_key: input.companyKey,
    p_full_name: input.fullName, p_login_name: input.loginName, p_person_version: input.personVersion,
    p_account_version: input.accountVersion,
  };
  if (input.mode === "preview") return rpc("preview_confirmed_test_identity_purge", identityArgs);
  let receipt = await rpc("get_confirmed_test_identity_purge", { p_person_id: input.personId }) as Receipt | null;
  if (!receipt && input.mode === "apply") {
    if (input.authUserId !== null) {
      const { data, error } = await bounded(() => admin!.auth.admin.getUserById(input.authUserId!));
      if (error || data.user?.id !== input.authUserId || !data.user.banned_until || !Number.isFinite(Date.parse(data.user.banned_until)) || Date.parse(data.user.banned_until) <= Date.now()) throw new Error("Exact linked Auth account must already be banned before business destruction.");
    }
    try {
      await rpc("prepare_confirmed_test_identity_purge", { ...identityArgs, p_manifest_hash: input.manifestHash, p_confirm_test_only: true, p_destroy_exclusive_history: true });
    } catch (error) {
      receipt = await rpc("get_confirmed_test_identity_purge", { p_person_id: input.personId }) as Receipt | null;
      if (!receipt) throw error;
    }
    receipt = await rpc("get_confirmed_test_identity_purge", { p_person_id: input.personId }) as Receipt | null;
  }
  if (!receipt || receipt.person_id !== input.personId || receipt.auth_user_id !== input.authUserId || !UUID.test(receipt.id) || (input.mode === "apply" && receipt.manifest_hash !== input.manifestHash)) throw new Error(PENDING);
  if (receipt.phase === "complete") return receipt;
  if (receipt.auth_user_id === null) throw new Error(PENDING);
  if (input.mode === "apply" && receipt.phase === "business_purged") {
    let claim: { id: string; auth_user_id: string; delete_authorized: boolean };
    try {
      claim = await rpc("claim_confirmed_test_identity_auth_delete", { p_receipt_id: receipt.id });
    } catch { return { ...receipt, phase: "reconciliation_required" }; }
    if (claim.id !== receipt.id || claim.auth_user_id !== receipt.auth_user_id || claim.delete_authorized !== true) return { ...receipt, phase: "reconciliation_required" };
    await bounded(() => admin!.auth.admin.deleteUser(receipt!.auth_user_id!, false)).catch(() => null);
  }
  let readback: Awaited<ReturnType<AdminClient["auth"]["admin"]["getUserById"]>>;
  try { readback = await bounded(() => admin!.auth.admin.getUserById(receipt!.auth_user_id!)); } catch { return { ...receipt, phase: "reconciliation_required" }; }
  const { data: remaining, error: readError } = readback;
  if (remaining.user || readError?.code !== "user_not_found") return { ...receipt, phase: "reconciliation_required" };
  try { await rpc("complete_confirmed_test_identity_purge", { p_receipt_id: receipt.id }); } catch { return { ...receipt, phase: "reconciliation_required" }; }
  const verified = await rpc("get_confirmed_test_identity_purge", { p_person_id: input.personId }) as Receipt | null;
  if (!verified || verified.id !== receipt.id || verified.phase !== "complete") throw new Error(PENDING);
  return verified;
}
