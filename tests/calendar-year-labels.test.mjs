import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync("src/components/team-calendar.module.css", "utf8");

test("Month view overlay removal preserves Year view month labels", () => {
  assert.match(
    styles,
    /:global\(\.df-month-week > \.df-month-title\)\s*\{[^}]*display:\s*none\s*!important;/,
  );
  assert.doesNotMatch(
    styles,
    /:global\(\.df-year-(?:grid-month-title|fixed-month-label)\)\s*\{[^}]*display:\s*none/,
  );
});
