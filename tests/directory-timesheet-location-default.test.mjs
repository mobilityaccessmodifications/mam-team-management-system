import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const moduleShim = { exports: {} };
const source = ts.transpileModule(
  readFileSync("src/lib/employee-timesheet-default.ts", "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } },
).outputText;
new Function("module", "exports", source)(moduleShim, moduleShim.exports);
const { defaultTimesheetEntriesForLocation } = moduleShim.exports;

test("Location prefills the expected timesheet system", () => {
  assert.equal(defaultTimesheetEntriesForLocation("hq"), "deputy");
  assert.equal(defaultTimesheetEntriesForLocation("onsite_trade"), "aroflo");
  assert.equal(defaultTimesheetEntriesForLocation("remote_worker"), "hubstaff");
  assert.equal(defaultTimesheetEntriesForLocation("overseas"), "hubstaff");
  assert.equal(defaultTimesheetEntriesForLocation("hybrid"), "deputy_hubstaff");
  assert.equal(defaultTimesheetEntriesForLocation(""), "");
});

test("Timesheet Entries remains editable and does not control Location", () => {
  const ui = readFileSync("src/components/employee-directory.tsx", "utf8");
  assert.match(ui, /if \(key === "location"\)[\s\S]*?defaultTimesheetEntriesForLocation/);
  assert.doesNotMatch(ui, /if \(key === "timesheetEntries"\)\s*\{/);
  assert.match(ui, /onChange=\{\(event\) => onChange\("timesheetEntries"/);
  assert.doesNotMatch(ui, /disabled=\{\["deputy", "deputy_hubstaff", "hubstaff"\]/);
  const actions = readFileSync("src/app/people/actions.ts", "utf8");
  assert.match(actions, /const p_location = employeeLocation\(value.location\)/);
  assert.doesNotMatch(actions, /p_timesheet_entries === "deputy" \? "hq"/);
});
