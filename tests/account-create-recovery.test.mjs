import assert from "node:assert/strict";
import test from "node:test";
import { loadAccountActions } from "./account-actions-test-loader.mjs";

const personId = "20000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000002";
const otherPersonId = "20000000-0000-4000-8000-000000000003";
const input = { personId, accountVersion: 1, loginName: "synthetic@example.test", newPassword: "Synthetic-Password-123!" };
const ok = (data) => ({ data, error: null });

function fixture(options = {}) {
  const state = { user: null, personLink: null, ownerId: null, loginName: null, rpcCalled: false, deletions: [], reservations: 0, reserved: false };
  const row = () => ({ person_id: personId, auth_user_id: userId, login_name: input.loginName, account_status: "active", account_version: 1 });
  function commit() { state.personLink = userId; state.ownerId = personId; state.loginName = input.loginName; }
  const client = {
    auth: { async getUser() { return ok({ user: { id: otherPersonId } }); } },
    async rpc(name, args) {
      if (name === "can_manage_portal_accounts") return ok(true);
      assert.equal(name, "create_portal_account");
      assert.equal(args.p_auth_user_id, userId);
      state.rpcCalled = true;
      if (options.commit !== false) commit();
      if (options.otherOwner) { state.personLink = null; state.ownerId = otherPersonId; }
      if (options.wrongLogin) state.loginName = "different@example.test";
      if (options.throwSave) throw new Error("response lost");
      if (options.error) return { data: null, error: options.error };
      if (options.malformed) return ok([]);
      return ok([row()]);
    },
  };
  const admin = {
    from(table) {
      const filters = new Map();
      let countOnly = false;
      const query = {
        select(_columns, opts) { countOnly = opts?.head === true; return query; },
        eq(key, value) { filters.set(key, value); return query; },
        async single() {
          if (options.failRead && state.rpcCalled) return { data: null, error: { message: "lookup failed" } };
          if (table === "profiles") return ok({ id: userId, login_name: state.loginName, account_status: "active", account_version: 1 });
          return ok({ id: personId, auth_user_id: state.personLink, full_name: "Synthetic Person", version: 1, node_kind: "person", company_key: "mam", position_title: "Tester", is_active: true });
        },
        async maybeSingle() {
          if (options.failRead) return { data: null, error: { message: "lookup failed" } };
          if (table === "profiles") return options.noProfile ? ok(null) : ok({ id: userId, login_name: state.loginName });
          assert.equal(filters.get("auth_user_id"), userId);
          return ok(state.ownerId ? { id: state.ownerId } : null);
        },
        then(resolve, reject) {
          assert.equal(countOnly, true);
          return Promise.resolve({ data: null, count: 0, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name, args) {
      assert.equal(name, "reserve_portal_account_creation_cleanup");
      assert.equal(args.p_auth_user_id, userId);
      assert.equal(args.p_auth_email, state.user.email);
      state.reservations += 1;
      if (options.linkBeforeReservation) commit();
      if (state.ownerId || state.loginName) return ok(false);
      state.reserved = true;
      if (options.loseReservationResponse) throw new Error("lost reservation response");
      return ok(true);
    },
    auth: { admin: {
      async createUser(args) { state.user = { id: userId, email: args.email }; return ok({ user: state.user }); },
      async getUserById(id) {
        assert.equal(id, userId);
        if (options.failAuthRead) return { data: { user: null }, error: { message: "unreachable" } };
        return ok({ user: { ...state.user, ...(options.wrongAuthIdentity ? { email: "other@example.test" } : {}) } });
      },
      async deleteUser(id) {
        assert.equal(state.reserved, true);
        assert.equal(state.ownerId, null);
        state.deletions.push(id);
        if (options.failDelete) return { error: { message: "unreachable" } };
        return ok({ user: null });
      },
    } },
  };
  return { ...loadAccountActions(admin, client), state, commit };
}

for (const failure of [{ error: { message: "gateway timeout" } }, { throwSave: true }, { malformed: true }]) {
  test("a committed account survives an ambiguous response: " + Object.keys(failure)[0], async () => {
    const { createPortalAccount, state } = fixture(failure);
    const result = await createPortalAccount(input);
    assert.equal(result.account.userId, userId);
    assert.equal(result.oneTimePassword, input.newPassword);
    assert.deepEqual(state.deletions, []);
    assert.equal(state.reservations, 0);
  });
}

test("an ambiguous rollback read-back remains unresolved and preserves a potentially late commit", async () => {
  const { createPortalAccount, state, commit } = fixture({ commit: false, throwSave: true });
  await assert.rejects(createPortalAccount(input), /preserved.*reconciliation/i);
  assert.equal(state.reservations, 0);
  assert.deepEqual(state.deletions, []);
  commit(); // The RPC may have reached the database only after the read-back.
  assert.equal(state.personLink, userId);
});

for (const mode of [{ failRead: true }, { failAuthRead: true }, { otherOwner: true }, { wrongLogin: true }, { wrongAuthIdentity: true }]) {
  test("failed or mismatched exact-identity read-back never deletes: " + Object.keys(mode)[0], async () => {
    const { createPortalAccount, state } = fixture({ ...mode, error: { code: "23505", message: "login_name conflict" } });
    await assert.rejects(createPortalAccount(input), /preserved.*reconciliation/i);
    assert.deepEqual(state.deletions, []);
    assert.equal(state.reservations, 0);
  });
}

test("only a definite database rejection plus a fenced exact orphan permits cleanup", async () => {
  const { createPortalAccount, state } = fixture({ commit: false, error: { code: "23505", message: "login_name conflict" } });
  await assert.rejects(createPortalAccount(input), /already in use/i);
  assert.equal(state.reservations, 1);
  assert.deepEqual(state.deletions, [userId]);
});

test("a link created between read-back and cleanup reservation protects the Auth user", async () => {
  const { createPortalAccount, state } = fixture({ commit: false, linkBeforeReservation: true, error: { code: "40001", message: "version conflict" } });
  await assert.rejects(createPortalAccount(input), /preserved.*reconciliation/i);
  assert.equal(state.ownerId, personId);
  assert.deepEqual(state.deletions, []);
});

for (const mode of [{ loseReservationResponse: true }, { failDelete: true }]) {
  test("ambiguous cleanup retains the reservation for recovery: " + Object.keys(mode)[0], async () => {
    const { createPortalAccount, state } = fixture({ ...mode, commit: false, error: { code: "23505", message: "conflict" } });
    await assert.rejects(createPortalAccount(input), /reconciliation/i);
    assert.equal(state.reserved, true);
    assert.equal(state.reservations, 1);
    assert.equal(state.deletions.length, mode.failDelete ? 1 : 0);
  });
}
