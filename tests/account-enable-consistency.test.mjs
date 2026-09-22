import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { loadAccountActions } from "./account-actions-test-loader.mjs";

const personId = "10000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000002";
const actorId = "10000000-0000-4000-8000-000000000003";
const enableInput = { personId, userId, accountVersion: 1, enabled: true };
const pendingError = /pending|reconciliation/i;
const turn = () => new Promise((resolve) => setImmediate(resolve));
function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

function loadActions(hooks = {}) {
  const state = { accountStatus: "disabled", accountVersion: 1, personActive: true, banned: true, claim: null, providerUpdates: 0, finaliseCalls: 0, receiptCalls: 0 };
  const row = () => ({ person_id: personId, auth_user_id: userId, login_name: "sample@example.test", account_status: state.accountStatus, account_version: state.accountVersion });
  const ok = (data) => ({ data, error: null });
  const fail = () => ({ data: null, error: { message: "status/version conflict" } });
  const client = {
    auth: { async getUser() { return ok({ user: { id: actorId } }); } },
    async rpc(name, args) {
      if (name === "can_manage_portal_accounts") return ok(true);
      if (name === "begin_portal_account_status_change") {
        if (state.claim?.status === "pending") {
          if (state.claim.enabled !== args.p_enabled || state.claim.version !== args.p_expected_account_version) return fail();
        } else {
          if (args.p_expected_account_version !== state.accountVersion) return fail();
          state.claim = { token: randomUUID(), enabled: args.p_enabled, version: state.accountVersion, priorStatus: state.accountStatus, status: "pending", providerStatus: "not_started" };
        }
        await hooks.afterBegin?.(state);
        return ok([{ ...row(), change_token: state.claim.token }]);
      }
      if (name === "inspect_portal_account_status_request") {
        const claim = state.claim;
        const archivedRecovery = claim?.providerStatus === "succeeded" && !claim.enabled && !state.personActive
          && state.accountStatus === "disabled" && state.accountVersion === claim.version + 1
          && args.p_expected_account_version === state.accountVersion;
        return ok(claim?.enabled === args.p_enabled && (claim.version === args.p_expected_account_version || archivedRecovery)
          ? [{ change_token: claim.token, claim_status: claim.status, provider_status: claim.providerStatus }] : []);
      }
      if (name === "finalise_portal_account_status_change") {
        state.finaliseCalls += 1;
        await hooks.beforeFinalise?.(state);
        const claim = state.claim;
        if (!claim || claim.token !== args.p_change_token || claim.providerStatus !== "succeeded") return fail();
        if (claim.status !== "finalised") {
          const targetStatus = claim.enabled ? "active" : "disabled";
          if (state.accountStatus !== targetStatus) state.accountVersion += 1;
          state.accountStatus = targetStatus;
          claim.status = "finalised";
        }
        await hooks.afterFinalise?.(state);
        return ok([row()]);
      }
      if (name === "inspect_portal_account_status_change") {
        return state.claim?.token === args.p_change_token ? ok([{ ...row(), claim_status: state.claim.status }]) : fail();
      }
      // Any attempt to cancel/compensate fails these tests immediately.
      throw new Error("Unexpected RPC " + name);
    },
  };
  const admin = {
    async rpc(name, args) {
      const claim = state.claim;
      if (!claim || claim.token !== args.p_change_token) return fail();
      if (name === "claim_portal_account_status_execution") {
        if (args.p_actor_user_id !== actorId) return fail();
        if (claim.status === "finalised") return ok("finalised");
        if (claim.providerStatus !== "not_started") return ok(claim.providerStatus);
        claim.providerStatus = "executing";
        claim.executorToken = args.p_executor_token;
        await hooks.afterExecutorClaim?.(state);
        return ok("execute");
      }
      if (name === "record_portal_account_status_execution") {
        state.receiptCalls += 1;
        if (claim.executorToken !== args.p_executor_token) return ok(false);
        claim.providerStatus = args.p_succeeded ? "succeeded" : "unknown";
        await hooks.afterReceipt?.(state);
        return ok(true);
      }
      throw new Error("Unexpected admin RPC " + name);
    },
    from(table) {
      const query = {
        select() { return query; }, eq() { return query; },
        async single() {
          return ok(table === "profiles" ? { id: userId, ...row() }
            : { id: personId, node_kind: "person", company_key: "mam", full_name: "Synthetic Person", position_title: "Tester", auth_user_id: userId, is_active: true, version: 1 });
        },
      };
      return query;
    },
    auth: { admin: {
      async getUserById() { return ok({ user: { id: userId, last_sign_in_at: null } }); },
      async updateUserById(id, input) {
        assert.equal(id, userId);
        state.providerUpdates += 1;
        const failure = await hooks.beforeProvider?.(state, input);
        if (failure) return failure;
        state.banned = input.ban_duration !== "none";
        return ok({ user: { id: userId } });
      },
    } },
  };
  return { ...loadAccountActions(admin, client), ...loadAccountActions(admin, client, "src/lib/portal-account-status.ts"), client, admin, state, hooks };
}

test("duplicate requests have one executor; the loser cannot write after a subsequent opposite change", async () => {
  const provider = gate();
  const { togglePortalAccount, state, hooks } = loadActions({ beforeProvider: () => provider.promise });
  const first = togglePortalAccount(enableInput);
  await turn();
  await assert.rejects(togglePortalAccount(enableInput), pendingError);
  assert.equal(state.providerUpdates, 1);
  await assert.rejects(togglePortalAccount({ ...enableInput, enabled: false }), pendingError);
  provider.release();
  await first;
  delete hooks.beforeProvider;
  await togglePortalAccount({ ...enableInput, accountVersion: 2, enabled: false });
  await assert.rejects(togglePortalAccount(enableInput), pendingError);
  assert.equal(state.providerUpdates, 2);
  assert.equal(state.accountStatus, "disabled");
  assert.equal(state.banned, true);
  assert.equal(state.claim.status, "finalised");
});

test("ambiguous Auth response retains the fence even when the original provider write arrives later", async () => {
  let completeLateWrite;
  const { togglePortalAccount, state } = loadActions({ beforeProvider: (s) => {
    completeLateWrite = () => { s.banned = false; };
    throw new Error("connection closed before response");
  } });
  await assert.rejects(togglePortalAccount(enableInput), pendingError);
  assert.equal(state.claim.providerStatus, "unknown");
  for (const enabled of [true, false]) await assert.rejects(togglePortalAccount({ ...enableInput, enabled }), pendingError);
  completeLateWrite();
  await assert.rejects(togglePortalAccount({ ...enableInput, enabled: false }), pendingError);
  assert.equal(state.providerUpdates, 1);
  assert.equal(state.accountStatus, "disabled");
  assert.equal(state.claim.status, "pending");
  assert.equal(state.banned, false); // Fenced divergence is never reported as success.
});

test("provider error results also preserve the claim without retry or compensation", async () => {
  const { togglePortalAccount, state } = loadActions({ beforeProvider: () => ({ data: { user: null }, error: { status: 503 } }) });
  await assert.rejects(togglePortalAccount(enableInput), pendingError);
  assert.equal(state.providerUpdates, 1);
  assert.equal(state.claim.status, "pending");
  assert.equal(state.claim.providerStatus, "unknown");
});

test("durable Auth success supports a later database-only finalisation retry", async () => {
  const { togglePortalAccount, state, hooks } = loadActions({ beforeFinalise: () => { throw new Error("database unavailable"); } });
  await assert.rejects(togglePortalAccount(enableInput), pendingError);
  assert.equal(state.providerUpdates, 1);
  assert.equal(state.banned, false);
  assert.equal(state.claim.providerStatus, "succeeded");
  assert.equal(state.claim.status, "pending");
  delete hooks.beforeFinalise;
  await togglePortalAccount(enableInput);
  assert.equal(state.providerUpdates, 1);
  assert.equal(state.accountStatus, "active");
  assert.equal(state.claim.status, "finalised");
});

test("finalisation commit with both responses lost is recovered without Auth compensation", async () => {
  const { togglePortalAccount, state } = loadActions({ afterFinalise: () => { throw new Error("lost response"); } });
  await togglePortalAccount(enableInput);
  assert.equal(state.finaliseCalls, 2);
  assert.equal(state.providerUpdates, 1);
  assert.equal(state.accountStatus, "active");
  await togglePortalAccount(enableInput);
  assert.equal(state.providerUpdates, 1);
});

test("a lost receipt response is retried without repeating the provider request", async () => {
  const { togglePortalAccount, state } = loadActions({ afterReceipt: (s) => {
    if (s.receiptCalls === 1) throw new Error("receipt response lost");
  } });
  await togglePortalAccount(enableInput);
  assert.equal(state.providerUpdates, 1);
  assert.equal(state.receiptCalls, 2);
});

test("persisted success with every receipt response lost can be finalised on the next request", async () => {
  const { togglePortalAccount, state } = loadActions({ afterReceipt: () => { throw new Error("lost response"); } });
  await assert.rejects(togglePortalAccount(enableInput), pendingError);
  await togglePortalAccount(enableInput);
  assert.equal(state.providerUpdates, 1);
  assert.equal(state.accountStatus, "active");
});

test("losing the exclusive grant response never authorises Auth or a takeover", async () => {
  const { togglePortalAccount, state } = loadActions({ afterExecutorClaim: () => { throw new Error("lost grant response"); } });
  await assert.rejects(togglePortalAccount(enableInput));
  await assert.rejects(togglePortalAccount(enableInput), pendingError);
  assert.equal(state.providerUpdates, 0);
  assert.equal(state.claim.providerStatus, "executing");
});

test("a lost begin response can safely acquire a not-yet-started executor", async () => {
  const { togglePortalAccount, state } = loadActions({ afterBegin: () => { throw new Error("lost begin response"); } });
  await togglePortalAccount(enableInput);
  assert.equal(state.providerUpdates, 1);
  assert.equal(state.accountStatus, "active");
});

test("same-state request repairs Auth while holding a claim without changing the account version", async () => {
  const { togglePortalAccount, state } = loadActions();
  state.accountStatus = "active";
  await togglePortalAccount(enableInput);
  assert.equal(state.accountVersion, 1);
  assert.equal(state.banned, false);
  assert.equal(state.providerUpdates, 1);
});

test("stale account versions never reach Auth", async () => {
  const { togglePortalAccount, state } = loadActions();
  state.accountVersion = 2;
  await assert.rejects(togglePortalAccount(enableInput), pendingError);
  assert.equal(state.providerUpdates, 0);
});

test("archived disabled version+1 is recovered from the durable success receipt without another Auth write", async () => {
  const { preparePortalAccountStatusChange, recoverPortalAccountStatusChange, client, admin, state } = loadActions();
  state.accountStatus = "active";
  state.banned = false;
  await preparePortalAccountStatusChange(client, admin, { ...enableInput, enabled: false });
  // The archive transaction committed, but the application lost its response
  // before it could finalise the status claim.
  state.personActive = false;
  state.accountStatus = "disabled";
  state.accountVersion = 2;
  assert.equal(await recoverPortalAccountStatusChange(client, { ...enableInput, enabled: false, accountVersion: 2 }), true);
  assert.equal(state.claim.status, "finalised");
  assert.equal(state.providerUpdates, 1);
  assert.equal(state.accountVersion, 2);
  assert.equal(state.banned, true);
});

test("archive recovery cannot borrow an unconfirmed execution or an unrelated current version", async () => {
  const { preparePortalAccountStatusChange, recoverPortalAccountStatusChange, client, admin, state, hooks } = loadActions();
  state.accountStatus = "active";
  hooks.beforeProvider = () => { throw new Error("unknown provider outcome"); };
  await assert.rejects(preparePortalAccountStatusChange(client, admin, { ...enableInput, enabled: false }), pendingError);
  state.personActive = false;
  state.accountStatus = "disabled";
  state.accountVersion = 2;
  assert.equal(await recoverPortalAccountStatusChange(client, { ...enableInput, enabled: false, accountVersion: 2 }), false);
  assert.equal(await recoverPortalAccountStatusChange(client, { ...enableInput, enabled: false, accountVersion: 1 }), false);
  assert.equal(state.claim.status, "pending");
  assert.equal(state.providerUpdates, 1);
});
