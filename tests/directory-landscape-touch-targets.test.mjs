import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/employee-directory.module.css", "utf8");

test("short-screen landscape directory header actions retain touch targets", () => {
  const landscapeOverride = source.indexOf("/* Apply the same target sizing to short-screen phone landscape");

  assert.notEqual(landscapeOverride, -1);
  assert.match(
    source.slice(landscapeOverride),
    /@media \(max-width: 1000px\) and \(max-height: 500px\)[\s\S]*?\.headerActions > \.primaryAction,[\s\S]*?\.headerActions > \.secondaryAction\s*\{[\s\S]*?min-width: 44px;[\s\S]*?min-height: 44px;/,
  );
});
