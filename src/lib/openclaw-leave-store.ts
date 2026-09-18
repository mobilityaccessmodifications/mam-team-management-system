import "server-only";
import { createAdminClient } from "./supabase/admin";
import type { BridgeResult, Employee, LeaveDraft, LeaveStore, SelfProfileEmployee } from "./openclaw-leave-contract";

type Snapshot = {
  complete: true; rows: Employee[]; fingerprint: string;
  receipt: { fingerprint: string; personId: string; userId: string; result: BridgeResult } | null;
  draft: LeaveDraft | null; draftFingerprint: string;
};
type SelfProfileSnapshot = { complete: true; rows: SelfProfileEmployee[] };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Optimistic transaction: reads once, computes a plan without side effects,
 * then commits everything in ONE RPC with source/draft CAS under database locks.
 * This is not a sequence of independent writes masquerading as a transaction. */
export function createLeaveBridgeStore(): LeaveStore {
  return {
    async selfProfileEmployees() {
      const client = createAdminClient();
      const response = await client.rpc("openclaw_self_profile_snapshot").abortSignal(AbortSignal.timeout(8000));
      if (response.error) throw new Error("unavailable");
      const snapshot = response.data as SelfProfileSnapshot;
      if (!snapshot || snapshot.complete !== true || !Array.isArray(snapshot.rows) || snapshot.rows.length > 10000) throw new Error("unavailable");
      return { complete: true, rows: snapshot.rows };
    },
    async transaction(work, context) {
      const client = createAdminClient();
      const payload = context.packet.payload as Record<string, unknown>;
      const draftId = typeof payload.draftId === "string" && uuid.test(payload.draftId) ? payload.draftId : null;
      const before = await client.rpc("openclaw_leave_snapshot", { p_key: context.key, p_draft_id: draftId }).abortSignal(AbortSignal.timeout(8000));
      if (before.error) throw new Error("unavailable");
      const snapshot = before.data as Snapshot;
      if (!snapshot || snapshot.complete !== true || !Array.isArray(snapshot.rows) || snapshot.rows.length > 10000 || !/^[a-f0-9]{64}$/.test(snapshot.fingerprint) || !/^[a-f0-9]{64}$/.test(snapshot.draftFingerprint)) throw new Error("unavailable");
      let draft: LeaveDraft | null = null;
      let actor: Employee | null = null;
      let receipt: BridgeResult | null = null;
      let submission = false;
      const computed = await work({
        employees: async () => ({ complete: true, rows: snapshot.rows }),
        receipt: async key => {
          if (key !== context.key) throw new Error("invalid transaction");
          return snapshot.receipt;
        },
        draft: async id => snapshot.draft?.id === id ? structuredClone(snapshot.draft) : null,
        saveDraft: async value => { draft = value; },
        saveReceipt: async (key, fingerprint, employee, result) => {
          if (key !== context.key || fingerprint !== context.fingerprint) throw new Error("invalid transaction");
          // All outcomes, including needs_input without a draft, carry the
          // server-resolved actor through this common receipt path.
          actor = employee; receipt = result;
        },
        submitSelf: async (employee, _fields, id) => {
          if (id !== draftId || submission) throw new Error("invalid transaction");
          actor = employee; submission = true;
          // Placeholder never leaves this process: commit RPC creates/returns the
          // real request ID in the same transaction as the persisted receipt.
          return { requestId: "00000000-0000-4000-8000-000000000000", status: "Pending" };
        },
      });
      const after = await client.rpc("openclaw_leave_commit", {
        p_key: context.key, p_body_fingerprint: context.fingerprint,
        p_source_fingerprint: snapshot.fingerprint, p_draft_fingerprint: snapshot.draftFingerprint,
        p_packet: context.packet, p_person_id: actor ? (actor as Employee).personId : snapshot.receipt?.personId,
        p_draft: draft, p_result: receipt ?? computed, p_submit: submission,
      }).abortSignal(AbortSignal.timeout(15000));
      if (after.error || !after.data || typeof after.data !== "object") throw new Error("unavailable");
      const result = after.data as BridgeResult;
      if (!["prepared", "needs_input", "shown", "submitted"].includes(result.code)) throw new Error("unavailable");
      if (result.code === "submitted" && (!result.requestId || !uuid.test(result.requestId) || result.status !== "Pending")) throw new Error("unavailable");
      return result as typeof computed;
    },
  };
}
