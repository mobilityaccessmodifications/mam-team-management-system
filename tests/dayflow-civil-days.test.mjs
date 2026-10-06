import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

process.env.TZ = "Australia/Melbourne";
const source = readFileSync(new URL("../node_modules/@dayflow/core/dist/index.esm.js", import.meta.url), "utf8");
const file = ts.createSourceFile("dayflow.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const wanted = new Set(["Gi", "Ki", "sl", "Ne", "Se", "B", "mamCivilDayIndex"]);
const definitions = [];
for (const statement of file.statements) {
  if (ts.isFunctionDeclaration(statement) && wanted.has(statement.name?.text)) definitions.push(statement.getText(file));
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && wanted.has(declaration.name.text)) definitions.push(`const ${declaration.getText(file)};`);
    }
  }
}
const functions = vm.runInNewContext(`const Vi=new WeakMap,qi=new WeakMap,ll=new WeakMap;${definitions.join("\n")}({Gi,Ki,sl});`, { Date, Map, WeakMap });
const date = (value) => new Date(`${value}T00:00:00`);
const event = (start, end = start, allDay = true) => ({ id: "synthetic-calendar", start: date(start), end: date(end), allDay });
const indexes = (value) => JSON.parse(JSON.stringify(value));

for (const [name, start, day] of [["spring DST", "2026-10-04", "2026-10-06"], ["autumn DST", "2026-04-05", "2026-04-07"], ["ordinary dates", "2026-09-06", "2026-09-08"]]) {
  test(`real DayFlow single-day segmentation uses civil columns over ${name}`, () => {
    const segments = functions.Gi([event(day)], date(start), 7);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].startDayIndex, 2);
    assert.equal(segments[0].endDayIndex, 2);
  });
  test(`real DayFlow week membership uses civil columns over ${name}`, () => {
    const membership = functions.sl(event(day), name, date(start), date(day), 7);
    assert.equal(membership.inWeek, true);
    assert.equal(membership.day, 2);
  });
  test(`real DayFlow multi-day all-day segment uses civil columns over ${name}`, () => {
    const segments = functions.Gi([event(start, day)], date(start), 7);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].startDayIndex, 0);
    assert.equal(segments[0].endDayIndex, 2);
    assert.equal(segments[0].totalDays, 3);
  });
  test(`real DayFlow timed multi-day segment uses civil columns over ${name}`, () => {
    const startDate = date(day);
    startDate.setHours(20);
    const endDate = date(day);
    endDate.setDate(endDate.getDate() + 1);
    endDate.setHours(2);
    const segments = functions.Ki({ id: "synthetic-timed", start: startDate, end: endDate, allDay: false }, date(start), 7);
    assert.deepEqual(indexes(segments).map((row) => row.dayIndex), [2, 3]);
    assert.equal(segments[0].startHour, 20);
    assert.equal(segments[1].endHour, 2);
  });
}

test("real DayFlow clips a spring DST cross-week segment without shifting its end", () => {
  const segments = functions.Gi([event("2026-10-03", "2026-10-07")], date("2026-10-04"), 3);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].startDayIndex, 0);
  assert.equal(segments[0].endDayIndex, 2);
  assert.equal(segments[0].isFirstSegment, false);
  assert.equal(segments[0].isLastSegment, false);
});

test("real DayFlow week membership accepts its runtime timestamp boundaries", () => {
  const membership = functions.sl(event("2026-10-06"), "timestamp-boundary", date("2026-10-04").getTime(), date("2026-10-10").getTime(), 7);
  assert.equal(membership.inWeek, true);
  assert.equal(membership.day, 2);
});
