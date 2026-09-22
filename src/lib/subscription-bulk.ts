import type { SubscriptionCompany, SubscriptionStatus } from "@/lib/subscription-types";

export type SubscriptionBulkPatch = {
  company?: SubscriptionCompany;
  status?: SubscriptionStatus;
  responsiblePersonId?: string;
};

export type SubscriptionBulkTarget = { id: string; version: number; serviceName: string };
export type SubscriptionBulkFailure = { id: string; serviceName: string; message: string };
export type SubscriptionBulkResult = { updatedIds: string[]; failures: SubscriptionBulkFailure[] };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The client sends only selected fields, and the server rejects extra keys. */
export function subscriptionPatchValues(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Choose fields to update.");
  const patch = input as Record<string, unknown>;
  const keys = Object.keys(patch);
  if (!keys.length || keys.some((key) => !["company", "status", "responsiblePersonId"].includes(key))) {
    throw new Error("Choose valid subscription fields to update.");
  }
  const values: Record<string, string> = {};
  if ("company" in patch) {
    if (typeof patch.company !== "string" || !["mam", "equipsy", "both"].includes(patch.company)) throw new Error("Choose MAM, Equipsy or Both.");
    values.company_scope = patch.company;
  }
  if ("status" in patch) {
    if (typeof patch.status !== "string" || !["active", "paused", "cancelled"].includes(patch.status)) throw new Error("Choose a valid subscription status.");
    values.subscription_status = patch.status;
  }
  if ("responsiblePersonId" in patch) {
    if (typeof patch.responsiblePersonId !== "string" || !uuid.test(patch.responsiblePersonId)) throw new Error("Choose a responsible employee.");
    values.responsible_person_id = patch.responsiblePersonId;
  }
  return values;
}

/** Each record keeps its own transaction and result; failed rows stay selected. */
export async function runSubscriptionBulkEdit(
  targets: SubscriptionBulkTarget[],
  patch: SubscriptionBulkPatch,
  save: (target: SubscriptionBulkTarget, patch: SubscriptionBulkPatch) => Promise<unknown>,
  onProgress?: (completed: number) => void,
): Promise<SubscriptionBulkResult> {
  subscriptionPatchValues(patch);
  if (!targets.length || targets.length > 250 || new Set(targets.map((target) => target.id)).size !== targets.length) {
    throw new Error("Select between 1 and 250 subscriptions.");
  }
  const result: SubscriptionBulkResult = { updatedIds: [], failures: [] };
  for (const target of targets) {
    try {
      await save(target, patch);
      result.updatedIds.push(target.id);
    } catch (error) {
      result.failures.push({ id: target.id, serviceName: target.serviceName, message: error instanceof Error ? error.message : "Could not update. Refresh and try again." });
    }
    onProgress?.(result.updatedIds.length + result.failures.length);
  }
  return result;
}
