import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/leave-date-range.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
const exports = {};
new Function("exports", outputText)(exports);
const { leaveDateRangeError, MAX_LEAVE_SPAN_DAYS } = exports;

test("leave span is inclusive and accepts at most 366 days, including leap years", () => {
  assert.equal(MAX_LEAVE_SPAN_DAYS, 366);
  for (const [start, end] of [["2028-01-01", "2028-12-31"], ["2026-01-01", "2027-01-01"], ["2026-09-22", "2026-09-22"]]) {
    assert.equal(leaveDateRangeError(start, end), null);
  }
  for (const [start, end] of [["2028-01-01", "2029-01-01"], ["2026-01-01", "2027-01-02"], ["2026-01-01", "9999-12-31"]]) {
    assert.equal(leaveDateRangeError(start, end), "A leave request cannot span more than 366 days.");
  }
});

test("range validation rejects reversed, malformed and normalized impossible dates", () => {
  assert.equal(leaveDateRangeError("2026-09-22", "2026-09-21"), "End date must be on or after start date.");
  for (const date of ["2026-02-29", "2026-04-31", "0000-01-01", "Infinity", "2026-1-01", "", "2026-09-22T00:00:00Z"]) {
    assert.equal(leaveDateRangeError(date, "2026-09-22"), "Choose a valid start date.");
    assert.equal(leaveDateRangeError("2026-09-22", date), "Choose a valid end date.");
  }
});

test("calendar-day validation is independent of daylight saving transitions", () => {
  assert.equal(leaveDateRangeError("2026-10-04", "2027-10-04"), null);
  assert.equal(leaveDateRangeError("2026-10-04", "2027-10-05"), "A leave request cannot span more than 366 days.");
});

function actionHarness(rpcError = null) {
  const calls = [];
  const client = {
    auth: { async getUser() { calls.push("session"); return { data: { user: { id: "synthetic" } }, error: null }; } },
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: [{ id: "10000000-0000-4000-8000-000000000001", status: "Pending" }], error: rpcError };
    },
  };
  const imports = {
    "@/lib/leave-date-range": exports,
    "@/lib/leave-notice": { LEAVE_NOTICE_MESSAGE: "notice" },
    "@/lib/leave-request-balance": {},
    "@/lib/leave-priority": { BALANCE_PENDING_STATUS: "Awaiting balance" },
    "@/lib/supabase/server": { createClient: async () => client },
    "@/lib/supabase/admin": { createAdminClient() { throw new Error("Unexpected admin client"); } },
    "@/lib/leave-notification-outbox": { async dispatchLeaveNotificationsForRequest() { calls.push("notify"); } },
    "next/cache": { revalidatePath() { calls.push("revalidate"); } },
  };
  const actionSource = readFileSync(new URL("../src/app/leave/actions.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(actionSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const actionExports = {};
  new Function("require", "exports", code)((id) => {
    assert.ok(id in imports, `Unexpected import: ${id}`);
    return imports[id];
  }, actionExports);
  return { actions: actionExports, calls };
}

const personId = "20000000-0000-4000-8000-000000000001";
const validInput = { submissionKey: "30000000-0000-4000-8000-000000000001", leaveType: "Unpaid leave", startDate: "2028-01-01", endDate: "2028-12-31" };
const submitters = [
  (actions, input) => actions.submitLeaveRequest(input),
  (actions, input) => actions.submitLeaveRequestForSelectedEmployee(personId, input),
];

test("both Server Actions reject invalid or excessive spans before session, database or notifications", async () => {
  for (const submit of submitters) {
    for (const dates of [{ endDate: "2029-01-01" }, { endDate: "9999-12-31" }, { startDate: "2028-02-30" }, { endDate: "2027-12-31" }]) {
      const { actions, calls } = actionHarness();
      await assert.rejects(submit(actions, { ...validInput, ...dates }), /366 days|valid start date|on or after/);
      assert.deepEqual(calls, []);
    }
  }
});

test("both Server Actions accept 366 days and preserve the idempotent submit RPC", async () => {
  for (const [index, submit] of submitters.entries()) {
    const { actions, calls } = actionHarness();
    assert.equal((await submit(actions, validInput)).status, "Pending");
    assert.equal(calls[1].name, "submit_leave_request_once");
    assert.equal(calls[1].args.p_person_id, index ? personId : null);
    assert.equal(calls[1].args.p_submission_key, validInput.submissionKey);
    assert.deepEqual(calls.slice(2), ["notify", "revalidate"]);
  }
});

test("database span rejection remains a useful user error and never sends notification", async () => {
  const message = "A leave request cannot span more than 366 days.";
  const { actions, calls } = actionHarness({ message });
  assert.deepEqual(await actions.submitLeaveRequest(validInput), { error: message });
  assert.equal(calls.length, 2);
});
