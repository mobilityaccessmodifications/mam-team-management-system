import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const teamModule = { exports: {} };
new Function('exports', ts.transpileModule(readFileSync('src/lib/employee-teams.ts','utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(teamModule.exports);

const personId = "10000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000002";
const actorId = "10000000-0000-4000-8000-000000000003";
const changeToken = "10000000-0000-4000-8000-000000000004";

function loadArchiveAction({ archiveOutcome, failInspection = false, providerTimeout = false, failFinalise = false }) {
  const state = {
    personActive: true,
    accountStatus: "active",
    accountVersion: 1,
    banned: false,
    claimStatus: null,
    providerUpdates: 0,
    providerStatus: "not_started",
    archiveCalls: 0,
  };

  const admin = {
    from(table) {
      let selected = "";
      const query = {
        select(columns) { selected = columns; return query; },
        eq() { return query; },
        async maybeSingle() {
          if (failInspection && selected === "is_active") {
            return { data: null, error: { message: "transport failure" } };
          }
          if (table === "internal_org_people" && selected === "auth_user_id,is_active") {
            return { data: { auth_user_id: userId, is_active: state.personActive }, error: null };
          }
          if (table === "internal_org_people" && selected === "is_active") {
            return { data: { is_active: state.personActive }, error: null };
          }
          if (table === "profiles") {
            return {
              data: { account_status: state.accountStatus, account_version: state.accountVersion },
              error: null,
            };
          }
          throw new Error(`Unexpected admin query ${table}:${selected}`);
        },
      };
      return query;
    },
    auth: { admin: {
      async getUserById() {
        return { data: { user: { banned_until: null } }, error: null };
      },
      async updateUserById(_id, input) {
        state.providerUpdates += 1;
        state.banned = input.ban_duration !== "none";
        if (providerTimeout) throw new Error("provider response lost");
        return { data: { user: { id: userId } }, error: null };
      },
    } },
    async rpc(name, args) {
      if (name === "claim_portal_account_status_execution") {
        if (state.providerStatus !== "not_started") return { data: state.providerStatus, error: null };
        state.providerStatus = "executing";
        return { data: "execute", error: null };
      }
      if (name === "record_portal_account_status_execution") {
        state.providerStatus = args.p_succeeded ? "succeeded" : "unknown";
        return { data: true, error: null };
      }
      throw new Error(`Unexpected admin RPC ${name}`);
    },
  };

  const supabase = {
    auth: { getUser: async () => ({ data: { user: { id: actorId } }, error: null }) },
    async rpc(name) {
      if (name === "begin_portal_account_status_change") {
        state.claimStatus = "pending";
        return {
          data: [{
            account_status: state.accountStatus,
            account_version: state.accountVersion,
            change_token: changeToken,
          }],
          error: null,
        };
      }
      if (name === "archive_employee_directory_record") {
        state.archiveCalls += 1;
        if (archiveOutcome === "rejected") return { data: null, error: { message: "Record the return of this employee's active IT devices" } };
        if (archiveOutcome === "committed") {
          state.personActive = false;
          state.accountStatus = "disabled";
          state.accountVersion += 1;
        }
        throw new Error("response connection closed");
      }
      if (name === "finalise_portal_account_status_change") {
        if (failFinalise && state.archiveCalls === 1 && !state.retrying) throw new Error("database unavailable");
        state.claimStatus = "finalised";
        return { data: [{ person_id: personId, auth_user_id: userId, account_status: state.accountStatus }], error: null };
      }
      if (name === "inspect_portal_account_status_change" || name === "inspect_portal_account_status_request") {
        return { data: [{ person_id: personId, auth_user_id: userId, change_token: changeToken, claim_status: state.claimStatus, provider_status: state.providerStatus }], error: null };
      }
      if (name === "cancel_portal_account_status_change") {
        state.claimStatus = "cancelled";
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  };

  const helper = { exports: {} };
  const helperSource = ts.transpileModule(readFileSync("src/lib/portal-account-status.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "module", "exports", helperSource)(
    (id) => id === "server-only" ? {} : require(id), helper, helper.exports,
  );

  const source = ts.transpileModule(
    readFileSync("src/app/people/actions.ts", "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const moduleUnderTest = { exports: {} };
  new Function("require", "module", "exports", source)(
    (id) => {
      if (id === "next/cache") return { revalidatePath() {} };
      if (id === "@/lib/supabase/admin") return { createAdminClient: () => admin };
      if (id === "@/lib/employee-teams") return teamModule.exports;
      if (id === "@/lib/portal-account-status") return helper.exports;
      if (id === "@/lib/employee-directory") {
        return {
          requireEmployeeDirectoryManager: async () => ({ supabase, actorUserId: actorId }),
          findEmployeeDirectoryRecord: async () => ({ id: personId }),
          listEmployeeDirectoryRecordsForManager: async () => [],
        };
      }
      if (id === "@/lib/organisation-directory") {
        return { getOrganisationPersonWorkEmailForMember: async () => null };
      }
      return require(id);
    },
    moduleUnderTest,
    moduleUnderTest.exports,
  );
  return { archiveEmployeeDirectoryRecord: moduleUnderTest.exports.archiveEmployeeDirectoryRecord, state };
}

const archiveInput = {
  personId,
  personVersion: 1,
  detailVersion: 1,
  endDate: "2026-09-16",
  reason: "Resigned",
};

test("an archive response failure does not restore Auth after the database committed", async () => {
  const { archiveEmployeeDirectoryRecord, state } = loadArchiveAction({ archiveOutcome: "committed" });

  const result = await archiveEmployeeDirectoryRecord(archiveInput);

  assert.equal(result.ok, true);
  assert.equal(state.personActive, false);
  assert.equal(state.accountStatus, "disabled");
  assert.equal(state.banned, true);
  assert.equal(state.claimStatus, "finalised");
  assert.equal(state.providerUpdates, 1);
});

test("an archive rollback retains the provider receipt and never compensates Auth", async () => {
  const { archiveEmployeeDirectoryRecord, state } = loadArchiveAction({ archiveOutcome: "rolled_back" });

  const result = await archiveEmployeeDirectoryRecord(archiveInput);

  assert.equal(result.ok, false);
  assert.equal(state.personActive, true);
  assert.equal(state.accountStatus, "active");
  assert.equal(state.banned, true);
  assert.equal(state.claimStatus, "pending");
  assert.equal(state.providerUpdates, 1);
  assert.match(result.message, /pending claim/);
  await archiveEmployeeDirectoryRecord(archiveInput);
  assert.equal(state.providerUpdates, 1, "retry must use the durable receipt, never call Auth again");
  assert.equal(state.archiveCalls, 2);
});

test("an unconfirmed archive response keeps Auth disabled and the claim pending", async () => {
  const { archiveEmployeeDirectoryRecord, state } = loadArchiveAction({
    archiveOutcome: "rolled_back",
    failInspection: true,
  });

  const result = await archiveEmployeeDirectoryRecord(archiveInput);

  assert.equal(result.ok, false);
  assert.match(result.message, /remains disabled/i);
  assert.equal(state.banned, true);
  assert.equal(state.claimStatus, "pending");
  assert.equal(state.providerUpdates, 1);
});

test("an ambiguous provider response blocks archive and cannot replay or compensate", async () => {
  const { archiveEmployeeDirectoryRecord, state } = loadArchiveAction({ archiveOutcome: "committed", providerTimeout: true });
  assert.equal((await archiveEmployeeDirectoryRecord(archiveInput)).ok, false);
  assert.equal((await archiveEmployeeDirectoryRecord(archiveInput)).ok, false);
  assert.equal(state.providerUpdates, 1);
  assert.equal(state.archiveCalls, 0);
  assert.equal(state.claimStatus, "pending");
  assert.equal(state.providerStatus, "unknown");
});

test("a definite archive rejection explains the retained disable and pending claim", async () => {
  const { archiveEmployeeDirectoryRecord, state } = loadArchiveAction({ archiveOutcome: "rejected" });
  const result = await archiveEmployeeDirectoryRecord(archiveInput);
  assert.equal(result.ok, false);
  assert.match(result.message, /hardware return date/);
  assert.match(result.message, /remains disabled with a pending claim/);
  assert.equal(state.providerUpdates, 1);
  assert.equal(state.claimStatus, "pending");
});

test("an already archived retry only finalises its confirmed claim, without Auth or archive replay", async () => {
  const { archiveEmployeeDirectoryRecord, state } = loadArchiveAction({ archiveOutcome: "committed", failFinalise: true });
  assert.equal((await archiveEmployeeDirectoryRecord(archiveInput)).ok, false);
  assert.equal(state.personActive, false);
  assert.equal(state.claimStatus, "pending");
  state.retrying = true;
  assert.equal((await archiveEmployeeDirectoryRecord(archiveInput)).ok, true);
  assert.equal(state.claimStatus, "finalised");
  assert.equal(state.providerUpdates, 1);
  assert.equal(state.archiveCalls, 1);
});
