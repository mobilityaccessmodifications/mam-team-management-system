import "server-only";
import { createAdminClient } from "./supabase/admin";
import type { BridgeResult, LeaveSnapshot, LeaveStore } from "./openclaw-leave-contract";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function createLeaveBridgeStore(): LeaveStore {
  return {
    async snapshot(key, draftId) {
      const response = await createAdminClient().rpc("openclaw_leave_v3_snapshot", { p_key: key, p_draft_id: draftId })
        .abortSignal(AbortSignal.timeout(8000));
      const snapshot = response.data as LeaveSnapshot;
      if (response.error || !snapshot || snapshot.complete !== true || !Array.isArray(snapshot.rows)
        || snapshot.rows.length > 10000 || !/^[a-f0-9]{64}$/.test(snapshot.fingerprint)) throw new Error("unavailable");
      return snapshot;
    },
    async submit(plan) {
      const response = await createAdminClient().rpc("openclaw_leave_v3_submit", {
        p_key: plan.key, p_body_fingerprint: plan.fingerprint, p_source_fingerprint: plan.sourceFingerprint,
        p_packet: plan.packet, p_person_id: plan.employee.personId, p_draft: plan.draft, p_token_hash: plan.tokenHash,
      }).abortSignal(AbortSignal.timeout(15000));
      const result = response.data as BridgeResult;
      if (response.error || !result || result.code !== "submitted" || result.status !== "Pending"
        || !result.requestId || !uuid.test(result.requestId)) throw new Error("unavailable");
      return result;
    },
  };
}
