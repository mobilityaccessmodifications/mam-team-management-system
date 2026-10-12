import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const actorId = "97000000-0000-4000-8000-000000000002";
const personId = "97000000-0000-4000-8000-000000000001";
const requestId = "97000000-0000-4000-8000-000000000003";
const submissionKey = "97000000-0000-4000-8000-000000000004";
function compile(file) {
  return ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const compiled = compile("src/app/leave/actions.ts");
const dateRange = {};
new Function("exports", compile("src/lib/leave-date-range.ts"))(dateRange);

function harness({ denied = false, authenticated = true } = {}) {
  const calls = [];
  const effects = [];
  const boundary = {
    auth: { async getUser() { return { data: { user: authenticated ? { id: actorId } : null }, error: null }; } },
    async rpc(name, args) {
      calls.push({ name, args });
      assert.equal(name, "submit_leave_request_once");
      return denied ? { data: null, error: { code: "42501", message: "Synthetic private eligibility rejection" } }
        : { data: [{ id: requestId, status: "Pending", approval_required: true, assigned_reviewer_label: "Synthetic manager" }], error: null };
    },
  };
  const forbidden = () => { throw new Error("Unexpected external effect"); };
  const imports = {
    "@/lib/leave-notice": { LEAVE_NOTICE_MESSAGE: "Synthetic notice" },
    "@/lib/leave-date-range": dateRange, "@/lib/leave-request-balance": {},
    "@/lib/leave-notification-outbox": { dispatchLeaveNotificationsForRequest: forbidden },
    "next/cache": { revalidatePath: () => effects.push("revalidated") },
    "next/server": { after: () => effects.push("notification scheduled") },
    "@/lib/supabase/admin": { createAdminClient: forbidden },
    "@/lib/supabase/server": { createClient: async () => boundary },
    "@/lib/leave-priority": { BALANCE_PENDING_STATUS: "Waiting for balance" },
  };
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => {
    assert.ok(name in imports, name);
    return imports[name];
  }, mod, mod.exports);
  return { actions: mod.exports, calls, effects };
}
const input = { submissionKey, leaveType: "trade school", startDate: "2026-10-12", endDate: "2026-10-12" };

test("self trade school action passes the exact option to the authenticated database boundary", async () => {
  const fixture = harness();
  const result = await fixture.actions.submitLeaveRequest(input);
  assert.equal(result.status, "Pending");
  assert.deepEqual(fixture.calls, [{ name: "submit_leave_request_once", args: {
    p_submission_key: submissionKey, p_person_id: null, p_request_type_label: "trade school",
    p_start_date: input.startDate, p_end_date: input.endDate, p_start_time: null, p_end_time: null, p_employee_note: null,
  } }]);
  assert.deepEqual(fixture.effects, ["notification scheduled", "revalidated"]);
});

test("selected employee action preserves the target and delegates eligibility to the database", async () => {
  const fixture = harness();
  const result = await fixture.actions.submitLeaveRequestForSelectedEmployee(personId, input);
  assert.equal(result.status, "Pending");
  assert.equal(fixture.calls[0].args.p_person_id, personId);
  assert.equal(fixture.calls[0].args.p_request_type_label, "trade school");
});

for (const selected of [false, true]) {
  test(`${selected ? "selected" : "self"} action schedules no notification after database eligibility denial`, async () => {
    const fixture = harness({ denied: true });
    const result = selected ? await fixture.actions.submitLeaveRequestForSelectedEmployee(personId, input)
      : await fixture.actions.submitLeaveRequest(input);
    assert.deepEqual(result, { error: "The leave request could not be saved. Refresh and try again." });
    assert.equal(fixture.calls.length, 1);
    assert.deepEqual(fixture.effects, []);
  });

  test(`${selected ? "selected" : "self"} action rejects an expired session before submission`, async () => {
    const fixture = harness({ authenticated: false });
    await assert.rejects(selected ? fixture.actions.submitLeaveRequestForSelectedEmployee(personId, input)
      : fixture.actions.submitLeaveRequest(input), { message: "Your session has expired. Sign in again." });
    assert.deepEqual(fixture.calls, []);
    assert.deepEqual(fixture.effects, []);
  });
}
