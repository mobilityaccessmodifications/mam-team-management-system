import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const personId = "97000000-0000-4000-8000-000000000001";
const actorId = "97000000-0000-4000-8000-000000000002";
const requestId = "97000000-0000-4000-8000-000000000003";
const loadError = "Leave records could not be loaded. Refresh and try again.";
const paidTypes = ["Annual leave", "Sick leave", "Carer's leave", "Unpaid leave"];
const compiled = ts.transpileModule(readFileSync("src/app/leave/actions.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const listRpcs = new Set([
  "list_leave_calendar_entries_with_teams", "list_staff_leave_calendar_entries",
  "list_calendar_birthdays", "list_employee_check_in_calendar_entries",
  "list_subscription_review_calendar_entries", "list_subscription_renewal_calendar_entries", "list_leave_workspace_attachments",
  "list_payroll_balance_reminder_calendar_entries",
  "list_leave_calendar_entries_with_teams_for_preview", "list_staff_leave_calendar_entries_for_preview",
  "list_calendar_birthdays_for_preview", "list_employee_check_in_calendar_entries_for_preview",
  "list_subscription_review_calendar_entries_for_preview", "list_subscription_renewal_calendar_entries_for_preview",
]);
const capabilityRpcs = new Set([
  "can_view_subscription_review_calendar", "can_view_subscription_renewal_calendar", "can_review_leave_workspace",
  "can_view_all_leave_requests", "can_import_payroll_balances",
  "can_view_subscription_review_calendar_for_preview", "can_view_subscription_renewal_calendar_for_preview", "can_import_payroll_balances_for_preview",
]);

function workspace({
  preview = false, company = "mam", employmentType = "overseas",
  paid = employmentType === "full_time" || employmentType === "part_time",
  policyPersonId = personId, policyData, policyError = null,
  tradeSchoolData = [], tradeSchoolError = null,
  priorityData = { people: [], requests: [], pendingBalanceCalendarIds: [] },
  priorityError = null, previewAllowed = true, authenticated = true, coreError = null,
} = {}) {
  const calls = [];
  let authCalls = 0;
  const record = {
    id: requestId, person_id: personId, employee_name: "Synthetic employee", company_key: company,
    leave_type_label: "Unpaid leave", start_date: "2026-10-05", end_date: "2026-10-05",
    start_time: null, end_time: null, business_days: 1, hours: 8, approval_required: true,
    status: "Pending", submitted_at: "2026-10-02T00:00:00Z", assigned_reviewer_label: null,
    can_decide: false, can_cancel: false, can_attach: false, employee_note: null, manager_note: null,
  };
  const client = {
    auth: { async getUser() {
      authCalls++;
      return { data: { user: authenticated ? { id: actorId } : null }, error: null };
    } },
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === "can_change_employee_view") return { data: previewAllowed, error: null };
      if (name === "get_leave_workspace_for_preview") return {
        data: { requests: [record], attachments: [], can_review_leave: false, can_view_all_leave: false, is_truncated: false },
        error: coreError,
      };
      if (name === "list_leave_workspace_requests") return { data: [record], error: coreError };
      if (name === "get_my_leave_entitlement_policy" || name === "get_selected_employee_leave_entitlement_policy") return {
        data: policyData === undefined
          ? [{ person_id: policyPersonId, employment_type: employmentType, has_paid_leave_entitlement: paid }]
          : policyData,
        error: policyError,
      };
      if (name === "get_leave_priority_workspace") return { data: priorityData, error: priorityError };
      if (name === "list_trade_school_leave_entitlements") return { data: tradeSchoolData, error: tradeSchoolError };
      if (capabilityRpcs.has(name)) return { data: false, error: null };
      if (listRpcs.has(name)) return { data: [], error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    },
  };
  const forbidden = () => { throw new Error("Mutation dependency must not execute"); };
  const imports = {
    "@/lib/leave-notice": { LEAVE_NOTICE_MESSAGE: "Synthetic notice" },
    "@/lib/leave-date-range": { leaveDateRangeError: forbidden, MAX_LEAVE_SPAN_DAYS: 366 },
    "@/lib/leave-request-balance": {},
    "@/lib/leave-notification-outbox": { dispatchLeaveNotificationsForRequest: forbidden },
    "next/cache": { revalidatePath: forbidden }, "next/server": { after: forbidden },
    "@/lib/supabase/admin": { createAdminClient: forbidden },
    "@/lib/supabase/server": { createClient: async () => client },
    "@/lib/leave-priority": { BALANCE_PENDING_STATUS: "Waiting for balance" },
  };
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => {
    assert.ok(name in imports, `Unexpected import: ${name}`);
    return imports[name];
  }, mod, mod.exports);
  return {
    load: () => mod.exports.getLeaveWorkspaceData(preview ? personId : undefined),
    calls, authCalls: () => authCalls,
  };
}

function assertRequests(result, company = "mam") {
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].id, requestId);
  assert.equal(result.requests[0].personId, personId);
  assert.equal(result.requests[0].company, company);
  assert.equal(result.requests[0].leaveType, "Unpaid leave");
  assert.equal(result.canReviewLeave, false);
  assert.equal(result.canViewAllLeave, false);
  assert.equal(result.canImportPayrollBalances, false);
}

async function assertPolicyDenied(options) {
  const fixture = workspace(options);
  await assert.rejects(fixture.load(), { message: loadError });
  assert.equal(fixture.calls.some(({ name }) => name === "get_leave_priority_workspace"), false);
}

for (const preview of [false, true]) {
  const mode = preview ? "selected-profile preview" : "self";
  for (const company of ["mam", "equipsy"]) {
    test(`${mode}: overseas policy loads ${company} records with Unpaid-only entitlement`, async () => {
      const fixture = workspace({ preview, company });
      const result = await fixture.load();
      assertRequests(result, company);
      assert.equal(result.isProfilePreview, preview);
      assert.equal(result.employmentType, "overseas");
      assert.equal(result.hasPaidLeaveEntitlement, false);
      assert.deepEqual(result.availableLeaveTypes.map(({ value }) => value), ["Unpaid leave"]);
      assert.equal(result.warning, undefined);
      assert.equal(fixture.authCalls(), 2);
      const policyName = preview ? "get_selected_employee_leave_entitlement_policy" : "get_my_leave_entitlement_policy";
      assert.deepEqual(fixture.calls.find(({ name }) => name === policyName), {
        name: policyName, args: preview ? { p_person_id: personId } : undefined,
      });
      assert.equal(fixture.calls.some(({ name }) => name === (preview ? "get_my_leave_entitlement_policy" : "get_selected_employee_leave_entitlement_policy")), false);
      assert.deepEqual(fixture.calls.find(({ name }) => name === "get_leave_priority_workspace").args, {
        p_preview_person_id: preview ? personId : null,
      });
      if (preview) {
        for (const call of fixture.calls.filter(({ name }) => name.endsWith("_for_preview") || name === policyName)) {
          assert.deepEqual(call.args, { p_person_id: personId });
        }
      }
    });
  }

  for (const employmentType of [null, "abn", "casual", "full_time", "part_time"]) {
    test(`${mode}: existing ${employmentType ?? "unclassified"} entitlement is unchanged`, async () => {
      const result = await workspace({ preview, employmentType }).load();
      const paid = employmentType === "full_time" || employmentType === "part_time";
      assertRequests(result);
      assert.equal(result.employmentType, employmentType);
      assert.equal(result.hasPaidLeaveEntitlement, paid);
      assert.deepEqual(result.availableLeaveTypes.map(({ value }) => value), paid ? paidTypes : ["Unpaid leave"]);
    });
  }

  for (const employmentType of [null, "abn", "casual", "full_time", "part_time", "overseas"]) {
    test(`${mode}: incoherent paid entitlement for ${employmentType ?? "unclassified"} fails closed`, async () => {
      await assertPolicyDenied({ preview, employmentType, paid: !(employmentType === "full_time" || employmentType === "part_time") });
    });
  }

  for (const [label, employmentType] of [
    ["unknown", "future_kind"], ["case alias", "Overseas"], ["space alias", "overseas "],
    ["empty", ""], ["missing", undefined], ["number", 7], ["object", {}], ["array", []],
  ]) {
    test(`${mode}: ${label} employment domain fails closed`, async () => {
      await assertPolicyDenied({ preview, policyData: [{ person_id: personId, employment_type: employmentType, has_paid_leave_entitlement: false }] });
    });
  }

  for (const [label, options] of [
    ["missing policy array", { policyData: null }], ["object instead of array", { policyData: {} }],
    ["missing policy row", { policyData: [null] }], ["invalid person ID", { policyPersonId: "not-a-uuid" }],
    ["missing person ID", { policyPersonId: null }], ["non-boolean entitlement", { paid: "false" }],
    ["missing entitlement", { policyData: [{ person_id: personId, employment_type: "overseas" }] }],
    ["policy transport denial", { policyError: { code: "42501", message: "Synthetic private detail" } }],
  ]) {
    test(`${mode}: ${label} fails closed before optional priority`, async () => {
      await assertPolicyDenied({ preview, ...options });
    });
  }

  test(`${mode}: no active policy retains no request entitlement`, async () => {
    const result = await workspace({ preview, policyData: [] }).load();
    assert.equal(result.employmentType, null);
    assert.equal(result.hasPaidLeaveEntitlement, false);
    assert.deepEqual(result.availableLeaveTypes, []);
  });

  for (const [label, options] of [
    ["RPC error", { priorityError: { code: "XX000", message: "Synthetic private detail" } }],
    ["missing payload", { priorityData: null }], ["malformed payload", { priorityData: { people: {} } }],
  ]) {
    test(`${mode}: optional priority ${label} preserves overseas records and Unpaid-only entitlement`, async () => {
      const result = await workspace({ preview, ...options }).load();
      assertRequests(result);
      assert.equal(result.employmentType, "overseas");
      assert.equal(result.hasPaidLeaveEntitlement, false);
      assert.deepEqual(result.availableLeaveTypes.map(({ value }) => value), ["Unpaid leave"]);
      assert.equal(result.priority, undefined);
      assert.equal(result.warning, "Leave balances and team requests are temporarily unavailable.");
    });
  }

  test(`${mode}: required core RPC error still fails closed`, async () => {
    await assertPolicyDenied({ preview, coreError: { code: "42501", message: "Synthetic private detail" } });
  });

  test(`${mode}: missing authenticated session never invokes workspace RPCs`, async () => {
    const fixture = workspace({ preview, authenticated: false });
    await assert.rejects(fixture.load(), { message: "Your session has expired. Sign in again." });
    assert.deepEqual(fixture.calls, []);
  });
}

test("selected-profile preview cannot bypass Change Profile permission", async () => {
  const fixture = workspace({ preview: true, previewAllowed: false });
  await assert.rejects(fixture.load(), { message: "The selected employee leave request could not be saved. Refresh and try again." });
  assert.deepEqual(fixture.calls, [{ name: "can_change_employee_view", args: undefined }]);
});

test("self: trade school appears only for the database-entitled employee", async () => {
  const eligible = await workspace({ employmentType: "full_time", tradeSchoolData: [{ person_id: personId }] }).load();
  assert.deepEqual(eligible.availableLeaveTypes.map(({ value }) => value), [...paidTypes, "trade school"]);
  const other = await workspace({ employmentType: "full_time", tradeSchoolData: [{ person_id: actorId }] }).load();
  assert.deepEqual(other.availableLeaveTypes.map(({ value }) => value), paidTypes);
});

for (const preview of [false, true]) {
  test(`${preview ? "preview" : "self"}: trade school eligibility uses the exact selected scope`, async () => {
    const fixture = workspace({ preview, employmentType: "full_time", tradeSchoolData: [{ person_id: personId }], priorityData: {
      people: [{ personId, paidLeave: true, canSubmit: true }, { personId: actorId, paidLeave: true, canSubmit: true }], requests: [], pendingBalanceCalendarIds: [],
    } });
    const result = await fixture.load();
    assert.deepEqual(result.availableLeaveTypes.map(({ value }) => value), [...paidTypes, "trade school"]);
    assert.deepEqual(result.priority.people.map((person) => person.tradeSchoolEligible), [true, false]);
    assert.equal(Object.hasOwn(result, "leavePolicyPersonId"), false);
    assert.deepEqual(fixture.calls.find(({ name }) => name === "list_trade_school_leave_entitlements"), {
      name: "list_trade_school_leave_entitlements", args: { p_preview_person_id: preview ? personId : null },
    });
  });

  for (const [label, tradeSchoolData, tradeSchoolError] of [
    ["missing", null, null], ["object", {}, null], ["null row", [null], null],
    ["bad ID", [{ person_id: "bad" }], null], ["duplicate", [{ person_id: personId }, { person_id: personId }], null],
    ["mixed invalid rows", [{ person_id: personId }, {}], null],
    ["transport denial", [{ person_id: personId }], { code: "42501", message: "Synthetic private detail" }],
  ]) {
    test(`${preview ? "preview" : "self"}: ${label} trade school entitlement fails closed without altering ordinary leave`, async () => {
      const result = await workspace({ preview, employmentType: "full_time", tradeSchoolData, tradeSchoolError }).load();
      assert.deepEqual(result.availableLeaveTypes.map(({ value }) => value), paidTypes);
    });
  }

  for (const employmentType of [null, "abn", "casual", "overseas"]) {
    test(`${preview ? "preview" : "self"}: trade school flag does not expand ${employmentType ?? "unclassified"} paid eligibility`, async () => {
      const result = await workspace({ preview, employmentType, tradeSchoolData: [{ person_id: personId }] }).load();
      assert.deepEqual(result.availableLeaveTypes.map(({ value }) => value), ["Unpaid leave"]);
    });
  }
}
