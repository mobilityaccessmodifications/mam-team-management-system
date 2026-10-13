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
    "@/components/leave-priority-controls": { LeaveRequestBalance: "balance", SickEvidenceNotice: "evidence" },
    "@/components/ui/modal-backdrop": { ModalBackdrop: "backdrop" },
    "@/components/ui/use-dialog-focus": { useDialogFocus() {} },
    "@/lib/leave-attachments": {},
    "@/lib/leave-request-options": { START_TIME_OPTIONS: [], END_TIME_OPTIONS: [] },
    "@/lib/leave-priority": { requestedLeaveHours: () => 7.6, sickEvidenceDeadline: () => "2026-10-19" },
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
  const noteEffects = [];
  return {
    calls, nodes: all, noteEffects,
    options: nodes(all.find((node) => node.props?.name === "leaveType")).filter((node) => node.type === "option").map((node) => node.props.value),
    submit(note = "Synthetic employee note") {
      const field = note === null ? null : {
        value: note,
        closest: () => ({ setAttribute: (name, value) => noteEffects.push([name, value]) }),
        focus: () => noteEffects.push("focused"),
      };
      all.find((node) => node.type === "form").props.onSubmit({
        preventDefault: () => noteEffects.push("prevented"),
        currentTarget: { elements: { namedItem: (name) => name === "employeeNote" ? field : null } },
      });
    },
  };
}

test("manager form offers trade school for the eligible target", () => {
  assert.deepEqual(render().options, ["Annual leave", "Sick leave", "Carer's leave", "Unpaid leave", "trade school"]);
});

test("the real leave request form opens Note & files by default", () => {
  const fixture = render();
  const extras = fixture.nodes.find((node) => node.type === "details"
    && node.props.children?.[0]?.props.children === "Note & files");
  assert.ok(extras);
  assert.equal(extras.props.open, true);
});

test("form rejects a stale trade school selection after changing to an ineligible target", () => {
  const fixture = render({ target: "other", eligible: false });
  fixture.submit();
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
  fixture.submit();
  assert.deepEqual(fixture.calls, ["submitted"]);
  assert.equal(fixture.nodes.some((node) => node.type === "balance"), false);
});

test("a missing selected employee cannot inherit the active employee's trade school entitlement", () => {
  const fixture = render({ targetPresent: false, selfEligible: true });
  assert.equal(fixture.options.includes("trade school"), false);
  fixture.submit();
  assert.deepEqual(fixture.calls, ["Choose a valid leave type."]);
});

test("the real note control is required and retains the 2000 character limit", () => {
  const note = render().nodes.find((node) => node.props?.name === "employeeNote");
  assert.equal(note.props.required, true);
  assert.equal(note.props.maxLength, 2000);
});

for (const leaveType of ["Unpaid leave", "Sick leave", "Carer's leave", "trade school"]) {
  for (const note of [null, "", " \t\r\n\u00a0 "]) {
    test(`${leaveType} form rejects ${note === null ? "a missing" : note === "" ? "an empty" : "a whitespace-only"} note before submission`, () => {
      const fixture = render({ eligible: true, leaveType });
      fixture.submit(note);
      assert.deepEqual(fixture.calls, ["Add a note before submitting your leave request."]);
      assert.equal(fixture.noteEffects[0], "prevented");
      if (note !== null) assert.deepEqual(fixture.noteEffects.slice(1), [["open", ""], "focused"]);
    });
  }
}

test("direct form dispatch cannot bypass the note length limit", () => {
  const fixture = render();
  fixture.submit("x".repeat(2001));
  assert.deepEqual(fixture.calls, ["Leave note must be 2,000 characters or fewer."]);
  assert.deepEqual(fixture.noteEffects, ["prevented", ["open", ""], "focused"]);
});

test("a normal multiline note can be submitted without changing its text", () => {
  const fixture = render();
  fixture.submit("Synthetic first line\nSynthetic second line");
  assert.deepEqual(fixture.calls, ["submitted"]);
});

test("native invalid-note feedback opens a manually collapsed extras section", () => {
  const fixture = render();
  const note = fixture.nodes.find((node) => node.props?.name === "employeeNote");
  assert.equal(typeof note.props.onInvalid, "function");
  const effects = [];
  note.props.onInvalid({ currentTarget: { closest: () => ({ setAttribute: (name, value) => effects.push([name, value]) }) } });
  assert.deepEqual(effects, [["open", ""]]);
});
