import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const personId = "10000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000002";
const actorId = "10000000-0000-4000-8000-000000000003";
const changeToken = "10000000-0000-4000-8000-000000000004";

function loadActions({
  failUnban = false,
  throwUnban = false,
  failDatabaseChange = false,
  throwFinalise = false,
  beforeProviderUpdate,
} = {}) {
  const state = {
    accountStatus: "disabled",
    accountVersion: 1,
    banned: true,
    claim: null,
    providerUpdates: 0,
  };
  const account = () => ({
    id: userId,
    login_name: "sample.user",
    account_status: state.accountStatus,
    account_version: state.accountVersion,
  });
  const accountRow = () => ({
    person_id: personId,
    auth_user_id: userId,
    login_name: "sample.user",
    account_status: state.accountStatus,
    account_version: state.accountVersion,
  });
  const rpc = async (name, args) => {
    if (name === "can_manage_portal_accounts") return { data: true, error: null };
    if (name === "begin_portal_account_status_change") {
      if (state.claim?.status === "pending") {
        if (state.claim.enabled === args.p_enabled && state.claim.version === args.p_expected_account_version) {
          return { data: [{ ...accountRow(), change_token: changeToken }], error: null };
        }
        return { data: null, error: { message: "status change in progress" } };
      }
      if (args.p_expected_account_version !== state.accountVersion) {
        return { data: null, error: { message: "version conflict" } };
      }
      state.claim = {
        status: "pending",
        enabled: args.p_enabled,
        priorStatus: state.accountStatus,
        version: state.accountVersion,
      };
      return { data: [{ ...accountRow(), change_token: changeToken }], error: null };
    }
    if (name === "finalise_portal_account_status_change") {
      if (throwFinalise) throw new Error("transport failure");
      if (!state.claim || args.p_change_token !== changeToken) {
        return { data: null, error: { message: "invalid claim" } };
      }
      if (state.claim.status === "finalised") return { data: [accountRow()], error: null };
      if (failDatabaseChange) return { data: null, error: { message: "database failure" } };
      state.accountStatus = state.claim.enabled ? "active" : "disabled";
      if (state.accountStatus !== state.claim.priorStatus) state.accountVersion += 1;
      state.claim.status = "finalised";
      return { data: [accountRow()], error: null };
    }
    if (name === "inspect_portal_account_status_change") {
      if (!state.claim || args.p_change_token !== changeToken) {
        return { data: null, error: { message: "invalid claim" } };
      }
      return {
        data: [{ ...accountRow(), claim_status: state.claim.status }],
        error: null,
      };
    }
    if (name === "cancel_portal_account_status_change") {
      if (!state.claim || state.claim.status !== "pending" || args.p_change_token !== changeToken) {
        return { data: false, error: null };
      }
      state.claim.status = "cancelled";
      return { data: true, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  };
  const admin = {
    from(table) {
      const query = {
        select() { return query; },
        eq() { return query; },
        async single() {
          return table === "profiles"
            ? { data: account(), error: null }
            : { data: { id: personId, node_kind: "person", company_key: "mam", full_name: "Sample User", position_title: "Tester", auth_user_id: userId, is_active: true, version: 1 }, error: null };
        },
      };
      return query;
    },
    auth: { admin: {
      async getUserById() { return { data: { user: { last_sign_in_at: null } }, error: null }; },
      async updateUserById(_id, input) {
        state.providerUpdates += 1;
        if (beforeProviderUpdate) await beforeProviderUpdate(state.providerUpdates);
        if (input.ban_duration === "none" && throwUnban) throw new Error("provider transport failure");
        if (input.ban_duration === "none" && failUnban) return { data: null, error: { message: "provider failure" } };
        state.banned = input.ban_duration !== "none";
        return { data: { user: { id: userId } }, error: null };
      },
    } },
  };
  const client = {
    auth: { async getUser() { return { data: { user: { id: actorId } }, error: null }; } },
    rpc,
  };
  const source = ts.transpileModule(
    readFileSync("src/app/accounts/actions.ts", "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const moduleUnderTest = { exports: {} };
  new Function("require", "module", "exports", source)(
    (id) => {
      if (id === "next/cache") return { revalidatePath() {} };
      if (id === "@/lib/supabase/admin") return { createAdminClient: () => admin };
      if (id === "@/lib/supabase/server") return { createClient: async () => client };
      return require(id);
    },
    moduleUnderTest,
    moduleUnderTest.exports,
  );
  return { togglePortalAccount: moduleUnderTest.exports.togglePortalAccount, state };
}

const enableInput = { personId, userId, accountVersion: 1, enabled: true };

test("concurrent same-direction account enables share an idempotent claim", async () => {
  const { togglePortalAccount, state } = loadActions();
  const outcomes = await Promise.allSettled([
    togglePortalAccount(enableInput),
    togglePortalAccount(enableInput),
  ]);

  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["fulfilled", "fulfilled"]);
  assert.equal(state.accountStatus, "active");
  assert.equal(state.banned, false);
});

test("a pending enable claim prevents an older opposite request from changing Auth", async () => {
  let releaseProvider;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  const { togglePortalAccount, state } = loadActions({
    beforeProviderUpdate: async (attempt) => {
      if (attempt === 1) await providerGate;
    },
  });

  const enable = togglePortalAccount(enableInput);
  await new Promise((resolve) => setImmediate(resolve));
  const staleDisable = togglePortalAccount({ ...enableInput, enabled: false });
  await assert.rejects(staleDisable, /could not be saved/i);
  releaseProvider();
  await enable;

  assert.equal(state.accountStatus, "active");
  assert.equal(state.banned, false);
  assert.equal(state.providerUpdates, 1);
});

test("failed Auth enable restores Auth and cancels the database claim", async () => {
  const { togglePortalAccount, state } = loadActions({ failUnban: true });
  await assert.rejects(togglePortalAccount(enableInput), /could not be enabled/i);
  assert.equal(state.accountStatus, "disabled");
  assert.equal(state.banned, true);
  assert.equal(state.claim.status, "cancelled");
});

test("thrown Auth transport failures restore Auth and cancel the database claim", async () => {
  const { togglePortalAccount, state } = loadActions({ throwUnban: true });
  await assert.rejects(togglePortalAccount(enableInput), /could not be enabled/i);
  assert.equal(state.accountStatus, "disabled");
  assert.equal(state.banned, true);
  assert.equal(state.claim.status, "cancelled");
});

test("database failure is inspected before Auth is restored", async () => {
  const { togglePortalAccount, state } = loadActions({ failDatabaseChange: true });
  await assert.rejects(togglePortalAccount(enableInput), /could not be saved/i);
  assert.equal(state.accountStatus, "disabled");
  assert.equal(state.accountVersion, 1);
  assert.equal(state.banned, true);
  assert.equal(state.claim.status, "cancelled");
});

test("thrown finalisation failures are inspected before Auth is restored", async () => {
  const { togglePortalAccount, state } = loadActions({ throwFinalise: true });
  await assert.rejects(togglePortalAccount(enableInput), /could not be saved/i);
  assert.equal(state.accountStatus, "disabled");
  assert.equal(state.banned, true);
  assert.equal(state.claim.status, "cancelled");
});

test("same-state request repairs Auth while holding a claim without changing the version", async () => {
  const { togglePortalAccount, state } = loadActions();
  state.accountStatus = "active";
  state.accountVersion = 2;
  state.banned = true;

  await togglePortalAccount({ ...enableInput, accountVersion: 2 });
  assert.equal(state.accountStatus, "active");
  assert.equal(state.accountVersion, 2);
  assert.equal(state.banned, false);
  assert.equal(state.claim.status, "finalised");
});

test("stale requests fail before touching the login provider", async () => {
  const { togglePortalAccount, state } = loadActions();
  state.accountStatus = "active";
  state.accountVersion = 2;
  state.banned = false;

  await assert.rejects(togglePortalAccount(enableInput), /could not be saved/i);
  assert.equal(state.providerUpdates, 0);
  assert.equal(state.accountStatus, "active");
  assert.equal(state.banned, false);
});
