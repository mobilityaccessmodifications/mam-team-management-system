import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { loadModule } from './helpers/unified-role-harness.mjs';

const require = createRequire(import.meta.url);
const ts = require("typescript");
const teamModule = { exports: {} };
new Function('exports', ts.transpileModule(readFileSync('src/lib/employee-teams.ts','utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(teamModule.exports);

const personId = "10000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000002";
const actorId = "10000000-0000-4000-8000-000000000003";
const changeToken = "10000000-0000-4000-8000-000000000004";

function loadArchiveAction({ archiveOutcome, failInspection = false, providerTimeout = false, failFinalise = false, reports = [], reportReadError = null, reportReadThrows = false, malformedReportData = false, preflightData = true, linkedUserId = userId, existingDisable = false, authError = null }) {
  const state = {
    personActive: true,
    accountStatus: "active",
    accountVersion: 1,
    banned: existingDisable,
    claimStatus: existingDisable ? "pending" : null,
    providerUpdates: 0,
    providerReads: 0,
    providerStatus: existingDisable ? "succeeded" : "not_started",
    archiveCalls: 0,
    scheduleCalls: 0,
    reportReads: [],
    preflightCalls: [],
    adminReads: [],
  };

  const admin = {
    from(table) {
      state.adminReads.push(table);
      let selected = "";
      const filters = [];
      const query = {
        select(columns) { selected = columns; return query; },
        eq(column, value) { filters.push([column, value]); return query; },
        async limit(count) {
          assert.equal(table, "internal_org_people");
          assert.equal(selected, "id");
          state.reportReads.push({ filters, count });
          if (reportReadThrows) throw new Error("private synthetic reporting query details");
          return {
            data: reportReadError || malformedReportData ? null : reports.filter(row => filters.every(([column, value]) => row[column] === value)).slice(0, count).map(row => ({ id: row.id })),
            error: reportReadError,
          };
        },
        async maybeSingle() {
          if (failInspection && selected === "is_active") {
            return { data: null, error: { message: "transport failure" } };
          }
          if (table === "internal_org_people" && selected === "auth_user_id,is_active") {
            return { data: { auth_user_id: linkedUserId, is_active: state.personActive }, error: null };
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
        state.providerReads += 1;
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
    async rpc(name, args) {
      if (name === "preflight_employee_removal_reporting_splice") {
        state.preflightCalls.push(args);
        if (reportReadThrows) throw new Error("private synthetic reporting query details");
        return {
          data: reportReadError ? null : malformedReportData ? { allowed: true } : preflightData,
          error: reportReadError,
        };
      }
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
      if (name === "schedule_employee_offboarding") {
        state.scheduleCalls += 1;
        return { data: personId, error: null };
      }
      if (name === "archive_employee_directory_record") {
        state.archiveCalls += 1;
        if (archiveOutcome === "direct_reports") {
          return { data: null, error: { code: "23503", message: "Move or archive this employee's active direct reports first." } };
        }
        if (archiveOutcome === "reporting_protected") {
          return { data: null, error: { code: "55000", message: "Onboarding credential delivery in progress" } };
        }
        if (archiveOutcome === "rejected") return { data: null, error: { message: "Record the return of this employee's active IT devices" } };
        if (archiveOutcome === "committed") {
          state.personActive = false;
          if (linkedUserId) {
            state.accountStatus = "disabled";
            state.accountVersion += 1;
          }
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
      if (id === '@/lib/portal-role-capabilities') return loadModule('src/lib/portal-role-capabilities.ts');
      if (id === '@/lib/portal-role-access') return loadModule('src/lib/portal-role-access.ts', { '@/lib/supabase/server': { createClient: async () => supabase } });
      if (id === "next/cache") return { revalidatePath() {} };
      if (id === "@/app/accounts/actions") return { createPortalAccount: async () => ({}) };
      if (id === "@/lib/supabase/admin") return { createAdminClient: () => admin };
      if (id === "@/lib/employee-teams") return teamModule.exports;
      if (id === "@/lib/portal-account-status") return helper.exports;
      if (id === "@/lib/employee-directory") {
        return {
          requireEmployeeDirectoryManager: async () => {
            if (authError) throw authError;
            return { supabase, actorUserId: actorId };
          },
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

test("shared reporting preflight permits active direct children before account disable", async () => {
  const { archiveEmployeeDirectoryRecord, state } = loadArchiveAction({
    archiveOutcome: "committed",
    reports: [{ id: "10000000-0000-4000-8000-000000000005", parent_id: personId, is_active: true }],
  });
  assert.equal((await archiveEmployeeDirectoryRecord(archiveInput)).ok, true);
  assert.deepEqual(state.preflightCalls, [{
    p_person_id: personId, p_expected_person_version: 1, p_expected_detail_version: 1,
    p_end_date: archiveInput.endDate, p_archive_reason: archiveInput.reason,
  }]);
  assert.deepEqual(state.reportReads, []);
  assert.equal(state.archiveCalls, 1);
  assert.equal(state.providerUpdates, 1);
  assert.equal(state.claimStatus, "finalised");
});

test("protected reporting preflight stops offboarding before a claim or Auth ban", async () => {
  const { archiveEmployeeDirectoryRecord, state } = loadArchiveAction({
    archiveOutcome: "committed",
    reports: [{ id: "10000000-0000-4000-8000-000000000005", parent_id: personId, is_active: true }],
    reportReadError: { code: "55000", message: "Onboarding credential delivery in progress" },
  });
  const result = await archiveEmployeeDirectoryRecord(archiveInput);
  assert.equal(result.ok, false);
  assert.equal(result.message, "Reporting links are protected while onboarding credential delivery is in progress or awaiting administrator review.");
  assert.equal(state.providerUpdates, 0);
  assert.equal(state.providerReads, 0);
  assert.equal(state.archiveCalls, 0);
  assert.equal(state.claimStatus, null);
  assert.equal(state.banned, false);
  assert.equal(state.personActive, true);
  assert.equal(state.accountStatus, "active");
  assert.deepEqual(state.reportReads, []);
  assert.equal(state.preflightCalls.length, 1);
  assert.deepEqual(state.adminReads, ["internal_org_people"]);
});

test("a protected report added after preflight keeps the confirmed ban and shows the blocker", async () => {
  const { archiveEmployeeDirectoryRecord, state } = loadArchiveAction({ archiveOutcome: "reporting_protected" });
  const result = await archiveEmployeeDirectoryRecord(archiveInput);
  assert.equal(result.ok, false);
  assert.match(result.message, /Reporting links are protected/);
  assert.match(result.message, /remains disabled with a pending claim/);
  assert.equal(state.providerUpdates, 1);
  assert.equal(state.archiveCalls, 1);
  assert.equal(state.claimStatus, "pending");
  assert.equal(state.providerStatus, "succeeded");
  assert.equal(state.banned, true);
  assert.equal(state.personActive, true);
});

for (const [code, expected] of [
  ["40001", "This record has changed. Refresh it, then try again."],
  ["42501", "You do not have permission to reconnect this employee's reporting links."],
]) test(`reporting preflight ${code} is actionable before Auth`, async () => {
  const { archiveEmployeeDirectoryRecord, state } = loadArchiveAction({ archiveOutcome: "committed", reportReadError: { code, message: "private synthetic database details" } });
  assert.deepEqual(await archiveEmployeeDirectoryRecord(archiveInput), { ok: false, message: expected });
  assert.equal(state.providerReads, 0);
  assert.equal(state.providerUpdates, 0);
  assert.equal(state.archiveCalls, 0);
  assert.equal(state.claimStatus, null);
});

for (const preflightData of [false, null, "true", [], [true], { allowed: true }]) {
  test(`reporting preflight rejects non-boolean approval ${JSON.stringify(preflightData)}`, async () => {
    const { archiveEmployeeDirectoryRecord, state } = loadArchiveAction({ archiveOutcome: "committed", preflightData });
    assert.deepEqual(await archiveEmployeeDirectoryRecord(archiveInput), { ok: false, message: "The employee's reporting links could not be checked. Refresh and try again." });
    assert.equal(state.providerReads, 0);
    assert.equal(state.providerUpdates, 0);
    assert.equal(state.archiveCalls, 0);
    assert.equal(state.claimStatus, null);
  });
}

test("future end date schedules offboarding without disabling sign-in", async () => {
  const { archiveEmployeeDirectoryRecord, state } = loadArchiveAction({
    archiveOutcome: "committed",
    reports: [{ id: "10000000-0000-4000-8000-000000000005", parent_id: personId, is_active: true }],
  });
  const result = await archiveEmployeeDirectoryRecord({ ...archiveInput, endDate: "2099-01-09" });
  assert.equal(result.ok, true);
  assert.equal(state.scheduleCalls, 1);
  assert.equal(state.archiveCalls, 0);
  assert.equal(state.providerUpdates, 0);
  assert.equal(state.accountStatus, "active");
  assert.equal(state.personActive, true);
  assert.deepEqual(state.reportReads, []);
  assert.deepEqual(state.preflightCalls, []);
});

for (const [label, options] of [
  ["database error", { reportReadError: { message: "private synthetic database details" } }],
  ["transport error", { reportReadThrows: true }],
  ["malformed response", { malformedReportData: true }],
]) test(`reporting preflight ${label} stops all mutations and sanitizes feedback`, async () => {
  const { archiveEmployeeDirectoryRecord, state } = loadArchiveAction({ archiveOutcome: "committed", ...options });
  const result = await archiveEmployeeDirectoryRecord(archiveInput);
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.message, /private synthetic/);
  assert.equal(state.providerUpdates, 0);
  assert.equal(state.providerReads, 0);
  assert.equal(state.archiveCalls, 0);
  assert.equal(state.claimStatus, null);
  assert.equal(state.banned, false);
});

test("inactive and unrelated reports do not block a valid archive", async () => {
  const { archiveEmployeeDirectoryRecord, state } = loadArchiveAction({
    archiveOutcome: "committed",
    reports: [
      { id: "10000000-0000-4000-8000-000000000005", parent_id: personId, is_active: false },
      { id: "10000000-0000-4000-8000-000000000006", parent_id: actorId, is_active: true },
    ],
  });
  assert.equal((await archiveEmployeeDirectoryRecord(archiveInput)).ok, true);
  assert.equal(state.archiveCalls, 1);
  assert.equal(state.providerUpdates, 1);
  assert.equal(state.claimStatus, "finalised");
});

test("active structural children use the same shared splice preflight", async () => {
  const { archiveEmployeeDirectoryRecord, state } = loadArchiveAction({
    archiveOutcome: "committed",
    reports: [{ id: "10000000-0000-4000-8000-000000000005", parent_id: personId, is_active: true, node_kind: "org_unit" }],
  });
  assert.equal((await archiveEmployeeDirectoryRecord(archiveInput)).ok, true);
  assert.equal(state.preflightCalls.length, 1);
  assert.equal(state.providerUpdates, 1);
  assert.equal(state.archiveCalls, 1);
});

test("blocked retries preserve an existing successful disable receipt without replay", async () => {
  const { archiveEmployeeDirectoryRecord, state } = loadArchiveAction({
    archiveOutcome: "committed", existingDisable: true,
    reports: [{ id: "10000000-0000-4000-8000-000000000005", parent_id: personId, is_active: true }],
    reportReadError: { code: "55000", message: "Onboarding credential delivery in progress" },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.match((await archiveEmployeeDirectoryRecord(archiveInput)).message, /Reporting links are protected/);
  }
  assert.equal(state.providerUpdates, 0);
  assert.equal(state.archiveCalls, 0);
  assert.equal(state.claimStatus, "pending");
  assert.equal(state.providerStatus, "succeeded");
  assert.equal(state.banned, true);
  assert.equal(state.accountStatus, "active");
});

test("an existing disable receipt can complete with direct children without another Auth call", async () => {
  const reports = [{ id: "10000000-0000-4000-8000-000000000005", parent_id: personId, is_active: true }];
  const { archiveEmployeeDirectoryRecord, state } = loadArchiveAction({ archiveOutcome: "committed", existingDisable: true, reports });
  assert.equal((await archiveEmployeeDirectoryRecord(archiveInput)).ok, true);
  assert.equal(state.providerUpdates, 0);
  assert.equal(state.archiveCalls, 1);
  assert.equal(state.claimStatus, "finalised");
  assert.equal(state.banned, true);
  assert.equal(state.personActive, false);
});

test("directory-only employees use the shared splice preflight without an Auth call", async () => {
  const { archiveEmployeeDirectoryRecord, state } = loadArchiveAction({
    archiveOutcome: "committed", linkedUserId: null,
    reports: [{ id: "10000000-0000-4000-8000-000000000005", parent_id: personId, is_active: true }],
  });
  assert.equal((await archiveEmployeeDirectoryRecord(archiveInput)).ok, true);
  assert.equal(state.preflightCalls.length, 1);
  assert.equal(state.providerUpdates, 0);
  assert.equal(state.providerReads, 0);
  assert.equal(state.archiveCalls, 1);
});

test("self-offboarding rejects before reading reports or calling Auth", async () => {
  const { archiveEmployeeDirectoryRecord, state } = loadArchiveAction({ archiveOutcome: "committed", linkedUserId: actorId });
  assert.match((await archiveEmployeeDirectoryRecord(archiveInput)).message, /your own portal account/);
  assert.deepEqual(state.reportReads, []);
  assert.deepEqual(state.preflightCalls, []);
  assert.equal(state.providerUpdates, 0);
});

test("an unauthorized archive never uses privileged reporting reads", async () => {
  const { archiveEmployeeDirectoryRecord, state } = loadArchiveAction({ archiveOutcome: "committed", authError: new Error("private synthetic authorization details") });
  const result = await archiveEmployeeDirectoryRecord(archiveInput);
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.message, /private synthetic/);
  assert.deepEqual(state.adminReads, []);
  assert.equal(state.providerUpdates, 0);
});

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
