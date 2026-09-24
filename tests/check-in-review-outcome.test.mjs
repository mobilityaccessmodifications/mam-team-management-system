import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function loadTypeScriptModule(path) {
  const source = readFileSync(path, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: () => ({}) });
  return exports;
}

const registerParser = loadTypeScriptModule("src/lib/check-in-register-data.ts");
const workspaceParser = loadTypeScriptModule("src/lib/check-in-workspace-data.ts");
const dialog = readFileSync("src/components/check-in-review-outcome-dialog.tsx", "utf8");
const dialogStyles = readFileSync("src/components/check-in-review-outcome-dialog.module.css", "utf8");
const register = readFileSync("src/components/check-in-register.tsx", "utf8");
const workspace = readFileSync("src/components/check-in-workspace.tsx", "utf8");
const timelineStyles = readFileSync("src/components/check-in-register.module.css", "utf8");

function reminder(overrides = {}) {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    milestone: "3_month",
    sequence: "initial",
    dueDate: "2026-09-20",
    notifyDate: "2026-09-14",
    status: "completed",
    deliveredAt: "2026-09-14T00:00:00Z",
    completedAt: "2026-09-20T00:00:00Z",
    lastDeliveryErrorAt: null,
    needsReviewReason: null,
    reviewOutcome: "follow_up_required",
    reviewDate: "2026-09-20",
    reviewNotes: "Schedule refresher training.",
    reviewVersion: 2,
    reviewRecordedAt: "2026-09-20T02:00:00Z",
    ...overrides,
  };
}

test("register and manager-safe parsers retain structured review outcomes", () => {
  const [registerRecord] = registerParser.parseCheckInRegisterRecords([{
    person_id: "20000000-0000-4000-8000-000000000001",
    company_key: "mam",
    first_name: "Taylor",
    last_name: "Starter",
    role: "Coordinator",
    department: "Operations",
    manager_name: "Morgan Manager",
    address: "",
    date_of_birth: null,
    mobile: "",
    email: "taylor@example.test",
    start_date: "2026-06-20",
    recipient_email: "morgan@example.test",
    recipient_source: "manager_work_email",
    enrolment_mode: "automatic",
    reminders: [reminder()],
  }]);
  assert.equal(registerRecord.reminders[0].reviewOutcome, "follow_up_required");
  assert.equal(registerRecord.reminders[0].reviewVersion, 2);
  assert.equal(registerRecord.reminders[0].reviewNotes, "Schedule refresher training.");

  const [workspaceRecord] = workspaceParser.parseCheckInWorkspaceRecords([{
    person_id: "20000000-0000-4000-8000-000000000001",
    full_name: "Taylor Starter",
    position_title: "Coordinator",
    company_key: "mam",
    start_date: "2026-06-20",
    reminders: [reminder()],
  }]);
  assert.equal(workspaceRecord.reminders[0].reviewOutcome, "follow_up_required");
  assert.equal(workspaceRecord.reminders[0].reviewVersion, 2);
});

test("parsers fail closed on malformed outcome metadata", () => {
  const row = {
    person_id: "20000000-0000-4000-8000-000000000001",
    full_name: "Taylor Starter",
    position_title: "Coordinator",
    company_key: "mam",
    start_date: "2026-06-20",
    reminders: [reminder({ reviewOutcome: "private_code" })],
  };
  assert.throws(() => workspaceParser.parseCheckInWorkspaceRecords([row]), /could not be loaded/i);
  assert.throws(() => workspaceParser.parseCheckInWorkspaceRecords([{ ...row, reminders: [reminder({ reviewVersion: -1 })] }]), /could not be loaded/i);
});

test("completed timeline status opens the shared accessible outcome dialog", () => {
  assert.match(register, /className=\{styles\.reviewOutcomeTrigger\}/);
  assert.match(workspace, /className=\{styles\.reviewOutcomeTrigger\}/);
  assert.match(register, /aria-haspopup="dialog"/);
  assert.match(workspace, /Record outcome/);
  assert.match(dialog, /<ModalBackdrop/);
  assert.match(dialog, /useDialogFocus\(true/);
  assert.match(dialog, /role="dialog" aria-modal="true"/);
  assert.match(dialog, /recordCheckInReview/);
  assert.match(dialog, /expectedVersion: reminder\.reviewVersion/);
  assert.match(dialog, /HR review before decision/);
  assert.match(dialog, /Notifies People & Culture/);
  assert.match(dialog, /readOnly \? null : initialFocusRef/);
  assert.match(dialog, /returnFocusRef/);
  assert.match(register, /reminder\.status !== "claimed"/);
  assert.match(workspace, /reminder\.status !== "claimed"/);
  assert.match(register, /readOnly=\{readOnly\}/);
  assert.match(workspace, /readOnly \? "View"/);
});

test("outcome dialog keeps mobile controls usable", () => {
  assert.match(timelineStyles, /\.reviewOutcomeTrigger \{[^}]*min-height: 44px/s);
  assert.match(dialogStyles, /@media \(max-width: 620px\)[\s\S]*\.backdrop \{ align-items: end;/);
  assert.match(dialogStyles, /\.field input,\.field textarea \{ font-size: 16px; \}/);
  assert.match(dialogStyles, /\.footer button \{ flex: 1; touch-action: manipulation; \}/);
  assert.match(dialogStyles, /overscroll-behavior: contain/);
  assert.match(dialogStyles, /\.header button \{[^}]*width: 44px; height: 44px/s);
});
