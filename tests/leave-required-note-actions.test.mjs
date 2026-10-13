import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const actorId = "e4000000-0000-4000-8000-000000000001";
const personId = "e4000000-0000-4000-8000-000000000002";
const requestId = "e4000000-0000-4000-8000-000000000003";
const submissionKey = "e4000000-0000-4000-8000-000000000004";
const compile = file => ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const compiled = compile("src/app/leave/actions.ts");
const dateRange = {};
new Function("exports", compile("src/lib/leave-date-range.ts"))(dateRange);
const message = "Add a leave note before submitting this request.";
function harness({ committed = false, authenticated = true, denied = false } = {}) {
  const calls = [], effects = [];
  const forbidden = () => { throw new Error("Unexpected external effect"); };
  const boundary = {
    auth: { async getUser() { return { data: { user: authenticated ? { id: actorId } : null }, error: null }; } },
    async rpc(name, args) {
      calls.push({ name, args });
      assert.equal(name, "submit_leave_request_once");
      if (denied) return { data: null, error: { code: "42501", message: "Synthetic private denial" } };
      if (!committed && !args.p_employee_note?.trim()) return { data: null, error: { code: "22023", message } };
      return { data: [{ id: requestId, status: "Pending", approval_required: true, assigned_reviewer_label: "Synthetic manager" }], error: null };
    },
  };
  const imports = {
    "@/lib/leave-notice": { LEAVE_NOTICE_MESSAGE: "Synthetic notice" }, "@/lib/leave-date-range": dateRange,
    "@/lib/leave-request-balance": {}, "@/lib/leave-notification-outbox": { dispatchLeaveNotificationsForRequest: forbidden },
    "next/cache": { revalidatePath: () => effects.push("revalidated") }, "next/server": { after: () => effects.push("notification scheduled") },
    "@/lib/supabase/admin": { createAdminClient: forbidden }, "@/lib/supabase/server": { createClient: async () => boundary },
    "@/lib/leave-priority": { BALANCE_PENDING_STATUS: "Waiting for balance" },
  };
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)(name => { assert.ok(name in imports, name); return imports[name]; }, mod, mod.exports);
  return { actions: mod.exports, calls, effects };
}
const input = { submissionKey, leaveType: "Sick leave", startDate: "2026-10-12", endDate: "2026-10-12" };
for (const selected of [false, true]) {
  const submit = (fixture, fields) => selected ? fixture.actions.submitLeaveRequestForSelectedEmployee(personId, fields) : fixture.actions.submitLeaveRequest(fields);
  test(`${selected ? "selected" : "self"} required-note denial is safe actionable data and has no notification`, async () => {
    for (const employeeNote of [undefined, null, "", " ", "\t\r\n", "\u00a0\u2003\ufeff"]) {
      const fixture = harness();
      assert.deepEqual(await submit(fixture, { ...input, employeeNote }), { error: message });
      assert.equal(fixture.calls.length, 1);
      assert.deepEqual(fixture.effects, []);
    }
  });
  test(`${selected ? "selected" : "self"} nonblank notes trim and keep the 2000-character limit`, async () => {
    const fixture = harness();
    assert.equal((await submit(fixture, { ...input, employeeNote: "  Synthetic note\n<&>  " })).id, requestId);
    assert.equal(fixture.calls[0].args.p_employee_note, "Synthetic note\n<&>");
    assert.equal(fixture.calls[0].args.p_person_id, selected ? personId : null);
    assert.equal((await submit(harness(), { ...input, employeeNote: "x".repeat(2000) })).id, requestId);
    const tooLong = harness();
    await assert.rejects(submit(tooLong, { ...input, employeeNote: "x".repeat(2001) }), /2,000 characters/);
    assert.deepEqual(tooLong.calls, []);
  });
  test(`${selected ? "selected" : "self"} committed legacy blank receipt can reconcile through the same idempotent RPC`, async () => {
    const fixture = harness({ committed: true });
    assert.equal((await submit(fixture, input)).id, requestId);
    assert.equal(fixture.calls[0].args.p_submission_key, submissionKey);
    assert.equal(fixture.calls[0].args.p_employee_note, null);
  });
  test(`${selected ? "selected" : "self"} preserves session and authorization checks`, async () => {
    const fields = { ...input, employeeNote: "Synthetic note" };
    const expired = harness({ authenticated: false });
    await assert.rejects(submit(expired, fields), /session has expired/);
    assert.deepEqual(expired.calls, []);
    const denied = harness({ denied: true });
    assert.deepEqual(await submit(denied, fields), { error: "The leave request could not be saved. Refresh and try again." });
    assert.deepEqual(denied.effects, []);
  });
}
