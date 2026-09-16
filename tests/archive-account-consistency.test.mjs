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

function loadArchiveAction({ archiveOutcome, failInspection = false }) {
  const state = {
    personActive: true,
    accountStatus: "active",
    accountVersion: 1,
    banned: false,
    claimStatus: null,
    providerUpdates: 0,
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
          if (table === "internal_org_people" && selected === "auth_user_id") {
            return { data: { auth_user_id: userId }, error: null };
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
        return { data: { user: { id: userId } }, error: null };
      },
    } },
  };

  const supabase = {
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
        if (archiveOutcome === "committed") {
          state.personActive = false;
          state.accountStatus = "disabled";
          state.accountVersion += 1;
        }
        throw new Error("response connection closed");
      }
      if (name === "finalise_portal_account_status_change") {
        state.claimStatus = "finalised";
        return { data: [{ account_status: state.accountStatus }], error: null };
      }
      if (name === "cancel_portal_account_status_change") {
        state.claimStatus = "cancelled";
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  };

  const source = ts.transpileModule(
    readFileSync("src/app/people/actions.ts", "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const moduleUnderTest = { exports: {} };
  new Function("require", "module", "exports", source)(
    (id) => {
      if (id === "next/cache") return { revalidatePath() {} };
      if (id === "@/lib/supabase/admin") return { createAdminClient: () => admin };
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

test("an archive response failure restores Auth only after rollback is confirmed", async () => {
  const { archiveEmployeeDirectoryRecord, state } = loadArchiveAction({ archiveOutcome: "rolled_back" });

  const result = await archiveEmployeeDirectoryRecord(archiveInput);

  assert.equal(result.ok, false);
  assert.equal(state.personActive, true);
  assert.equal(state.accountStatus, "active");
  assert.equal(state.banned, false);
  assert.equal(state.claimStatus, "cancelled");
  assert.equal(state.providerUpdates, 2);
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
