import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const styles = new Proxy({}, { get: (_, key) => String(key) });
const blank = () => null;
const nodes = (value) => !value || typeof value !== "object" ? []
  : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)];
const content = (value) => value == null || typeof value === "boolean" ? ""
  : typeof value !== "object" ? String(value)
  : Array.isArray(value) ? value.map(content).join("") : content(value.props?.children);

function compile(source, overrides = {}, bindings = {}) {
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const loaded = { exports: {} };
  const resolve = (id) => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    if (id === "server-only") return {};
    if (id.endsWith(".css")) return styles;
    if (id.startsWith("@/")) return compile(readFileSync(`src/${id.slice(2)}.tsx`, "utf8"), overrides);
    return require(id);
  };
  new Function("require", "module", "exports", ...Object.keys(bindings), output)(resolve, loaded, loaded.exports, ...Object.values(bindings));
  return loaded.exports;
}

// Execute actual component/function bodies, omitting unrelated app modules.
function selected(file, names, bindings = {}, overrides = {}) {
  const source = readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const statements = ast.statements.filter((statement) =>
    ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text)
    || ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => names.includes(declaration.name.getText(ast))));
  assert.equal(statements.length, names.length);
  return compile(`${statements.map((statement) => statement.getText(ast)).join("\n")}\n${names.map((name) => `exports.${name} = ${name};`).join("\n")}`, overrides, bindings);
}

const priority = compile(readFileSync("src/lib/leave-priority.ts", "utf8"));
const controls = compile(readFileSync("src/components/leave-priority-controls.tsx", "utf8"), {
  "@/app/leave/actions": {}, "@/lib/leave-priority": priority,
  "@/components/leave-accrual-controls": { LeaveAccrualControls: blank, LeaveAccrualNotice: blank },
});
const icons = Object.fromEntries(["CalendarDays", "Clock3", "ClipboardList", "CheckCircle2", "ChevronRight", "XCircle", "Search", "Flag", "Gift", "WalletCards", "FileSpreadsheet", "X"].map((name) => [name, blank]));
const { ApprovalsView, RequestsView } = selected("src/components/leave-demo.tsx", ["ApprovalsView", "RequestsView", "getLeaveRegisterPage", "getLeaveRegisterStatus"], {
  ...icons, ...priority, ...controls, styles, registerToolbar: styles,
  useState: React.useState, useRef: React.useRef, useEffect: React.useEffect, useDialogFocus: blank,
  StatusPill: ({ status }) => React.createElement("span", null, status), PanelHeader: blank,
  AttachmentList: blank, ApprovalCalendar: blank, RequestDetail: blank,
  formatDuration: (request) => request.hours == null ? `${request.days} days` : `${request.hours} hours`,
  formatTimeRange: () => "",
});
const person = { personId: "employee", name: "Synthetic Employee", canViewBalance: true, hours: 8.5077,
  annualPayrollHours: 5, annualApprovedHours: 0, annualAvailableHours: 5, isExample: false, accrualStatus: "current" };
const request = { id: "request", personId: "employee", employee: "Synthetic Employee", initials: "SE", team: "Synthetic team",
  leaveType: "Annual leave", days: 1, fullDayHours: 7.6, dateLabel: "23 Sept 2026", status: priority.BALANCE_PENDING_STATUS };

function approval({ sufficient, personChanges, requestChanges, quantityMetadata = { requiredHours: 7.6 }, status = priority.BALANCE_PENDING_STATUS, missing = false, busy = false, readOnly = false } = {}) {
  const decisions = [];
  const currentRequest = { ...request, ...requestChanges, status };
  const workspace = { people: [{ ...person, ...personChanges }], requests: missing ? [] : [{ id: request.id,
    pendingBalance: status === priority.BALANCE_PENDING_STATUS, ...quantityMetadata, balanceSufficient: sufficient }] };
  const tree = ApprovalsView({ leavePriority: workspace, pending: [currentRequest], selected: currentRequest,
    selectedId: request.id, note: "", calendarRequests: [], calendarCheckIns: [], attachmentsByRequestId: new Map(),
    busy, readOnly, onDecision: (decision) => decisions.push(decision) });
  return { decisions, tree, html: renderToStaticMarkup(tree), button: nodes(tree).find((node) => node.props?.className === "approveButton") };
}

test("F01: accrued coverage enables the same final decision advertised by notice and pill", () => {
  const { html, button, decisions } = approval({ sufficient: true });
  assert.match(html, /Balance sufficient — ready for review/);
  assert.match(html, /data-sufficient="true">Enough balance/);
  assert.equal(button.props.disabled, false);
  assert.equal(content(button), " Approve");
  button.props.onClick();
  assert.deepEqual(decisions, ["Approved"]);
});

test("F01: server commitment/hold changes and cancellation recomputation reach every control", () => {
  // Supplied booleans stand in for refreshed server results; do not duplicate
  // the SQL accrual calculation or claim this is a database integration test.
  for (const sufficient of [true, false, true]) {
    const { html, button } = approval({ sufficient, personChanges: { annualAvailableHours: 100 } });
    assert.equal(button.props.disabled, !sufficient);
    assert.match(html, sufficient ? /ready for review/ : /Waiting for enough leave/);
    assert.match(html, sufficient ? /data-sufficient="true">Enough balance/ : /data-sufficient="false">Not enough balance/);
  }
  const held = approval({ sufficient: false, personChanges: { accrualStatus: "needs_review", annualAvailableHours: 100 } });
  assert.equal(held.button.props.disabled, true);
  for (const options of [{}, { missing: true }]) {
    const current = approval(options);
    assert.equal(current.button.props.disabled, true);
    assert.match(current.html, /data-sufficient="false">Check balance/);
  }
});

test("F01: ordinary pending requests retain the existing conditional approval policy", () => {
  const { button, decisions } = approval({ status: "Pending", sufficient: true });
  assert.equal(button.props.disabled, false);
  assert.equal(content(button), " Approve pending balance");
  button.props.onClick();
  assert.deepEqual(decisions, [priority.BALANCE_PENDING_STATUS]);
});

test("canonical saved weekend and longer ordinary-day quantities determine displayed duration and approval", () => {
  for (const [requiredHours, startDate] of [[6, "2026-10-10"], [12.5, "2026-10-13"]]) {
    const { html, button, decisions } = approval({ status: "Pending", quantityMetadata: { requiredHours },
      requestChanges: { startDate, endDate: startDate }, personChanges: { annualAvailableHours: requiredHours } });
    assert.match(html, new RegExp(`<span>${String(requiredHours).replace(".", "\\.")} hours</span>`));
    assert.doesNotMatch(html, /7\.6 hours/);
    assert.match(html, /data-sufficient="true">Enough balance/);
    assert.equal(button.props.disabled, false);
    assert.equal(content(button), " Approve");
    button.props.onClick();
    assert.deepEqual(decisions, ["Approved"]);
  }
});

test("canonical partial-day quantity replaces stored display hours", () => {
  const { html, button } = approval({ status: "Pending", quantityMetadata: { requiredHours: 5 },
    requestChanges: { hours: 7.5 }, personChanges: { annualAvailableHours: 5 } });
  assert.match(html, /<strong>5 hours<\/strong>/);
  assert.doesNotMatch(html, /7\.5 hours/);
  assert.equal(button.props.disabled, false);
});

test("unknown canonical holiday quantity cannot fall back or approve from a sufficient boolean", () => {
  for (const status of ["Pending", priority.BALANCE_PENDING_STATUS]) {
    const { html, button } = approval({ status, sufficient: true, quantityMetadata: { requiredHours: null },
      requestChanges: { startDate: "2026-09-25", endDate: "2026-09-25", hours: 7.6 },
      personChanges: { annualAvailableHours: 100 } });
    assert.doesNotMatch(html, /7\.6 hours/);
    assert.match(html, /data-sufficient="false">Check balance/);
    assert.equal(button.props.disabled, true);
    assert.equal(content(button), " Check balance");
  }
});

test("canonical funded approval preserves busy, read-only and hidden-balance restrictions", () => {
  for (const restrictions of [{ busy: true }, { readOnly: true }, { personChanges: { canViewBalance: false, annualAvailableHours: 6 } }]) {
    const { button } = approval({ status: "Pending", quantityMetadata: { requiredHours: 6 },
      personChanges: { annualAvailableHours: 6 }, ...restrictions });
    assert.equal(button.props.disabled, true);
  }
});

test("legacy approval payloads use their prior quantity only when canonical metadata is absent", () => {
  const { html, button, decisions } = approval({ status: "Pending", quantityMetadata: {},
    personChanges: { annualAvailableHours: 7.6 } });
  assert.match(html, /<span>7\.6 hours<\/span>/);
  assert.equal(button.props.disabled, false);
  button.props.onClick();
  assert.deepEqual(decisions, ["Approved"]);
});

test("F05: public-holiday-adjusted evidence date does not retain a false Monday label", () => {
  const dueDate = priority.sickEvidenceDeadline("2026-12-24", new Set(["2026-12-28"]));
  assert.equal(dueDate, "2026-12-29");
  const isolated = compile(readFileSync("src/components/leave-priority-controls.tsx", "utf8"), {
    "@/app/leave/actions": {}, "@/lib/leave-priority": { ...priority, melbourneToday: () => "2026-12-24" },
    "@/components/leave-accrual-controls": {},
  });
  const html = renderToStaticMarkup(React.createElement(isolated.SickEvidenceNotice, { dueDate, hasEvidence: false }));
  assert.match(html, /by 29 Dec 2026/);
  assert.doesNotMatch(html, /Monday/);
});

test("U07: leave records render a named list with native, actionable detail buttons", () => {
  for (const canReview of [false, true]) {
    const onSelect = [];
    const props = { profile: { id: "self" }, requests: [request], allRequests: [request], filter: "All", canReview,
      attachmentsByRequestId: new Map(), onSelect: (id) => onSelect.push(id), onFilter: blank };
    const html = renderToStaticMarkup(React.createElement(RequestsView, props));
    assert.match(html, /<ul[^>]*aria-label="Leave requests"/);
    assert.match(html, /<li><button[^>]*type="button"[^>]*aria-label="View leave details for Synthetic Employee: Annual leave, 23 Sept 2026, 1 days, Approved/);
    assert.doesNotMatch(html, /role="(?:table|row)"/);
    // Execute the same rendered list's callback with inert hooks.
    const { RequestsView: render } = selected("src/components/leave-demo.tsx", ["RequestsView", "getLeaveRegisterStatus"], {
      ...icons, ...priority, styles, registerToolbar: styles, getLeaveRegisterPage: selected("src/components/leave-demo.tsx", ["getLeaveRegisterPage"]).getLeaveRegisterPage, useState: (initial) => [typeof initial === "function" ? initial() : initial, blank], useRef: () => ({ current: null }), useEffect: blank, useDialogFocus: blank,
      StatusPill: blank, RequestDetail: blank, formatDuration: () => "1 day",
    });
    const button = nodes(render(props)).find((node) => node.type === "button" && node.props["aria-label"]?.startsWith("View leave details"));
    assert.equal(button.props.role, undefined);
    button.props.onClick();
    assert.deepEqual(onSelect, [request.id]);
  }
});

test("Leave register renders search, sort and a bounded page for every status tab", () => {
  const rows = Array.from({ length: 45 }, (_, index) => ({ ...request, id: `request-${index}`, employee: `Synthetic ${index}` }));
  for (const filter of ["All", "Pending", "Waiting for balance", "Approved", "Declined", "Cancelled"]) {
    const html = renderToStaticMarkup(React.createElement(RequestsView, {
      profile: { id: "self" }, requests: rows, allRequests: rows, filter, canReview: true,
      attachmentsByRequestId: new Map(), onSelect: blank, onFilter: blank,
    }));
    assert.match(html, /aria-label="Search leave requests"/);
    assert.match(html, /aria-label="Sort leave requests"/);
    assert.match(html, /aria-label="Leave request pagination"/);
    assert.match(html, /Page 1 of 3/);
    assert.equal((html.match(/aria-label="View leave details for/g) ?? []).length, 20);
  }
  const selected = rows[25];
  const deepLink = renderToStaticMarkup(React.createElement(RequestsView, {
    profile: { id: "self" }, requests: rows, allRequests: rows, filter: "All", canReview: true,
    selected, attachmentsByRequestId: new Map(), onSelect: blank, onFilter: blank,
  }));
  assert.match(deepLink, /Page 2 of 3/);
  assert.match(deepLink, /View leave details for Synthetic 25/);
  assert.doesNotMatch(deepLink, /View leave details for Synthetic 0:/);
});

test("changing pages never renders another request's actionable details", () => {
  let stateIndex = 0;
  const rows = Array.from({ length: 25 }, (_, index) => ({ ...request, id: `request-${index}`, employee: `Synthetic ${index}` }));
  const { RequestsView: render } = selected("src/components/leave-demo.tsx", ["RequestsView", "getLeaveRegisterPage", "getLeaveRegisterStatus"], {
    ...icons, ...priority, styles, registerToolbar: styles,
    useState: (initial) => [++stateIndex === 4 ? { selectedId: rows[0].id, page: 2 } : typeof initial === "function" ? initial() : initial, blank],
    useRef: () => ({ current: null }), useEffect: blank, useDialogFocus: blank,
    StatusPill: blank, RequestDetail: "actionable-details", formatDuration: () => "1 day",
  });
  const tree = render({ profile: { id: "self" }, requests: rows, allRequests: rows, selected: rows[0],
    filter: "All", canReview: true, attachmentsByRequestId: new Map(), onSelect: blank, onFilter: blank });
  assert.equal(nodes(tree).some((node) => node.type === "actionable-details"), false);
  assert.equal(nodes(tree).some((node) => node.type === "button" && node.props["aria-label"]?.includes("Synthetic 20")), true);
});

const calendar = selected("src/components/team-calendar.tsx", ["leaveColors", "formatDate", "formatDateRange", "formatLeaveDuration", "milestoneLabel", "createMAMEvent", "eventMeta", "buildEvents", "EventDetail", "MobileEventDetail"], {
  ...icons, ...priority, styles, timeZone: "Australia/Melbourne", Temporal: require("temporal-polyfill").Temporal,
  createEvent: (event) => event, createAllDayEvent: (event) => ({ ...event, allDay: true }), getVictorianPublicHolidays: () => [],
  useRef: React.useRef, useDialogFocus: blank, ModalBackdrop: ({ children }) => React.createElement("div", null, children),
});

test("U05: authorised duration survives the event mapper and shared desktop/mobile details", () => {
  for (const [days, hours, startDate, endDate, expected] of [
    [2, undefined, "2026-09-25", "2026-09-28", "2 weekdays"],
    [1, 1, "2026-09-23", "2026-09-23", "1 hour · 1 weekday"],
    [2, 4.25, "2026-09-25", "2026-09-28", "4.25 hours · 2 weekdays"],
    [1, 0.125, "2026-09-23", "2026-09-23", "0.125 hours · 1 weekday"],
  ]) {
    const [event] = calendar.buildEvents([], [], [{ ...request, employee: "Former Synthetic Employee (archived)", leaveType: "Approved leave",
      status: "Approved", days, hours, startDate, endDate, ...(hours == null ? {} : { startTime: "09:00", endTime: "10:00" }) }], [], [], []);
    assert.deepEqual(event.meta.duration, { days, hours });
    const desktop = renderToStaticMarkup(React.createElement(calendar.EventDetail, { event, onClose: blank }));
    const mobile = renderToStaticMarkup(React.createElement(calendar.MobileEventDetail, { draftEvent: event, isOpen: true, onClose: blank }));
    for (const html of [desktop, mobile]) {
      assert.ok(html.includes(`Duration: ${expected}`));
      assert.match(html, /Former Synthetic Employee \(archived\)/);
      assert.match(html, /Approved leave/);
      assert.doesNotMatch(html, /Annual leave|reason|balance/i);
    }
  }
});

test("staff leave cards show the type and status with a distinct calendar colour per leave type", () => {
  for (const [leaveType, color] of [
    ["Annual leave", "annual"], ["Sick leave", "sick"], ["Unpaid leave", "unpaid"], ["Carer's leave", "carer"], ["Other leave", "other"],
  ]) {
    for (const status of ["Approved", "Pending"]) {
      const [event] = calendar.buildEvents([], [], [{ ...request, employee: "Sample Employee", leaveType, status,
        startDate: "2026-09-23", endDate: "2026-09-23", requestedAt: "2026-09-01T12:00:00Z", documentCount: 1,
        approvedBy: status === "Approved" ? "Sample Reviewer" : undefined }], [], [], []);
      assert.equal(event.calendarId, `${color}-${status.toLowerCase()}`);
      assert.match(event.title, new RegExp(leaveType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      if (status === "Pending") assert.match(event.title, /Pending/);
      const html = renderToStaticMarkup(React.createElement(calendar.EventDetail, { event, onClose: blank }));
      assert.match(html, /Type of leave/);
      assert.doesNotMatch(html, /Documents uploaded|\/leave\/attachments\//);
      assert.match(html, /Requested/);
      assert.match(html, /Date of leave/);
      assert.match(html, status === "Pending" ? /Awaiting approval/ : /Sample Reviewer/);
    }
  }
});

test("employee calendar cards and details retain the existing availability-only appearance", () => {
  const [event] = calendar.buildEvents([], [], [{ ...request, employee: "Sample Employee", leaveType: "Approved leave",
    status: "Approved", startDate: "2026-09-23", endDate: "2026-09-23" }], [], [], []);
  assert.equal(event.calendarId, "approved");
  const html = renderToStaticMarkup(React.createElement(calendar.EventDetail, { event, onClose: blank }));
  assert.doesNotMatch(html, /Documents uploaded|Requested|Approved by|Type of leave/);
});

test("staff leave-type filter shows only authorised choices and toggles independently of status", () => {
  const { CalendarFilters } = compile(readFileSync("src/components/calendar-filters.tsx", "utf8"), {
    "@/components/team-calendar.module.css": styles,
    "lucide-react": { ChevronDown: blank, Filter: blank },
  });
  const selected = [];
  const props = { kinds: [{ id: "pending", name: "Pending leave" }], teams: [],
    leaveTypes: ["Sick leave"], hiddenKinds: [], hiddenTeams: [], hiddenLeaveTypes: [],
    onKind: blank, onTeam: blank, onLeaveType: (value) => selected.push(value), onReset: blank };
  const tree = CalendarFilters(props);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /Leave by type/);
  assert.match(html, /Sick leave/);
  assert.doesNotMatch(html, /Annual leave/);
  const checkbox = nodes(nodes(tree).find((node) => node.type === "label" && content(node) === "Sick leave"))
    .find((node) => node.type === "input");
  checkbox.props.onChange();
  assert.deepEqual(selected, ["Sick leave"]);
  assert.doesNotMatch(renderToStaticMarkup(CalendarFilters({ ...props, leaveTypes: [] })), /Leave by type/);
});

function submissionTarget(context) {
  const file = readFileSync("src/components/leave-demo.tsx", "utf8");
  const ast = ts.createSourceFile("leave-demo.tsx", file, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ["leaveRequestTargetPersonId", "leaveRequestOnBehalfOf"].includes(node.name.getText(ast))) declarations.push(`const ${node.getText(ast)};`);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(declarations.length, 2);
  return compile(`${declarations.join("\n")}\nexports.target = { personId: leaveRequestTargetPersonId, onBehalfOf: leaveRequestOnBehalfOf };`, {}, context).target;
}

function submitForm({ onBehalfOf, dateError, start = "2026-09-22", end = start, leaveType = "Unpaid leave" }) {
  const calls = [];
  let hoursCalls = 0;
  const notice = compile(readFileSync("src/lib/leave-notice.ts", "utf8"), { "@/lib/leave-priority": { melbourneToday: () => "2026-09-21" } });
  const balance = compile(readFileSync("src/lib/leave-request-balance.ts", "utf8"));
  const dateRange = compile(readFileSync("src/lib/leave-date-range.ts", "utf8"));
  const dialog = compile(readFileSync("src/components/leave-request-dialog.tsx", "utf8"), {
    react: { ...React, useRef: (v) => ({ current: v }), useState: (v) => [v, blank], useEffect: blank },
    "@/app/leave/actions": {}, "@/components/leave-priority-controls": {}, "@/components/ui/modal-backdrop": { ModalBackdrop: "div" },
    "@/components/ui/use-dialog-focus": { useDialogFocus: blank }, "@/lib/leave-attachments": {},
    "@/lib/leave-request-options": { START_TIME_OPTIONS: [], END_TIME_OPTIONS: [] }, "@/lib/leave-priority": priority,
    "@/lib/victorian-public-holidays": { getVictorianPublicHolidays: () => [] }, "@/lib/leave-notice": notice,
    "@/lib/leave-date-range": { ...dateRange, leaveDateRangeError: (start, end) => { calls.push([start, end]); return dateError ?? dateRange.leaveDateRangeError(start, end); } },
    "@/lib/leave-request-balance": { ...balance, requestedLeaveHours: (...args) => { hoursCalls += 1; return balance.requestedLeaveHours(...args); } },
  });
  const tree = dialog.LeaveRequestDialog({ requestForPersonId: "", onBehalfOf, activeProfile: { id: "employee" },
    teamRequestPeople: [], formLeaveType: leaveType, availableLeaveTypes: [], employmentType: "full_time",
    formStartDate: start, formEndDate: end, formError: "", submitRequest: () => calls.push("submitted"),
    setFormError: (error) => calls.push(error) });
  nodes(tree).find((node) => node.type === "form").props.onSubmit({
    preventDefault: () => calls.push("prevented"),
    currentTarget: { elements: { namedItem: (name) => name === "employeeNote" ? { value: "Synthetic leave note" } : null } },
  });
  return { calls, tree, hoursCalls };
}

test("F04: authorised preview and team targets share one on-behalf mode; self-service still requires notice", () => {
  for (const [currentPersonId, requestedTeamMember, isPreviewingEmployeeAccess, previewProfile, expected] of [
    ["admin", undefined, true, { id: "employee" }, true],
    [undefined, undefined, true, { id: "employee" }, true],
    ["manager", { personId: "employee" }, false, undefined, true],
    ["manager", undefined, false, undefined, false],
    ["employee", undefined, false, undefined, false],
    ["admin", undefined, true, { id: "admin" }, false],
    ["employee", undefined, false, { id: "unapproved-preview" }, false],
  ]) {
    const target = submissionTarget({ currentPersonId, requestedTeamMember, requestForPersonId: requestedTeamMember?.personId ?? "", isPreviewingEmployeeAccess, previewProfile });
    assert.equal(target.onBehalfOf, expected);
    const { calls } = submitForm(target);
    assert.equal(calls.includes("submitted"), expected);
    assert.equal(calls.includes("prevented"), !expected);
  }
  assert.deepEqual(submissionTarget({ currentPersonId: "manager", requestForPersonId: "revoked-person", requestedTeamMember: undefined,
    isPreviewingEmployeeAccess: false, previewProfile: undefined }), { personId: "revoked-person", onBehalfOf: false });
});

test("S02 form wiring: shared span validation runs before notice or submission, including on-behalf", () => {
  const error = "A leave request cannot span more than 366 days.";
  for (const onBehalfOf of [false, true]) {
    const { calls, tree } = submitForm({ onBehalfOf, dateError: error });
    assert.deepEqual(calls, [["2026-09-22", "2026-09-22"], "prevented", error]);
    assert.doesNotMatch(content(tree), /Each request can span up to/);
  }
});

test("S02: real shared validator allows 365/366 inclusive days and blocks larger or invalid ranges before duration calculation", () => {
  for (const [start, end] of [["2027-01-01", "2027-12-31"], ["2028-01-01", "2028-12-31"]]) {
    const { calls, hoursCalls } = submitForm({ onBehalfOf: true, start, end });
    assert.equal(hoursCalls, 1);
    assert.ok(calls.includes("submitted"));
  }
  for (const leaveType of ["Annual leave", "Unpaid leave"]) {
    for (const [start, end, message] of [
      ["2028-01-01", "2029-01-01", "A leave request cannot span more than 366 days."],
      ["2026-09-22", "9999-12-31", "A leave request cannot span more than 366 days."],
      ["2026-02-30", "2026-03-01", "Choose a valid start date."],
      ["2026-09-22", "invalid", "Choose a valid end date."],
    ]) {
      const { calls, hoursCalls } = submitForm({ onBehalfOf: true, start, end, leaveType });
      assert.equal(hoursCalls, 0);
      assert.deepEqual(calls, [[start, end], "prevented", message]);
    }
  }
});
