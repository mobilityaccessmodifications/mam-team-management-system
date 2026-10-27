import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/unified-role-harness.mjs";

const id = "33000000-0000-4000-8000-000000000001";
const person = "11000000-0000-4000-8000-00000000000a";
const row = {
  subscription_id: id, subscription_code: "MAM-SUB-000001", service_name: "Synthetic legacy",
  plan_name: null, company_scope: "equipsy", subscription_status: "active", pricing_model: "paid",
  billing_cycle: "monthly", amount_cents: 1200, currency_code: "AUD", renewal_date: null,
  seat_count: null, credit_card_used: null, credit_card_holder: null, billing_anchor_date: null,
  next_billing_on: null, last_reviewed_on: null, next_review_on: "2027-01-01",
  responsible_person_id: person, responsible_person_name: "Synthetic Owner", responsible_person_title: "Coordinator",
  member_person_ids: [person], member_names: ["Synthetic Member"], created_at: "2026-10-01T00:00:00Z", version: 2,
};
const input = { subscriptionId: id, version: 1, memberPersonIds: [person] };

function harness({ signedIn = true, allowed = true, permissionError = null, error = null, data = row, throws = false, authThrows = false, permissionThrows = false, revalidateThrows = false } = {}) {
  const calls = [];
  let revalidations = 0;
  const actions = loadModule("src/app/subscriptions/actions.ts", {
    "next/cache": { revalidatePath() { revalidations++; if (revalidateThrows) throw new Error("PRIVATE cache failure"); } },
    "@/lib/supabase/server": { createClient: async () => ({
      auth: { getUser: async () => { if (authThrows) throw new Error("PRIVATE auth transport"); return { data: { user: signedIn ? { id: person } : null }, error: null }; } },
      rpc: async (name, args) => {
        calls.push({ name, args });
        if (name === "can_manage_subscriptions") {
          if (permissionThrows) throw new Error("PRIVATE permission transport");
          return { data: allowed, error: permissionError };
        }
        if (throws) throw new Error("PRIVATE network failure");
        return { data, error };
      },
    }) },
  });
  return { action: actions.updateSubscriptionTeamAccess, calls, revalidations: () => revalidations };
}

test("team access saves only exact membership IDs without requiring legacy billing fields", async () => {
  const h = harness();
  const result = await h.action({ ...input, memberPersonIds: [person, person.toUpperCase()] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.subscription.memberPersonIds, [person]);
  assert.equal(result.subscription.seatCount, null);
  assert.deepEqual(h.calls, [
    { name: "can_manage_subscriptions", args: undefined },
    { name: "update_subscription_members_v1", args: { p_subscription_id: id, p_expected_version: 1, p_member_person_ids: [person] } },
  ]);
  assert.equal(h.revalidations(), 1);
});

test("team access denies missing sessions, missing grants and permission lookup failures before mutation", async () => {
  for (const options of [{ signedIn: false }, { allowed: false }, { permissionError: { code: "XX000", message: "PRIVATE" } }, { authThrows: true }, { permissionThrows: true }]) {
    const h = harness(options);
    const result = await h.action(input);
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.message, /PRIVATE/);
    assert.equal(h.calls.some(call => call.name === "update_subscription_members_v1"), false);
  }
});

test("team access rejects invalid identity, versions, member lists and null members", async () => {
  for (const invalid of [null, {}, { ...input, subscriptionId: "wrong" }, { ...input, version: "1" },
    { ...input, version: true }, { ...input, version: 0 }, { ...input, memberPersonIds: null },
    { ...input, memberPersonIds: [null] }, { ...input, memberPersonIds: ["wrong"] },
    { ...input, memberPersonIds: Array(251).fill(person) }]) {
    const h = harness();
    assert.equal((await h.action(invalid)).ok, false);
    assert.equal(h.calls.some(call => call.name === "update_subscription_members_v1"), false);
  }
});

test("team access requires explicit reconciliation after stale, revoked or uncertain saves", async () => {
  for (const options of [{ error: { code: "40001", message: "PRIVATE" } }, { error: { code: "42501", message: "PRIVATE" } },
    { error: { code: "P0002" } }, { error: { code: "XX000", message: "PRIVATE" } }, { throws: true },
    { data: { ...row, subscription_id: person } }, { data: { ...row, member_person_ids: [], member_names: [] } }, { data: null }]) {
    const h = harness(options);
    const result = await h.action(input);
    assert.equal(result.ok, false);
    assert.equal(result.refreshRequired, true);
    assert.doesNotMatch(result.message, /PRIVATE/);
    assert.equal(h.calls.filter(call => call.name === "update_subscription_members_v1").length, 1);
    assert.equal(h.revalidations(), 0);
  }
});

test("team access does not confirm duplicate returned identities in place of a requested person", async () => {
  const other = "11000000-0000-4000-8000-00000000000b";
  const h = harness({ data: { ...row, member_person_ids: [person, person], member_names: ["Same", "Same"] } });
  const result = await h.action({ ...input, memberPersonIds: [person, other] });
  assert.equal(result.ok, false);
  assert.equal(result.refreshRequired, true);
});

test("team access keeps a confirmed save successful if page revalidation fails", async () => {
  const h = harness({ revalidateThrows: true });
  const result = await h.action(input);
  assert.equal(result.ok, true);
  assert.match(result.warning, /saved/);
  assert.doesNotMatch(result.warning, /PRIVATE/);
});

test("team access can clear every assignment and maps validation failures safely", async () => {
  const h = harness({ data: { ...row, member_person_ids: [], member_names: [] } });
  assert.equal((await h.action({ ...input, memberPersonIds: [] })).ok, true);
  assert.deepEqual(h.calls[1].args.p_member_person_ids, []);
  for (const code of ["23503", "22023"]) {
    const invalid = harness({ error: { code, message: "PRIVATE" } });
    const result = await invalid.action(input);
    assert.equal(result.ok, false);
    assert.match(result.message, /active team members/);
    assert.equal(result.refreshRequired, undefined);
  }
});
