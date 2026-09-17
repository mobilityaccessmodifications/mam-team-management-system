import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync("src/lib/victorian-public-holidays.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
vm.runInNewContext(compiled, { exports: loaded.exports, module: loaded });
const { getVictorianPublicHolidays } = loaded.exports;
const leavePrioritySource = readFileSync("src/lib/leave-priority.ts", "utf8");
const leavePriorityCompiled = ts.transpileModule(leavePrioritySource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const leavePriority = { exports: {} };
vm.runInNewContext(leavePriorityCompiled, {
  exports: leavePriority.exports,
  module: leavePriority,
});
const { sickEvidenceDeadline } = leavePriority.exports;
const workdayMigration = readFileSync(
  "supabase/migrations/20260917110640_victorian_public_holiday_workdays.sql",
  "utf8",
);

test("returns the complete published 2026 Victorian holiday schedule", () => {
  assert.deepEqual(
    Array.from(getVictorianPublicHolidays([2026]), ({ date, name }) => [date, name]),
    [
      ["2026-01-01", "New Year's Day"],
      ["2026-01-26", "Australia Day"],
      ["2026-03-09", "Labour Day"],
      ["2026-04-03", "Good Friday"],
      ["2026-04-04", "Saturday before Easter Sunday"],
      ["2026-04-05", "Easter Sunday"],
      ["2026-04-06", "Easter Monday"],
      ["2026-04-25", "ANZAC Day"],
      ["2026-06-08", "King's Birthday"],
      ["2026-09-25", "Friday before the AFL Grand Final"],
      ["2026-11-03", "Melbourne Cup"],
      ["2026-12-25", "Christmas Day"],
      ["2026-12-26", "Boxing Day"],
      ["2026-12-28", "Additional Boxing Day public holiday"],
    ],
  );
});

test("includes official substitute holidays without inventing unconfirmed AFL dates", () => {
  const holidays = getVictorianPublicHolidays([2027, 2028]);
  assert.ok(holidays.some(({ date, name }) => date === "2027-12-27" && name.includes("Christmas Day")));
  assert.ok(holidays.some(({ date, name }) => date === "2027-12-28" && name.includes("Boxing Day")));
  assert.ok(holidays.some(({ date, name }) => date === "2028-01-03" && name.includes("New Year's Day")));
  assert.equal(holidays.some(({ name }) => name === "Friday before the AFL Grand Final"), false);
});

test("filters to requested years and the Calendar keeps holidays visible for every profile", () => {
  assert.equal(getVictorianPublicHolidays([2030]).length, 0);
  assert.ok(getVictorianPublicHolidays([2025]).every(({ date }) => date.startsWith("2025-")));

  const calendarSource = readFileSync("src/components/team-calendar.tsx", "utf8");
  assert.match(calendarSource, /getVictorianPublicHolidays\(years\)/);
  assert.match(calendarSource, /if \(item\.id === "public-holiday"\) return true;/);
  assert.match(calendarSource, /detail: "Victorian public holiday"/);
});

test("the sick-evidence form preview skips published Victorian holidays", () => {
  const holidayDates = new Set(
    getVictorianPublicHolidays([2026]).map(({ date }) => date),
  );

  assert.equal(sickEvidenceDeadline("2026-06-05", holidayDates), "2026-06-09");
  assert.equal(sickEvidenceDeadline("2026-12-24", holidayDates), "2026-12-29");
  assert.equal(sickEvidenceDeadline("2026-09-22", holidayDates), "2026-09-28");
});

test("the database workday source matches every published Calendar holiday", () => {
  const databaseDates = Array.from(
    workdayMigration.matchAll(/\('(?<date>20(?:25|26|27|28)-\d{2}-\d{2})',\s*'/g),
    (match) => match.groups.date,
  );
  const calendarDates = Array.from(
    getVictorianPublicHolidays([2025, 2026, 2027, 2028]),
    ({ date }) => date,
  );

  assert.deepEqual(databaseDates, calendarDates);
  assert.equal(new Set(databaseDates).size, databaseDates.length);
});

test("all generated work and reminder streams use the Victorian business-day policy", () => {
  assert.match(workdayMigration, /create or replace function private\.employee_check_in_next_business_day/);
  assert.match(workdayMigration, /set next_review_on = private\.next_victorian_business_day/);
  assert.match(workdayMigration, /'dueOn', private\.next_victorian_business_day/);
  assert.match(workdayMigration, /create or replace function public\.claim_due_payroll_balance_email_reminders/);
  assert.match(workdayMigration, /create or replace function public\.claim_leave_priority_reminders/);
  assert.match(workdayMigration, /where private\.is_victorian_business_day\(d::date\)/);
  assert.match(workdayMigration, /create or replace function private\.birthday_reminder_date/);
  assert.match(workdayMigration, /create or replace function private\.set_leave_submission_details/);
  assert.match(workdayMigration, /create temporary table victorian_workday_legacy_check_in_schedule/);
  assert.match(workdayMigration, /start-date-correction review/);
});
