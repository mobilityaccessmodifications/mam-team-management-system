import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadModule, requireAction } from "./helpers/unified-role-harness.mjs";

Object.assign(process.env, {
  SUBSCRIPTION_CREDENTIAL_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
  SUBSCRIPTION_CREDENTIAL_VAULT_KEY_VERSION: "1",
  SUBSCRIPTION_CREDENTIAL_VAULT_PREVIOUS_KEY: "",
  SUBSCRIPTION_CREDENTIAL_VAULT_PREVIOUS_KEY_VERSION: "",
});
globalThis.fetch = async () => assert.fail("Permission probe regressions must remain offline");

const actorId = "97000000-0000-4000-8000-000000000001";
const deniedProbes = [
  ["literal false", { data: false, error: null }],
  ["SQLSTATE 42501", { data: null, error: { code: "42501", message: "private synthetic authorization detail" } }],
  ["SQLSTATE 42501 with true data", { data: true, error: { code: "42501", message: "private synthetic authorization detail" } }],
];
const failedProbes = [
  ["unknown error", { data: null, error: { code: "XX000", message: "private synthetic provider detail" } }],
  ["transient error", { data: null, error: { code: "57014", message: "private synthetic provider detail" } }],
  ["error with true data", { data: true, error: { message: "private synthetic provider detail" } }],
  ["error with false data", { data: false, error: { code: "XX000", message: "private synthetic provider detail" } }],
  ["permission text without SQLSTATE", { data: null, error: { message: "private synthetic permission denied detail" } }],
  ["numeric denial code", { data: null, error: { code: 42501, message: "private synthetic provider detail" } }],
  ["null", { data: null, error: null }],
  ["undefined", { data: undefined, error: null }],
  ["number", { data: 1, error: null }],
  ["string", { data: "true", error: null }],
  ["false string", { data: "false", error: null }],
  ["array", { data: [true], error: null }],
  ["false array", { data: [false], error: null }],
  ["object", { data: { allowed: true }, error: null }],
];

function fixture(permissionRpc, responses = {}) {
  const calls = [];
  const revalidations = [];
  let probe = { data: true, error: null };
  let session = { data: { user: { id: actorId } }, error: null };
  const client = {
    auth: { getUser: async () => session },
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === permissionRpc) return probe;
      assert.ok(Object.hasOwn(responses, name), `Unexpected protected RPC ${name}`);
      return { data: typeof responses[name] === "function" ? responses[name](args) : responses[name], error: null };
    },
  };
  const overrides = {
    "@/lib/supabase/server": { createClient: async () => client },
    "next/cache": { revalidatePath: (path) => revalidations.push(path) },
  };
  const cache = new Map();
  return {
    calls,
    revalidations,
    client,
    overrides,
    load: (file) => loadModule(file, overrides, cache),
    setProbe(value) { probe = value; calls.length = 0; revalidations.length = 0; },
    setSession(value) { session = value; calls.length = 0; revalidations.length = 0; },
  };
}

function entrypointTests({ file, action, permissionRpc, args = [], responses, success, protectedCalls, denial, failure, resultShaped = false, revalidated = [], fixtureFactory = fixture }) {
  const invoke = (f) => requireAction(f.load(file), action)(...args);
  async function assertFailure(f, message) {
    if (resultShaped) {
      assert.deepEqual(await invoke(f), { ok: false, message });
    } else {
      await assert.rejects(invoke(f), { message });
    }
    assert.deepEqual(f.calls, [{ name: permissionRpc, args: undefined }]);
    assert.deepEqual(f.revalidations, []);
    assert.deepEqual(f.effects ?? [], []);
  }
  test(`${action}: literal true preserves the protected success path`, async () => {
    const f = fixtureFactory(permissionRpc, responses);
    const result = await invoke(f);
    if (typeof success === "function") success(result, f);
    else assert.deepEqual(result, success);
    assert.deepEqual(f.calls[0], { name: permissionRpc, args: undefined });
    if (typeof protectedCalls === "function") protectedCalls(f.calls.slice(1), result);
    else assert.deepEqual(f.calls.slice(1), protectedCalls);
    assert.deepEqual(f.revalidations, revalidated);
  });
  test(`${action}: definite denials retain permission copy without protected dispatch`, async () => {
    const f = fixtureFactory(permissionRpc, responses);
    for (const [, probe] of deniedProbes) {
      f.setProbe(probe);
      await assertFailure(f, denial);
    }
  });
  test(`${action}: failed or malformed probes use the sanitized fallback without protected dispatch`, async () => {
    const f = fixtureFactory(permissionRpc, responses);
    for (const [name, probe] of failedProbes) {
      f.setProbe(probe);
      try {
        await assertFailure(f, failure);
      } catch (error) {
        error.message = `${name}: ${error.message}`;
        throw error;
      }
    }
  });
  test(`${action}: invalid sessions retain authentication behavior without a permission probe`, async () => {
    const f = fixtureFactory(permissionRpc, responses);
    for (const session of [
      { data: { user: null }, error: null },
      { data: { user: { id: actorId } }, error: { message: "private synthetic authentication detail" } },
    ]) {
      f.setSession(session);
      if (resultShaped) assert.deepEqual(await invoke(f), { ok: false, message: "Your session has expired. Sign in again." });
      else await assert.rejects(invoke(f), { message: "Your session has expired. Sign in again." });
      assert.deepEqual(f.calls, []);
      assert.deepEqual(f.revalidations, []);
      assert.deepEqual(f.effects ?? [], []);
    }
  });
}

entrypointTests({
  file: "src/app/subscriptions/actions.ts",
  action: "listSubscriptions",
  permissionRpc: "can_view_subscription_register",
  responses: { list_subscriptions_v2: [] },
  protectedCalls: [{ name: "list_subscriptions_v2", args: undefined }],
  success: [],
  denial: "You do not have permission to view subscriptions.",
  failure: "Subscriptions could not be loaded. Refresh and try again.",
});

const personId = "97000000-0000-4000-8000-000000000002";
const recordId = "97000000-0000-4000-8000-000000000003";
const subscriptionInput = {
  company: "mam", serviceName: "Synthetic Service", pricingModel: "free",
  responsiblePersonId: personId, memberPersonIds: [],
};
const subscriptionPayload = {
  p_service_name: "Synthetic Service", p_company_scope: "mam", p_plan_name: null,
  p_pricing_model: "free", p_billing_cycle: null, p_amount_cents: null,
  p_renewal_date: null, p_seat_count: null, p_credit_card_used: null,
  p_credit_card_holder: null, p_billing_anchor_date: null,
  p_responsible_person_id: personId, p_member_person_ids: [],
};
const subscriptionRow = {
  subscription_id: recordId, company_scope: "mam", subscription_code: "MAM-SUB-000001",
  service_name: "Synthetic Service", plan_name: null, subscription_status: "active",
  pricing_model: "free", billing_cycle: null, amount_cents: null, currency_code: "AUD",
  renewal_date: null, seat_count: null, credit_card_used: null, credit_card_holder: null,
  billing_anchor_date: null, next_billing_on: null, last_reviewed_on: null,
  next_review_on: "2027-01-15", responsible_person_id: personId,
  responsible_person_name: "Synthetic Custodian", responsible_person_title: "Tester",
  member_person_ids: [], member_names: [], created_at: "2026-10-15T00:00:00Z", version: 2,
};
const subscription = {
  id: recordId, company: "mam", subscriptionCode: "MAM-SUB-000001",
  serviceName: "Synthetic Service", planName: "", status: "active", pricingModel: "free",
  startDate: null,
  billingCycle: null, amountCents: null, currency: "AUD", renewalDate: null, seatCount: null,
  creditCardUsed: null, creditCardHolder: null, billingDate: null, nextBillingOn: null,
  lastReviewedOn: null, nextReviewOn: "2027-01-15",
  responsible: { personId, fullName: "Synthetic Custodian", positionTitle: "Tester" },
  memberPersonIds: [], memberNames: [], createdAt: "2026-10-15T00:00:00Z", version: 2,
};
const subscriptionAdmin = {
  file: "src/app/subscriptions/actions.ts", permissionRpc: "can_manage_subscriptions",
  denial: "You do not have permission to manage subscriptions.",
};
entrypointTests({
  ...subscriptionAdmin, action: "listSubscriptionPeople",
  responses: { list_subscription_people: [] }, success: [],
  protectedCalls: [{ name: "list_subscription_people", args: undefined }],
  failure: "Subscriptions could not be loaded. Refresh and try again.",
});
for (const [action, rpc, input, payload] of [
  ["createSubscription", "create_subscription_v4", subscriptionInput, subscriptionPayload],
  ["updateSubscription", "update_subscription_v4", { ...subscriptionInput, subscriptionId: recordId, version: 1, status: "active" }, { ...subscriptionPayload, p_subscription_id: recordId, p_expected_version: 1, p_subscription_status: "active" }],
  ["markSubscriptionReviewed", "mark_subscription_reviewed_v2", { subscriptionId: recordId, version: 1 }, { p_subscription_id: recordId, p_expected_version: 1 }],
]) {
  entrypointTests({
    ...subscriptionAdmin, action, args: [input], responses: { [rpc]: subscriptionRow }, success: subscription,
    protectedCalls: [{ name: rpc, args: payload }], revalidated: ["/"],
    failure: "The subscription could not be saved. Refresh and try again.",
  });
}

const vault = {
  file: "src/app/subscription-credentials/actions.ts",
  permissionRpc: "can_manage_subscription_credentials",
  denial: "You do not have permission to manage subscription credentials.",
};
entrypointTests({
  ...vault, action: "listSubscriptionCredentialCatalogue",
  responses: { list_subscription_credential_catalogue: [] }, success: [],
  protectedCalls: [{ name: "list_subscription_credential_catalogue", args: undefined }],
  failure: "Credentials could not be loaded. Refresh and try again.",
});
entrypointTests({
  ...vault, action: "readSubscriptionCredential", args: [recordId],
  responses: { get_subscription_credential: [] }, success: null,
  protectedCalls: [{ name: "get_subscription_credential", args: { p_subscription_id: recordId } }],
  failure: "The credential could not be opened. Refresh and try again.",
});
entrypointTests({
  ...vault, action: "saveSubscriptionCredential",
  args: [{ subscriptionId: recordId, credentialVersion: 1, credential: {
    loginUrl: "", accountEmail: "", username: "Synthetic Vault User", password: "",
    mfaDetails: "", recoveryCodes: "", licenceKey: "", notes: "",
  } }],
  responses: { save_subscription_credential: [{ credential_version: 2 }] },
  success: { credentialVersion: 2 }, revalidated: ["/"],
  protectedCalls: (calls) => {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "save_subscription_credential");
    const payload = calls[0].args;
    assert.deepEqual(Object.keys(payload).sort(), [
      "p_subscription_id", "p_expected_credential_version", "p_credential_ciphertext",
      "p_credential_iv", "p_credential_auth_tag", "p_credential_key_version",
    ].sort());
    assert.equal(payload.p_subscription_id, recordId);
    assert.equal(payload.p_expected_credential_version, 1);
    assert.equal(payload.p_credential_key_version, 1);
    for (const field of ["p_credential_ciphertext", "p_credential_iv", "p_credential_auth_tag"]) {
      assert.match(payload[field], /^[A-Za-z0-9_-]+$/);
      assert.doesNotMatch(payload[field], /Synthetic Vault User/);
    }
  },
  failure: "The credential could not be saved. Refresh and try again.",
});
entrypointTests({
  ...vault, action: "removeSubscriptionCredential", args: [{ subscriptionId: recordId, credentialVersion: 1 }],
  responses: { remove_subscription_credential: null }, success: undefined, revalidated: ["/"],
  protectedCalls: [{ name: "remove_subscription_credential", args: { p_subscription_id: recordId, p_expected_credential_version: 1 } }],
  failure: "The credential could not be removed. Refresh and try again.",
});
const vaultGrants = {
  file: "src/app/subscription-credentials/actions.ts",
  permissionRpc: "can_manage_subscription_credential_grants",
  denial: "You do not have permission to manage credential access.",
};
for (const [action, rpc] of [
  ["listSubscriptionCredentialAccessGrants", "list_subscription_credential_access_grants"],
  ["listSubscriptionCredentialGrantCandidates", "list_subscription_credential_grant_candidates"],
]) {
  entrypointTests({
    ...vaultGrants, action, responses: { [rpc]: [] }, success: [],
    protectedCalls: [{ name: rpc, args: undefined }],
    failure: "Credential access could not be loaded. Refresh and try again.",
  });
}
entrypointTests({
  ...vaultGrants, action: "replaceSubscriptionCredentialAccessGrants", args: [[personId]],
  responses: { replace_subscription_credential_access_grants: null }, success: { ok: true },
  protectedCalls: [{ name: "replace_subscription_credential_access_grants", args: { p_person_ids: [personId] } }],
  resultShaped: true, revalidated: ["/"],
  failure: "Credential access could not be saved. Refresh and try again.",
});

const assets = {
  file: "src/app/assets/actions.ts", permissionRpc: "can_manage_it_assets",
  denial: "You do not have permission to manage IT assets.",
};
for (const [action, rpc, args, payload] of [
  ["listItAssets", "list_it_assets_with_custody", [], undefined],
  ["listItAssetAssignees", "list_it_asset_assignees", [], undefined],
  ["listItAssetsForEmployee", "list_it_assets_for_employee_with_custody", [personId], { p_person_id: personId }],
  ["listItAssetCustodyHistory", "list_it_asset_custody_history", [recordId], { p_asset_id: recordId }],
]) {
  entrypointTests({
    ...assets, action, args, responses: { [rpc]: [] }, success: [],
    protectedCalls: [{ name: rpc, args: payload }],
    failure: "IT assets could not be loaded. Refresh and try again.",
  });
}
const assetRow = {
  asset_id: recordId, asset_code: "MAM-IT-000001", barcode_value: "MAM-IT-000001",
  asset_type: "laptop", manufacturer: null, model: null, serial_number: null,
  asset_status: "assigned", assigned_person_id: personId, assigned_person_name: "Synthetic Custodian",
  assigned_person_title: "Tester", assigned_person_team: null, assigned_on: "2026-10-15",
  last_returned_on: null, created_at: "2026-10-15T00:00:00Z", version: 2,
};
const asset = {
  id: recordId, assetCode: "MAM-IT-000001", barcodeValue: "MAM-IT-000001", assetType: "laptop",
  manufacturer: "", model: "", serialNumber: "", status: "assigned",
  assignedTo: { personId, fullName: "Synthetic Custodian", positionTitle: "Tester", teamName: "" },
  assignedOn: "2026-10-15", lastReturnedOn: null, createdAt: "2026-10-15T00:00:00Z", version: 2,
};
for (const [action, rpc, input, payload] of [
  ["createItAsset", "create_it_asset", { assetType: "laptop", assignedPersonId: personId }, { p_asset_type: "laptop", p_assigned_person_id: personId, p_manufacturer: null, p_model: null, p_serial_number: null }],
  ["reassignItAsset", "reassign_it_asset", { assetId: recordId, assignedPersonId: personId, version: 1 }, { p_asset_id: recordId, p_assigned_person_id: personId, p_expected_version: 1 }],
]) {
  entrypointTests({
    ...assets, action, args: [input], responses: { [rpc]: [{ asset_id: recordId }], get_it_asset_with_custody: [assetRow] },
    success: asset, revalidated: ["/"],
    protectedCalls: [{ name: rpc, args: payload }, { name: "get_it_asset_with_custody", args: { p_asset_id: recordId } }],
    failure: "The device could not be saved. Refresh and try again.",
  });
}
for (const [action, rpc, input, payload, status, returnedOn] of [
  ["returnItAsset", "return_it_asset", { assetId: recordId, version: 1, returnedOn: "2026-10-16" }, { p_asset_id: recordId, p_expected_version: 1, p_returned_on: "2026-10-16" }, "available", "2026-10-16"],
  ["retireItAsset", "retire_it_asset", { assetId: recordId, version: 1 }, { p_asset_id: recordId, p_expected_version: 1 }, "retired", null],
]) {
  entrypointTests({
    ...assets, action, args: [input],
    responses: { [rpc]: [{ ...assetRow, asset_status: status, assigned_person_id: null, assigned_person_name: null, assigned_person_title: null, assigned_on: null, last_returned_on: returnedOn }] },
    success: { ...asset, status, assignedTo: null, assignedOn: null, lastReturnedOn: returnedOn },
    protectedCalls: [{ name: rpc, args: payload }], revalidated: ["/"],
    failure: "The device could not be saved. Refresh and try again.",
  });
}

const claimId = "97000000-0000-4000-8000-000000000004";
const accountInput = { personId, userId: recordId, accountVersion: 1 };
const password = "Synthetic-Password-123!";
const loginName = "synthetic-account@example.test";
const lastSignInAt = "2026-10-14T00:00:00Z";
const account = {
  personId, name: "Synthetic Account", position: "Tester", company: "mam", userId: recordId,
  loginName, status: "active", lastSignInAt, accountVersion: 2,
};
function accountFixture(permissionRpc, mode) {
  const state = { linked: mode !== "create", version: 1, status: "active" };
  const profile = () => ({ id: recordId, login_name: loginName, account_status: state.status, account_version: state.version });
  const person = () => ({ id: personId, node_kind: "person", company_key: "mam", full_name: "Synthetic Account", position_title: "Tester", auth_user_id: state.linked ? recordId : null, is_active: true, version: 1 });
  const accountRow = () => [{ person_id: personId, auth_user_id: recordId, login_name: loginName, account_status: state.status, account_version: state.version }];
  const commit = () => { state.version = 2; return accountRow(); };
  const f = fixture(permissionRpc, {
    list_portal_account_summaries: () => [profile()],
    create_portal_account: () => { state.linked = true; return commit(); },
    update_portal_login: commit,
    begin_portal_password_reset: () => [{ ...accountRow()[0], reset_token: claimId }],
    finalise_portal_password_reset: commit,
    begin_portal_account_status_change: [{ change_token: claimId }],
    finalise_portal_account_status_change: () => { state.status = "disabled"; return commit(); },
  });
  f.effects = [];
  const ok = (data) => ({ data, error: null });
  const admin = {
    from(table) {
      f.effects.push(`table:${table}`);
      assert.ok(["internal_org_people", "profiles"].includes(table));
      const query = {
        select() { return query; }, eq() { return query; }, order() { return query; },
        async single() { return ok(table === "profiles" ? profile() : person()); },
        async returns() { return ok([person()]); },
        then(resolve, reject) { return Promise.resolve({ data: null, error: null, count: 0 }).then(resolve, reject); },
      };
      return query;
    },
    async rpc(name) {
      f.effects.push(`admin-rpc:${name}`);
      assert.ok(["claim_portal_account_status_execution", "record_portal_account_status_execution"].includes(name));
      return ok(name === "claim_portal_account_status_execution" ? "execute" : true);
    },
    auth: { admin: {
      async listUsers() { f.effects.push("auth:listUsers"); return ok({ users: [{ id: recordId, last_sign_in_at: lastSignInAt }] }); },
      async getUserById(id) { f.effects.push("auth:getUserById"); assert.equal(id, recordId); return ok({ user: { id, last_sign_in_at: lastSignInAt } }); },
      async createUser(input) { f.effects.push("auth:createUser"); assert.equal(input.password, password); assert.equal(input.email_confirm, true); return ok({ user: { id: recordId } }); },
      async updateUserById(id, input) { f.effects.push("auth:updateUserById"); assert.equal(id, recordId); assert.deepEqual(input, mode === "reset" ? { password } : { ban_duration: "876000h" }); return ok({ user: { id } }); },
    } },
  };
  f.overrides["@/lib/supabase/admin"] = { createAdminClient: () => { f.effects.push("admin-client"); return admin; } };
  return f;
}
const accounts = {
  file: "src/app/accounts/actions.ts", permissionRpc: "can_manage_portal_accounts",
  denial: "You do not have permission to manage accounts.",
};
entrypointTests({
  ...accounts, action: "listPortalAccounts", fixtureFactory: (rpc) => accountFixture(rpc, "list"),
  success: [{ ...account, accountVersion: 1 }],
  protectedCalls: [{ name: "list_portal_account_summaries", args: undefined }],
  failure: "Accounts could not be loaded.",
});
for (const [action, mode, input, calls, oneTimePassword] of [
  ["createPortalAccount", "create", { personId, accountVersion: 1, loginName, newPassword: password }, [{ name: "create_portal_account", args: { p_person_id: personId, p_auth_user_id: recordId, p_login_name: loginName, p_app_role: "employee", p_expected_person_version: 1 } }], password],
  ["updatePortalLogin", "update", { ...accountInput, loginName }, [{ name: "update_portal_login", args: { p_person_id: personId, p_auth_user_id: recordId, p_login_name: loginName, p_expected_account_version: 1 } }], undefined],
  ["resetPortalPassword", "reset", { ...accountInput, newPassword: password }, [{ name: "begin_portal_password_reset", args: { p_person_id: personId, p_auth_user_id: recordId, p_expected_account_version: 1 } }, { name: "finalise_portal_password_reset", args: { p_person_id: personId, p_auth_user_id: recordId, p_reset_token: claimId } }], password],
  ["togglePortalAccount", "toggle", { ...accountInput, enabled: false }, [{ name: "begin_portal_account_status_change", args: { p_person_id: personId, p_auth_user_id: recordId, p_enabled: false, p_expected_account_version: 1 } }, { name: "finalise_portal_account_status_change", args: { p_person_id: personId, p_auth_user_id: recordId, p_change_token: claimId } }], undefined],
]) {
  entrypointTests({
    ...accounts, action, args: [input], fixtureFactory: (rpc) => accountFixture(rpc, mode),
    success: { account: { ...account, status: mode === "toggle" ? "disabled" : "active" }, ...(oneTimePassword ? { oneTimePassword } : {}) },
    protectedCalls: calls, revalidated: ["/"],
    failure: "The account change could not be saved. Refresh and try again.",
  });
}

const analytics = {
  file: "src/app/analytics-api/actions.ts", permissionRpc: "can_manage_analytics_api",
  denial: "You do not have permission to manage the Analytics API.",
};
entrypointTests({
  ...analytics, action: "listAnalyticsApiKeys",
  responses: { list_analytics_api_keys: [] }, success: [],
  protectedCalls: [{ name: "list_analytics_api_keys", args: undefined }],
  failure: "Analytics API access could not be loaded. Refresh and try again.",
});
entrypointTests({
  ...analytics, action: "createAnalyticsApiKey", args: ["Synthetic Analytics"],
  responses: { create_analytics_api_key_record: null }, resultShaped: true, revalidated: ["/"],
  success: (result) => { assert.equal(result.ok, true); assert.match(result.key, /^mam_analytics_[A-Za-z0-9_-]{43}$/); },
  protectedCalls: (calls, result) => assert.deepEqual(calls, [{ name: "create_analytics_api_key_record", args: {
    p_key_hash: createHash("sha256").update(result.key, "utf8").digest("hex"),
    p_key_prefix: result.key.slice(0, "mam_analytics_".length + 12), p_label: "Synthetic Analytics",
  } }]),
  failure: "Analytics API access could not be saved. Refresh and try again.",
});
entrypointTests({
  ...analytics, action: "revokeAnalyticsApiKey", args: [recordId],
  responses: { revoke_analytics_api_key: true }, success: { ok: true }, resultShaped: true, revalidated: ["/"],
  protectedCalls: [{ name: "revoke_analytics_api_key", args: { p_key_id: recordId } }],
  failure: "Analytics API access could not be revoked. Refresh and try again.",
});

entrypointTests({
  file: "src/app/subscriptions/bulk-actions.ts", action: "patchSubscription",
  permissionRpc: "can_manage_subscriptions",
  args: [{ id: recordId, version: 1, patch: { status: "paused" } }],
  responses: { patch_subscription_v1: null }, success: undefined, revalidated: ["/"],
  protectedCalls: [{ name: "patch_subscription_v1", args: { p_subscription_id: recordId, p_expected_version: 1, p_patch: { subscription_status: "paused" } } }],
  denial: "You do not have permission to manage subscriptions.",
  failure: "This subscription could not be updated. Refresh and try again.",
});

const directory = {
  file: "src/lib/employee-directory.ts", permissionRpc: "can_manage_employee_directory",
  denial: "You do not have permission to manage employee records.",
  failure: "Employee records could not be loaded. Refresh and try again.",
};
entrypointTests({
  ...directory, action: "requireEmployeeDirectoryManager", responses: {}, protectedCalls: [],
  success: (result, f) => assert.deepEqual(result, { supabase: f.client, actorUserId: actorId }),
});
entrypointTests({
  ...directory, action: "listEmployeeDirectoryRecordsForManager",
  responses: { list_employee_directory_records_with_work_schedule_times: [], list_employee_check_in_contract_classifications: [] },
  protectedCalls: [
    { name: "list_employee_directory_records_with_work_schedule_times", args: { p_include_archived: true } },
    { name: "list_employee_check_in_contract_classifications", args: undefined },
  ],
  success: [],
});
