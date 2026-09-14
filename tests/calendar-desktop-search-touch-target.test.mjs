import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync("src/components/team-calendar.module.css", "utf8");

test("desktop calendar search clear has a complete pointer target", () => {
  assert.match(
    styles,
    /\.calendarFrame :global\(\.df-search-group-clear\) \{[^}]*min-height: 28px;[^}]*min-width: 28px;[^}]*\}/,
  );
});
