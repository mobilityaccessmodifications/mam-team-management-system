import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function render({ target = "eligible", eligible, paid = true, leaveType = "trade school", targetPresent = true, selfEligible = false } = { eligible: true }) {
  const calls = [];
  const imports = {
    react: { useRef: (value) => ({ current: value }), useEffect() {}, useState: (value) => [value, () => {}] },
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "fragment" },
    "lucide-react": {}, "@/app/leave/actions": {},
    "@/components/leave-priority-controls": { LeaveRequestBalance: "balance" },
    "@/components/ui/modal-backdrop": { ModalBackdrop: "backdrop" },
    "@/components/ui/use-dialog-focus": { useDialogFocus() {} },
    "@/lib/leave-attachments": {},
    "@/lib/leave-request-options": { START_TIME_OPTIONS: [], END_TIME_OPTIONS: [] },
    "@/lib/leave-priority": { requestedLeaveHours: () => 7.6 },
    "@/lib/victorian-public-holidays": { getVictorianPublicHolidays: () => [] },
    "@/lib/leave-notice": { requiresLeaveNotice: () => false, LEAVE_NOTICE_MESSAGE: "notice" },
    "@/lib/leave-date-range": { leaveDateRangeError: () => null },
    "@/lib/leave-request-balance": { requestedLeaveHours: () => 7.6 },
    "@/components/leave-demo.module.css": { default: {} },
  };
  const mod = { exports: {} };
  const compiled = ts.transpileModule(readFileSync("src/components/leave-request-dialog.tsx", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  new Function("require", "module", "exports", compiled)((id) => {
    assert.ok(id in imports, id);
    return imports[id];
  }, mod, mod.exports);
  const person = { personId: target, name: "Synthetic learner", paidLeave: paid, tradeSchoolEligible: eligible };
  const tree = mod.exports.LeaveRequestDialog({
    activeProfile: { id: "self", team: "Synthetic team" }, requestForPersonId: target,
    teamRequestPeople: targetPresent ? [person] : [], onBehalfOf: true, canApplyForLeave: true,
    leavePriority: { people: [person] }, employmentType: "full_time",
    formLeaveType: leaveType, availableLeaveTypes: [{ value: "Unpaid leave", label: "Unpaid leave" }, ...(selfEligible ? [{ value: "trade school", label: "trade school" }] : [])],
    formStartDate: "2026-10-12", formEndDate: "2026-10-12", formError: "",
    setFormError: (message) => calls.push(message), submitRequest: () => calls.push("submitted"),
  });
  const nodes = (value) => !value || typeof value !== "object" ? [] : Array.isArray(value)
    ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)];
  const all = nodes(tree);
  return { calls, nodes: all, options: nodes(all.find((node) => node.props?.name === "leaveType")).filter((node) => node.type === "option").map((node) => node.props.value) };
}

test("manager form offers trade school for the eligible target", () => {
  assert.deepEqual(render().options, ["Annual leave", "Sick leave", "Carer's leave", "Unpaid leave", "trade school"]);
});

test("form rejects a stale trade school selection after changing to an ineligible target", () => {
  const fixture = render({ target: "other", eligible: false });
  fixture.nodes.find((node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(fixture.calls, ["Choose a valid leave type."]);
});

for (const eligible of [false, undefined, null, "true"]) {
  test(`manager form hides trade school when entitlement is ${String(eligible)}`, () => {
    assert.equal(render({ eligible }).options.includes("trade school"), false);
  });
}

test("trade school flag cannot extend an unpaid-only target", () => {
  assert.deepEqual(render({ paid: false }).options, ["Unpaid leave"]);
});

test("eligible trade school form submits without an annual balance projection", () => {
  const fixture = render();
  fixture.nodes.find((node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(fixture.calls, ["submitted"]);
  assert.equal(fixture.nodes.some((node) => node.type === "balance"), false);
});

test("a missing selected employee cannot inherit the active employee's trade school entitlement", () => {
  const fixture = render({ targetPresent: false, selfEligible: true });
  assert.equal(fixture.options.includes("trade school"), false);
  fixture.nodes.find((node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(fixture.calls, ["Choose a valid leave type."]);
});
