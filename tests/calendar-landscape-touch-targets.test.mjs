import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/team-calendar.module.css", "utf8");

test("short-screen landscape calendar controls retain full touch targets", () => {
  const landscapeOverride = source.indexOf("/* Short-screen phone calendars retain full controls");

  assert.notEqual(landscapeOverride, -1);
  assert.match(
    source.slice(landscapeOverride),
    /@media \(max-width: 1000px\) and \(max-height: 500px\)[\s\S]*?\.calendarFrame :global\(button\),[\s\S]*?\.calendarFrame :global\(\[role="button"\]\)\s*\{[\s\S]*?min-width: 44px;[\s\S]*?min-height: 44px;[\s\S]*?\.calendarFrame :global\(\.df-search-group-input\)\s*\{\s*min-height: 44px;/,
  );
});
