import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = fs.readFileSync("src/app/leave/actions.ts", "utf8");
const ast = ts.createSourceFile("actions.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const requiredConstants = new Set([
  "DATE_PATTERN",
  "TIME_PATTERN",
  "UUID_PATTERN",
  "LOAD_ERROR",
]);
const requiredFunctions = new Set([
  "requireText",
  "optionalText",
  "requiredUuid",
  "requiredDate",
  "optionalTime",
  "positiveNumber",
  "optionalPositiveNumber",
  "company",
  "status",
  "optionalDbTime",
  "toCalendarEntry",
]);

const snippets = ast.statements.flatMap((statement) => {
  if (ts.isVariableStatement(statement)) {
    const names = statement.declarationList.declarations
      .map((declaration) => ts.isIdentifier(declaration.name) ? declaration.name.text : "")
      .filter(Boolean);
    return names.some((name) => requiredConstants.has(name)) ? [statement.getText(ast)] : [];
  }
  if (ts.isFunctionDeclaration(statement) && statement.name && requiredFunctions.has(statement.name.text)) {
    return [statement.getText(ast)];
  }
  return [];
});

for (const name of [...requiredConstants, ...requiredFunctions]) {
  assert.ok(snippets.some((snippet) => snippet.includes(name)), `missing ${name}`);
}

const compiled = ts.transpileModule(
  `${snippets.join("\n\n")}\nexports.toCalendarEntry = toCalendarEntry;`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const calendarParser = {};
new Function("exports", "BALANCE_PENDING_STATUS", compiled)(
  calendarParser,
  "Approved – pending leave balance",
);

const validCalendarRow = {
  id: "10000000-0000-4000-8000-000000000001",
  person_id: "20000000-0000-4000-8000-000000000001",
  employee_name: "Former Example (archived)",
  team_name: "Synthetic team",
  company_key: "mam",
  leave_type_label: "Approved leave",
  start_date: "2026-08-03",
  end_date: "2026-08-04",
  start_time: null,
  end_time: null,
  business_days: 2,
  hours: 15.2,
  status: "Approved",
};

test("calendar parser accepts the person-scoped RPC contract and preserves archived labels", () => {
  const parsed = calendarParser.toCalendarEntry(validCalendarRow);
  assert.equal(parsed.personId, validCalendarRow.person_id);
  assert.equal(parsed.employee, "Former Example (archived)");
  assert.equal(parsed.leaveType, "Approved leave");
});

test("calendar parser fails closed when an old company-wide RPC row lacks person identity", () => {
  const { person_id: ignored, ...legacyCalendarRow } = validCalendarRow;
  assert.equal(ignored, validCalendarRow.person_id);
  assert.throws(
    () => calendarParser.toCalendarEntry(legacyCalendarRow),
    /Leave records could not be loaded/,
  );
});
