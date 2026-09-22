import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
function load(file, imports = {}) {
  const code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const m = { exports: {} };
  new Function("require", "module", "exports", code)((id) => {
    if (id in imports) return imports[id];
    if (id === "react/jsx-runtime" || id === "lucide-react") return require(id);
    throw new Error(`Unexpected import: ${id}`);
  }, m, m.exports);
  return m.exports;
}

test("leave accents use company-scoped tokens and Calendar has a real font fallback", () => {
  const leave = readFileSync("src/components/leave-demo.module.css", "utf8");
  assert.doesNotMatch(leave, /var\(--brand-(?:primary|soft|deep)/);
  for (const name of ["accent", "accent-deep", "accent-soft"]) {
    assert.match(leave, new RegExp(`\\.shell \\{[^}]*--${name}:`));
    assert.match(leave, new RegExp(`\\.shell\\[data-company="equipsy"\\] \\{[^}]*--${name}:`));
  }
  assert.match(leave, /\.attachmentUploadButton:focus-within \{[^}]*outline: 3px solid color-mix\(in srgb, var\(--accent\)/);
  const calendar = readFileSync("src/components/team-calendar.module.css", "utf8");
  assert.match(calendar, /font-family: var\(--font-geist-sans, Arial\), sans-serif;/);
  assert.doesNotMatch(calendar, /var\(--font-body\)/);
});

test("shared leave file validation preserves limits, MIME checks and safe names", () => {
  const { validateLeaveAttachmentFiles: validate, formatFileSize } = load("src/lib/leave-attachments.ts");
  const file = { name: "evidence.pdf", type: "application/pdf", size: 1024 };
  assert.equal(validate([file], 9), "");
  assert.match(validate([file], 10), /up to 10/);
  assert.match(validate([{ ...file, type: "text/html" }]), /not a supported/);
  assert.match(validate([{ ...file, size: 0 }]), /empty/);
  assert.match(validate([{ ...file, size: 5 * 1024 * 1024 + 1 }]), /larger than 5 MB/);
  assert.match(validate([{ ...file, name: "../private.pdf" }]), /unsupported name/);
  assert.equal(formatFileSize(1024), "1 KB");
  assert.equal(formatFileSize(1024 * 1024), "1.0 MB");
});

test("shared time options retain quarter-hour bounds and display labels", () => {
  const { START_TIME_OPTIONS, END_TIME_OPTIONS, TIME_VALUES, formatClockTime } = load("src/lib/leave-request-options.ts");
  assert.equal(START_TIME_OPTIONS.length, 48);
  assert.equal(START_TIME_OPTIONS[0].value, "06:00");
  assert.equal(START_TIME_OPTIONS.at(-1).value, "17:45");
  assert.equal(END_TIME_OPTIONS[0].value, "06:15");
  assert.equal(END_TIME_OPTIONS.at(-1).value, "18:00");
  assert.equal(TIME_VALUES.has("12:07"), false);
  assert.equal(formatClockTime("12:00"), "12:00 pm");
});

test("attachment uploads complete intents, discard failures and continue sequentially", async () => {
  const calls = [];
  const actions = {
    async prepareLeaveRequestAttachmentUpload(input) {
      calls.push(["prepare", input.requestId, input.fileName]);
      if (input.fileName === "denied.pdf") throw new Error("denied");
      return { storagePath: input.fileName, mimeType: input.mimeType };
    },
    async completeLeaveRequestAttachmentUpload({ storagePath }) {
      calls.push(["complete", storagePath]);
      if (storagePath === "registration.pdf") throw new Error("registration failed");
    },
    async discardLeaveRequestAttachmentUpload({ storagePath }) {
      calls.push(["discard", storagePath]);
      throw new Error("cleanup will be retried by retention");
    },
  };
  const { uploadLeaveAttachments } = load("src/components/leave-attachment-upload.ts", { "@/app/leave/actions": actions });
  const client = { storage: { from(bucket) {
    assert.equal(bucket, "leave-evidence");
    return { async upload(path, file, options) {
      assert.deepEqual(options, { cacheControl: "0", contentType: "application/pdf", upsert: false });
      calls.push(["upload", path]);
      return { error: file.name === "storage.pdf" ? new Error("storage failed") : null };
    } };
  } } };
  const files = ["denied.pdf", "storage.pdf", "registration.pdf", "good.pdf"].map(name => ({ name, type: "APPLICATION/PDF", size: 100 }));
  const result = await uploadLeaveAttachments(client, "request-1", files);
  assert.deepEqual(result, { uploaded: 1, failed: ["denied.pdf", "storage.pdf", "registration.pdf"] });
  assert.deepEqual(calls.map(c => c[0]), ["prepare", "prepare", "upload", "discard", "prepare", "upload", "complete", "discard", "prepare", "upload", "complete"]);
  const before = calls.length;
  assert.deepEqual(await uploadLeaveAttachments(null, "request-1", files.slice(-1)), { uploaded: 0, failed: ["good.pdf"] });
  assert.equal(calls.length, before);
});

function ownerHarness(t, reassign) {
  const values = [], refs = [], focusCalls = [];
  let stateIndex = 0, refIndex = 0;
  const fakeReact = {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in values)) values[index] = initial;
      return [values[index], value => { values[index] = value; }];
    },
    useRef(initial) { return refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }); },
    useCallback: callback => callback,
  };
  const { useAssetOwnerChange } = load("src/components/use-asset-owner-change.ts", {
    react: fakeReact,
    "@/app/assets/actions": { reassignItAsset: reassign },
    "@/components/ui/use-dialog-focus": { useDialogFocus: (...args) => focusCalls.push(args) },
  });
  const original = globalThis.FormData;
  globalThis.FormData = class { constructor(form) { this.form = form; } get() { return this.form.personId; } };
  t.after(() => { globalThis.FormData = original; });
  const saved = [], closed = [];
  const fallbackFocusRef = { current: null };
  const TestOwnerWorkflow = () => {
    stateIndex = 0; refIndex = 0;
    return useAssetOwnerChange({ asset: { id: "device-1", version: 7, assignedTo: { personId: "old" } }, assignees: [{ personId: "old" }, { personId: "new" }], onClose: () => closed.push(true), onSaved: asset => saved.push(asset), fallbackFocusRef });
  };
  return { render: TestOwnerWorkflow, saved, closed, focusCalls, fallbackFocusRef, event: personId => ({ preventDefault() {}, currentTarget: { personId } }) };
}

test("shared owner workflow rejects invalid selections and closes unchanged assignments", async t => {
  const requests = [];
  const h = ownerHarness(t, async input => { requests.push(input); });
  const flow = h.render(); let focused = 0;
  flow.assigneeRef.current = { focus() { focused++; } };
  await flow.submit(h.event("outside-scope"));
  assert.equal(focused, 1);
  assert.match(h.render().error, /Choose the employee/);
  assert.equal(requests.length, 0);
  await h.render().submit(h.event("old"));
  assert.equal(h.closed.length, 1);
  assert.equal(requests.length, 0);
  assert.equal(h.focusCalls[0][4], h.fallbackFocusRef);
});

test("shared owner workflow sends the version once and blocks close while saving", async t => {
  const requests = []; let finish;
  const h = ownerHarness(t, input => { requests.push(input); return new Promise(resolve => { finish = resolve; }); });
  const flow = h.render();
  const pending = flow.submit(h.event("new"));
  await flow.submit(h.event("new"));
  flow.closeWhenReady();
  assert.equal(h.render().saving, true);
  assert.equal(h.closed.length, 0);
  assert.deepEqual(requests, [{ assetId: "device-1", assignedPersonId: "new", version: 7 }]);
  finish({ id: "device-1", version: 8 }); await pending;
  assert.deepEqual(h.saved, [{ id: "device-1", version: 8 }]);
  assert.equal(h.render().saving, false);
  h.render().closeWhenReady(); assert.equal(h.closed.length, 1);
});

test("shared owner workflow releases the busy lock after errors and can retry", async t => {
  let attempts = 0;
  const h = ownerHarness(t, async () => { if (++attempts === 1) throw new Error("Version changed. Refresh."); return { id: "device-1" }; });
  await h.render().submit(h.event("new"));
  assert.equal(h.render().saving, false);
  assert.match(h.render().error, /Version changed/);
  await h.render().submit(h.event("new"));
  assert.equal(h.render().error, "");
  assert.equal(h.saved.length, 1);
  for (const file of ["asset-register", "employee-device-assignments"]) {
    const source = readFileSync(`src/components/${file}.tsx`, "utf8");
    assert.match(source, /useAssetOwnerChange\(\{/);
    assert.doesNotMatch(source, /await reassignItAsset\(/);
  }
});

test("chart controls keep zoom limits, read-only permissions and action wiring", () => {
  const { OrganisationChartControls } = load("src/components/organisation-controls.tsx", {
    react: {}, "@/components/organisation-tree.module.css": { default: {} },
  });
  const elements = node => !node || typeof node !== "object" ? [] : Array.isArray(node)
    ? node.flatMap(elements) : [node, ...elements(node.props?.children)];
  let zoom = 0.5; const actions = [];
  const props = { canArrange: false, canUseRelationshipEditor: false, zoom, minZoom: 0.5, maxZoom: 1.35, fullscreen: false, setZoom: update => { zoom = update(zoom); }, fitChart: () => actions.push("fit"), resetView: () => actions.push("reset"), toggleFullscreen: () => actions.push("fullscreen") };
  const buttons = elements(OrganisationChartControls(props)).filter(n => n.type === "button");
  const byLabel = label => buttons.find(n => n.props["aria-label"] === label);
  assert.equal(buttons.length, 5);
  assert.equal(byLabel("Zoom out").props.disabled, true);
  byLabel("Zoom out").props.onClick(); assert.equal(zoom, 0.5);
  byLabel("Zoom in").props.onClick(); assert.equal(zoom, 0.6);
  zoom = 1.35; byLabel("Zoom in").props.onClick(); assert.equal(zoom, 1.35);
  byLabel("Fit chart to screen").props.onClick(); byLabel("Reset chart view").props.onClick(); byLabel("Open full screen").props.onClick();
  assert.deepEqual(actions, ["fit", "reset", "fullscreen"]);
});

test("extracted request dialog keeps dates aligned, team choices scoped and form feedback live", () => {
  const calls = [];
  const { LeaveRequestDialog } = load("src/components/leave-request-dialog.tsx", {
    react: { useRef: value => ({ current: value }), useState: value => [value, () => {}], useEffect() {} },
    "@/app/leave/actions": { previewAnnualLeaveBalance: async () => null },
    "@/components/leave-priority-controls": { LeaveRequestBalance: "balance", SickEvidenceNotice: "evidence" },
    "@/components/ui/modal-backdrop": { ModalBackdrop: "backdrop" },
    "@/components/ui/use-dialog-focus": { useDialogFocus: (...args) => calls.push(["focus", ...args]) },
    "@/lib/leave-attachments": load("src/lib/leave-attachments.ts"),
    "@/lib/leave-request-options": load("src/lib/leave-request-options.ts"),
    "@/lib/leave-request-balance": load("src/lib/leave-request-balance.ts"),
    "@/lib/leave-notice": load("src/lib/leave-notice.ts", { "@/lib/leave-priority": { melbourneToday: () => "2026-09-21" } }),
    "@/lib/leave-priority": { sickEvidenceDeadline: () => "2026-10-12" },
    "@/lib/victorian-public-holidays": { getVictorianPublicHolidays: () => [] },
    "@/components/leave-demo.module.css": { default: {} },
  });
  const elements = node => !node || typeof node !== "object" ? [] : Array.isArray(node)
    ? node.flatMap(elements) : [node, ...elements(node.props?.children)];
  const props = {
    activeProfile: { id: "self", team: "MAM" }, requestForPersonId: "team-1",
    teamRequestPeople: [{ personId: "team-1", name: "Synthetic team member", paidLeave: false }],
    canApplyForLeave: true, formLeaveType: "Unpaid leave", availableLeaveTypes: [],
    formStartDate: "2026-09-17", formEndDate: "2026-09-17", formError: "Previous error", isMutating: false,
    setFormStartDate: value => calls.push(["start", value]), setFormEndDate: value => calls.push(["end", value]),
    setFormError: value => calls.push(["error", value]), changeLeaveRequestPerson: value => calls.push(["person", value]),
    closeLeaveRequestForm() {}, submitRequest() {}, setFormLeaveType() {},
  };
  const nodes = elements(LeaveRequestDialog(props));
  const field = name => nodes.find(n => n.props.name === name);
  assert.equal(calls[0][0], "focus"); assert.equal(calls[0][1], true);
  field("startDate").props.onChange({ target: { value: "2026-10-11" } });
  assert.deepEqual(calls.slice(-2), [["start", "2026-10-11"], ["end", "2026-10-11"]]);
  assert.equal(field("endDate").props.min, props.formStartDate);
  const picker = nodes.find(n => n.type === "select" && n.props["aria-label"] === "Request leave for");
  assert.deepEqual(elements(picker).filter(n => n.type === "option").map(n => n.props.value), ["", "team-1"]);
  assert.deepEqual(elements(field("leaveType")).filter(n => n.type === "option").map(n => n.props.value), ["Unpaid leave"]);
  nodes.find(n => n.type === "form").props.onChange(); assert.deepEqual(calls.at(-1), ["error", ""]);
  const busy = elements(LeaveRequestDialog({ ...props, isMutating: true }));
  assert.ok(busy.find(n => n.props.type === "submit").props.disabled);
  assert.ok(busy.find(n => n.props.name === "attachments").props.disabled);
});

test("Check-in mutations still require authenticated clients and HR authorization", async () => {
  const rpcCalls = []; let signedIn = false, hrAllowed = false;
  const client = {
    auth: { async getUser() { return { data: { user: signedIn ? { id: "synthetic-user" } : null }, error: null }; } },
    async rpc(...args) { rpcCalls.push(args); return { error: null }; },
  };
  const imports = {
    "server-only": {}, "@/lib/supabase/server": { createClient: async () => client },
    "@/lib/employee-directory": { async requireEmployeeDirectoryManager() {
      if (!hrAllowed) throw new Error("HR access denied");
      return { supabase: client };
    } },
  };
  const tasks = load("src/lib/check-in-tasks.ts", imports);
  const register = load("src/lib/check-in-register.ts", imports);
  const id = "00000000-0000-4000-8000-000000000001";
  await assert.rejects(tasks.completeMyEmployeeCheckInTask("invalid"), /invalid/);
  await assert.rejects(tasks.completeMyEmployeeCheckInTask(id), /session has expired/);
  await assert.rejects(register.completeVisibleCheckInReminder(id), /session has expired/);
  await assert.rejects(register.completeCheckInReminderForHr(id), /HR access denied/);
  assert.equal(rpcCalls.length, 0);
  signedIn = true; hrAllowed = true;
  await tasks.completeMyEmployeeCheckInTask(id);
  await register.completeVisibleCheckInReminder(id);
  await register.completeCheckInReminderForHr(id);
  assert.deepEqual(rpcCalls, [
    ["complete_my_employee_check_in_task", { p_reminder_id: id }],
    ["complete_visible_employee_check_in_reminder", { p_reminder_id: id }],
    ["complete_employee_check_in_reminder", { p_reminder_id: id }],
  ]);
});
