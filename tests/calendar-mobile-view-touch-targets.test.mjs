import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/team-calendar.module.css", "utf8");

test("mobile calendar view controls retain a 44px minimum width", () => {
  assert.match(
    source,
    /@media \(max-width: 760px\)[\s\S]*?\.calendarFrame :global\(\.df-view-switcher-btn\) \{[^}]*min-width: 44px;[^}]*\}/,
  );
  assert.doesNotMatch(
    source,
    /\.calendarFrame :global\(\.df-view-switcher-btn\) \{[^}]*min-width: 0;/,
  );
});
